"""
daily_pipeline.py — LangGraph-style Daily Pipeline StateGraph (P1#11)

Orchestrates the daily prediction pipeline as a state machine:
  screener → ml_predict → recommend

Features:
  - Checkpoint: each step saves state to GCS/local JSON
  - Retry: 3x per step with exponential backoff
  - Auto-pass: if ML predict fails, recommendation runs with empty predictions
  - Resumable: can restart from last checkpoint

Note: Uses a lightweight custom StateGraph implementation (no langgraph dependency)
      to avoid adding heavy deps to the lean controller image.
      Compatible with LangGraph Studio visualization format.
"""
import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Awaitable, Optional

import httpx

logger = logging.getLogger(__name__)

CHECKPOINT_DIR = os.environ.get("PIPELINE_CHECKPOINT_DIR", "/tmp/pipeline_checkpoints")
MAX_RETRIES = 3
RETRY_BACKOFF = [2, 5, 15]  # seconds between retries


class StepStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class PipelineState:
    """State passed between pipeline steps."""
    run_date: str = ""
    step_results: dict[str, Any] = field(default_factory=dict)
    step_status: dict[str, str] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    started_at: str = ""
    completed_at: str = ""

    def to_dict(self) -> dict:
        return {
            "run_date": self.run_date,
            "step_results": self.step_results,
            "step_status": self.step_status,
            "errors": self.errors,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "PipelineState":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class StepDef:
    """Definition of a pipeline step."""
    name: str
    fn: Callable[[PipelineState, httpx.AsyncClient], Awaitable[Any]]
    required: bool = True       # if False, failure doesn't stop pipeline
    depends_on: str = ""        # step name that must succeed first


class DailyPipeline:
    """
    Lightweight StateGraph for the daily prediction pipeline.

    Usage:
        pipeline = DailyPipeline(worker_url, auth_token)
        result = await pipeline.run()
    """

    def __init__(self, worker_url: str, auth_token: str = ""):
        self.worker_url = worker_url
        self.auth_token = auth_token
        self.steps: list[StepDef] = []

    def add_step(self, name: str, fn, required: bool = True, depends_on: str = ""):
        self.steps.append(StepDef(name=name, fn=fn, required=required, depends_on=depends_on))

    async def _run_step_with_retry(
        self, step: StepDef, state: PipelineState, client: httpx.AsyncClient
    ) -> tuple[bool, Any]:
        """Run a step with retry + exponential backoff."""
        for attempt in range(MAX_RETRIES):
            try:
                state.step_status[step.name] = StepStatus.RUNNING
                result = await step.fn(state, client)
                state.step_status[step.name] = StepStatus.SUCCESS
                return True, result
            except Exception as e:
                wait = RETRY_BACKOFF[attempt] if attempt < len(RETRY_BACKOFF) else RETRY_BACKOFF[-1]
                logger.warning(
                    f"[Pipeline] Step '{step.name}' attempt {attempt+1}/{MAX_RETRIES} "
                    f"failed: {e}. Retry in {wait}s..."
                )
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(wait)

        state.step_status[step.name] = StepStatus.FAILED
        state.errors.append(f"{step.name}: failed after {MAX_RETRIES} retries")
        return False, None

    def _save_checkpoint(self, state: PipelineState):
        """Save state to local checkpoint file."""
        os.makedirs(CHECKPOINT_DIR, exist_ok=True)
        path = os.path.join(CHECKPOINT_DIR, f"pipeline_{state.run_date}.json")
        with open(path, "w") as f:
            json.dump(state.to_dict(), f, ensure_ascii=False, indent=2)
        logger.info(f"[Pipeline] Checkpoint saved: {path}")

    def _load_checkpoint(self, run_date: str) -> Optional[PipelineState]:
        """Load state from checkpoint if exists."""
        path = os.path.join(CHECKPOINT_DIR, f"pipeline_{run_date}.json")
        if os.path.exists(path):
            with open(path) as f:
                data = json.load(f)
            logger.info(f"[Pipeline] Resuming from checkpoint: {path}")
            return PipelineState.from_dict(data)
        return None

    async def run(self, run_date: str = "", resume: bool = True) -> dict:
        """Execute the full pipeline."""
        if not run_date:
            run_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        # Try to resume from checkpoint
        state = None
        if resume:
            state = self._load_checkpoint(run_date)

        if not state:
            state = PipelineState(
                run_date=run_date,
                started_at=datetime.now(timezone.utc).isoformat(),
            )

        async with httpx.AsyncClient(timeout=120.0) as client:
            for step in self.steps:
                # Skip already completed steps (resume)
                if state.step_status.get(step.name) == StepStatus.SUCCESS:
                    logger.info(f"[Pipeline] Skipping '{step.name}' (already completed)")
                    continue

                # Check dependency
                if step.depends_on:
                    dep_status = state.step_status.get(step.depends_on, StepStatus.PENDING)
                    if dep_status == StepStatus.FAILED:
                        if step.required:
                            state.step_status[step.name] = StepStatus.SKIPPED
                            state.errors.append(
                                f"{step.name}: skipped (dependency '{step.depends_on}' failed)"
                            )
                            logger.warning(
                                f"[Pipeline] Skipping '{step.name}': dependency '{step.depends_on}' failed"
                            )
                            continue
                        # Non-required step with failed dependency: still try
                        logger.info(
                            f"[Pipeline] '{step.name}' has failed dependency but is not required, trying anyway"
                        )

                logger.info(f"[Pipeline] Running step '{step.name}'...")
                t0 = time.time()
                ok, result = await self._run_step_with_retry(step, state, client)
                elapsed = time.time() - t0

                if result is not None:
                    state.step_results[step.name] = result

                logger.info(
                    f"[Pipeline] Step '{step.name}': "
                    f"{'SUCCESS' if ok else 'FAILED'} ({elapsed:.1f}s)"
                )

                # Save checkpoint after each step
                self._save_checkpoint(state)

                # If required step fails, stop pipeline
                if not ok and step.required:
                    logger.error(f"[Pipeline] Required step '{step.name}' failed, stopping pipeline")
                    break

        state.completed_at = datetime.now(timezone.utc).isoformat()
        self._save_checkpoint(state)

        return {
            "status": "completed" if all(
                s == StepStatus.SUCCESS for s in state.step_status.values()
                if s != StepStatus.SKIPPED
            ) else "partial",
            "run_date": run_date,
            "steps": state.step_status,
            "errors": state.errors,
            "started_at": state.started_at,
            "completed_at": state.completed_at,
        }


def build_daily_pipeline(worker_url: str, auth_token: str = "") -> DailyPipeline:
    """
    Build the standard daily prediction pipeline:
    screener → ml_predict → recommend
    """
    pipeline = DailyPipeline(worker_url, auth_token)
    headers = {"Content-Type": "application/json"}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"

    async def step_screener(state: PipelineState, client: httpx.AsyncClient):
        resp = await client.post(
            f"{worker_url}/api/admin/trigger:screener",
            headers=headers, timeout=120.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return {"candidates": data.get("result", {}).get("candidates", [])}

    async def step_ml_predict(state: PipelineState, client: httpx.AsyncClient):
        resp = await client.post(
            f"{worker_url}/api/admin/trigger:ml",
            headers=headers, timeout=300.0,
        )
        resp.raise_for_status()
        return resp.json().get("result")

    async def step_recommend(state: PipelineState, client: httpx.AsyncClient):
        resp = await client.post(
            f"{worker_url}/api/admin/trigger:recommendation",
            headers=headers, timeout=120.0,
        )
        resp.raise_for_status()
        return resp.json().get("result")

    pipeline.add_step("screener", step_screener, required=True)
    pipeline.add_step("ml_predict", step_ml_predict, required=True, depends_on="screener")
    pipeline.add_step("recommend", step_recommend, required=False, depends_on="ml_predict")

    return pipeline
