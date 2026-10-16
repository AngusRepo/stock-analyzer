"""
cloud_run_jobs_client.py — Thin wrapper for triggering Cloud Run Job executions.

Used by routers/pipeline.py to hand off the long-running daily pipeline LangGraph
to a dedicated Cloud Run Job instead of running it as a fire-and-forget asyncio
task inside the Cloud Run Service. The Service container gets idle-killed after
~15 min; a Job has its own lifecycle and runs to completion.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Mapping

from google.cloud import run_v2

logger = logging.getLogger(__name__)

# GCP project / region / job name are env-driven so staging / prod share code.
_PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "").strip()
_REGION = os.environ.get("GCP_REGION", "").strip()
_JOB_NAME = os.environ.get("PIPELINE_JOB_NAME", "").strip()


@dataclass(frozen=True)
class JobExecution:
    """Identifiers returned after a successful run_job call."""

    execution_name: str  # projects/.../jobs/pipeline-v2/executions/pipeline-v2-xxxxx
    execution_id: str    # Short tail (pipeline-v2-xxxxx)


class JobAlreadyRunningError(RuntimeError):
    """Raised when the target Cloud Run Job already has an active execution."""

    def __init__(self, execution: JobExecution) -> None:
        super().__init__(f"Cloud Run Job already running: {execution.execution_id}")
        self.execution = execution


class CloudRunJobsClient:
    """Trigger Cloud Run Job executions with per-execution env overrides.

    Uses Application Default Credentials — the ml-controller Cloud Run Service
    account must have roles/run.developer (or roles/run.invoker on the specific
    Job) for execute permission.
    """

    def __init__(
        self,
        project_id: str = _PROJECT_ID,
        region: str = _REGION,
        job_name: str = _JOB_NAME,
        require_source_alignment: bool = False,
    ) -> None:
        self._require_source_alignment = require_source_alignment
        self._project_id = project_id.strip()
        self._region = region.strip()
        self._job_name = job_name.strip()
        self._parent = (
            f"projects/{self._project_id}/locations/{self._region}/jobs/{self._job_name}"
            if self._project_id and self._region and self._job_name
            else ""
        )
        # Lazy-init the gRPC client so import-time failures don't crash the API.
        self._client: run_v2.JobsClient | None = None
        self._executions_client: run_v2.ExecutionsClient | None = None

    def _get_client(self) -> run_v2.JobsClient:
        if self._client is None:
            self._client = run_v2.JobsClient()
        return self._client

    def _get_executions_client(self) -> run_v2.ExecutionsClient:
        if self._executions_client is None:
            self._executions_client = run_v2.ExecutionsClient()
        return self._executions_client

    @staticmethod
    def _execution_completed(execution: object) -> bool:
        completion_time = getattr(execution, "completion_time", None)
        if completion_time:
            return True
        conditions = getattr(execution, "conditions", None) or []
        for cond in conditions:
            cond_type = getattr(cond, "type_", None) or getattr(cond, "type", None)
            if cond_type == "Completed" and (
                getattr(cond, "state", None) in {
                    run_v2.Condition.State.CONDITION_FAILED,
                    run_v2.Condition.State.CONDITION_SUCCEEDED,
                } or str(getattr(cond, "status", "")).lower() in {"true", "false"}
            ):
                return True
        return False

    def pipeline_execution_status(self, *, run_date: str, run_id: str, execution_name: str = "", required_env: dict | None = None) -> dict:
        from services.pipeline_execution_status import lookup_execution
        return lookup_execution(self._get_executions_client(), parent=self._parent,
                                run_date=run_date, run_id=run_id, execution_name=execution_name, required_env=required_env)

    def execution_state(self, execution: JobExecution) -> str:
        """Observe one dispatched job; dispatch acceptance is not completion."""
        if not execution.execution_name.startswith(self._parent + "/executions/"):
            raise ValueError("cloud_run_execution_job_mismatch")
        observed = self._get_executions_client().get_execution(
            request=run_v2.GetExecutionRequest(name=execution.execution_name), timeout=30,
        )
        for condition in observed.conditions:
            if condition.type_ != "Completed":
                continue
            if condition.state == run_v2.Condition.State.CONDITION_SUCCEEDED:
                return "succeeded"
            if condition.state == run_v2.Condition.State.CONDITION_FAILED:
                return "failed"
        return "running"

    def get_active_execution(self, *, deadline: float | None = None) -> JobExecution | None:
        """Return the newest in-flight execution for this Job, if any."""
        if not self._parent:
            return None

        request = run_v2.ListExecutionsRequest(parent=self._parent, page_size=100)
        options = {}
        if deadline is not None:
            import time
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('cloud_run_active_lookup_deadline')
            options = {'timeout': min(8.0, remaining), 'retry': None}
        pager = self._get_executions_client().list_executions(request=request, **options)
        for execution in pager:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError('cloud_run_active_lookup_deadline')
            if self._execution_completed(execution):
                continue
            execution_name = getattr(execution, "name", "") or ""
            if not execution_name:
                continue
            execution_id = execution_name.rsplit("/", 1)[-1]
            return JobExecution(execution_name=execution_name, execution_id=execution_id)
        return None

    def run_job(
        self,
        env_overrides: Mapping[str, str] | None = None,
        *,
        reject_if_running: bool = True,
        expected_source_sha: str | None = None,
        deadline_seconds: float | None = None,
    ) -> JobExecution:
        """Start a new execution of the configured Job.

        Args:
            env_overrides: Per-execution env vars merged on top of the Job's
                base template. Typical use: {"PIPELINE_RUN_DATE": "2026-04-17"}.

        Returns:
            JobExecution with the fully-qualified execution name + short id.

        Raises:
            google.api_core.exceptions.GoogleAPICallError on GCP auth / not-found /
            quota errors. Caller should surface these as HTTP 5xx.
        """
        if not self._parent:
            raise RuntimeError(
                "Cloud Run Job config missing. Set GCP_PROJECT_ID, GCP_REGION, and a job name."
            )

        import time
        deadline = time.monotonic() + deadline_seconds if deadline_seconds is not None else None
        if deadline_seconds is not None and deadline_seconds <= 0:
            raise ValueError('cloud_run_dispatch_deadline_invalid')
        if self._require_source_alignment and expected_source_sha is None:
            expected_source_sha = os.environ.get('STOCKVISION_SOURCE_SHA', '').strip()
        if expected_source_sha is not None:
            if deadline is None:
                self.verify_source_alignment(expected_source_sha)
            else:
                self.verify_source_alignment(expected_source_sha, deadline=deadline)

        if reject_if_running:
            active = (self.get_active_execution(deadline=deadline) if deadline is not None
                      else self.get_active_execution())
            if active is not None:
                raise JobAlreadyRunningError(active)

        client = self._get_client()

        overrides: run_v2.RunJobRequest.Overrides | None = None
        if env_overrides:
            container_override = run_v2.RunJobRequest.Overrides.ContainerOverride(
                env=[run_v2.EnvVar(name=k, value=v) for k, v in env_overrides.items()],
            )
            overrides = run_v2.RunJobRequest.Overrides(
                container_overrides=[container_override],
            )

        request = run_v2.RunJobRequest(name=self._parent, overrides=overrides)
        options = {}
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('cloud_run_dispatch_deadline_before_rpc')
            options = {'timeout': min(8.0, remaining), 'retry': None}
        operation = client.run_job(request=request, **options)

        # operation.metadata.name is populated immediately; the long-running
        # operation itself tracks completion. We don't wait — the Job callback
        # to Worker is the completion signal.
        execution_name = operation.metadata.name
        execution_id = execution_name.rsplit("/", 1)[-1]

        logger.info(
            "[CloudRunJobs] Triggered %s execution=%s overrides=%s",
            self._parent,
            execution_id,
            dict(env_overrides or {}),
        )
        return JobExecution(execution_name=execution_name, execution_id=execution_id)

    def verify_source_alignment(self, expected_source_sha: str, *, deadline: float | None = None) -> None:
        """A read-model producer must run the consumer's exact published source.

        Never mask an old image with an execution env override. Inspect the
        immutable job template source declaration before allocating an execution.
        """
        if not re.fullmatch(r'[a-f0-9]{40}', expected_source_sha or ''):
            raise ValueError('strategy_nav_consumer_source_identity_missing')
        options = {'timeout': 30}
        if deadline is not None:
            import time
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('cloud_run_source_lookup_deadline')
            options = {'timeout': min(8.0, remaining), 'retry': None}
        job = self._get_client().get_job(request=run_v2.GetJobRequest(name=self._parent), **options)
        containers = job.template.template.containers
        if len(containers) != 1:
            raise ValueError('strategy_nav_producer_container_contract_invalid')
        declarations = [item.value for item in containers[0].env if item.name == 'STOCKVISION_SOURCE_SHA']
        if declarations != [expected_source_sha]:
            raise ValueError('strategy_nav_producer_consumer_source_mismatch')
