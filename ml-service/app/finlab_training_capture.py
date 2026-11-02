"""Guards and argv for the sealed R33 FinLab training capture run on Modal.

The capture writes its own GCS prefix, one claim object, the shared
official-history cache, and short-lived health/preflight canaries. It never
writes D1, never calls the Worker or controller, and keeps the daily
`finlab_v4_backfill` dispatch path untouched.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import re
from typing import Any, Iterable, MutableMapping

# Same scrub as the local capture runbook: no D1, controller proxy, or callback credentials.
ENV_DROP_PREFIXES = ("CF_", "FINLAB_CONTROLLER_", "ML_CONTROLLER_")
ENV_DROP_NAMES = (
    "MULTI_D1_ACTIVE_DOMAINS",
    "FINLAB_DAILY_HISTORY_BOOTSTRAP_REF",
    "STOCKVISION_AUTH_TOKEN",
    "STOCKVISION_WORKER_URL",
    "RETRAIN_CALLBACK_TOKEN",
)
FINLAB_AUTH_ENV_NAMES = ("FINLAB_API_KEY", "FINLAB_REFRESH_TOKEN", "FINLAB_SESSION_ID")

DEFAULT_GCS_PREFIX = "finlab/v4/backfill"
DEFAULT_OUTPUT_DIR = "/tmp/finlab_training_capture"
# Outside every prefix a selector lists (finlab/v4/backfill, universal/sequence_long/runs,
# the official-history cache); a sibling such as backfill_claims would match an unslashed
# "finlab/v4/backfill" listing.
CLAIM_PREFIX = "finlab/v4/training-capture-claims"
CLAIM_SCHEMA = "stockvision-finlab-training-capture-claim-v1"
_REQUIRED = ("run_id", "years", "lanes", "source_start_date", "training_capture_start_date", "source_end_date")
_OPTIONAL = ("fundamental_training_fields_only", "gcs_bucket", "gcs_prefix", "output_dir")


def _date(payload: dict, key: str) -> str:
    value = str(payload[key])
    try:
        if datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d") != value:
            raise ValueError
    except ValueError as exc:
        raise ValueError(f"training_capture_date_invalid:{key}") from exc
    return value


def validate_lanes(lanes: Any, known_lanes: Iterable[str]) -> str:
    """Comma-separated, no duplicates, every lane accepted by the capture tool."""
    if not isinstance(lanes, str):
        raise ValueError("training_capture_lanes_not_string")
    items = [item.strip() for item in lanes.split(",")]
    if not items or any(not item for item in items) or len(set(items)) != len(items):
        raise ValueError("training_capture_lanes_malformed")
    unknown = sorted(set(items) - set(known_lanes))
    if unknown:
        raise ValueError("training_capture_lanes_unknown:" + ",".join(unknown))
    return ",".join(items)


def training_capture_argv(payload: dict[str, Any], *, bucket_name: str, known_lanes: Iterable[str]) -> list[str]:
    """Build the capture tool argv; unknown keys (write_d1, callbacks, daily flags) fail closed."""
    unknown = sorted(set(payload) - set(_REQUIRED) - set(_OPTIONAL))
    if unknown:
        raise ValueError("training_capture_payload_unknown_keys:" + ",".join(unknown))
    missing = [key for key in _REQUIRED if payload.get(key) in (None, "")]
    if missing:
        raise ValueError("training_capture_payload_missing:" + ",".join(missing))
    if not bucket_name:
        raise ValueError("training_capture_gcs_bucket_missing")
    years = int(payload["years"])
    run_id = str(payload["run_id"])
    # The controller's sequence refresh only accepts finlab-v4-<N>y- capture ids.
    if not re.fullmatch(rf"finlab-v4-{years}y-[a-z0-9-]+", run_id):
        raise ValueError("training_capture_run_id_invalid")
    flag = payload.get("fundamental_training_fields_only", False)
    if not isinstance(flag, bool):
        raise ValueError("training_capture_fundamental_flag_not_bool")
    argv = [
        "finlab_v4_remote_backfill.py",
        "--years", str(years),
        "--run-id", run_id,
        "--output-dir", str(payload.get("output_dir") or DEFAULT_OUTPUT_DIR),
        "--gcs-bucket", bucket_name,
        "--gcs-prefix", training_capture_gcs_prefix(payload),
        "--lanes", validate_lanes(payload["lanes"], known_lanes),
    ]
    if flag:
        argv.append("--fundamental-training-fields-only")
    argv += [
        "--source-start-date", _date(payload, "source_start_date"),
        "--training-capture-start-date", _date(payload, "training_capture_start_date"),
        "--source-end-date", _date(payload, "source_end_date"),
    ]
    return argv


def training_capture_gcs_prefix(payload: dict[str, Any]) -> str:
    return str(payload.get("gcs_prefix") or DEFAULT_GCS_PREFIX).strip("/")


def scrub_training_capture_env(environ: MutableMapping[str, str]) -> list[str]:
    """Remove D1/controller/callback credentials; return the removed names (never values)."""
    removed = sorted(
        name for name in list(environ)
        if name.startswith(ENV_DROP_PREFIXES) or name in ENV_DROP_NAMES
    )
    for name in removed:
        environ.pop(name, None)
    return removed


def assert_run_id_unused(bucket: Any, *, gcs_prefix: str, run_id: str) -> None:
    """A second call with the same id would overwrite a sealed capture; refuse instead."""
    prefix = f"{gcs_prefix.strip('/')}/{run_id}/"
    if next(iter(bucket.list_blobs(prefix=prefix, max_results=1)), None) is not None:
        raise RuntimeError(f"training_capture_run_id_exists:{prefix}")


def claim_run(bucket: Any, *, gcs_prefix: str, run_id: str, function_call_id: str | None,
              input_id: str | None, source_sha: str | None) -> dict[str, Any]:
    """Atomically claim run_id for this Modal call before any other GCS write.

    The same function call (a preemption/restart rerun of the same input) re-enters and may
    overwrite its own partial upload; any other call is refused, even after a failed run.
    """
    from google.api_core.exceptions import PreconditionFailed

    if not function_call_id:
        raise RuntimeError("training_capture_identity_unavailable")
    name = f"{CLAIM_PREFIX}/{run_id}.json"
    record = {
        "schema_version": CLAIM_SCHEMA,
        "run_id": run_id,
        "capture_prefix": f"{gcs_prefix.strip('/')}/{run_id}/",
        "function_call_id": function_call_id,
        "input_id": input_id,
        "claimed_at": datetime.now(timezone.utc).isoformat(),
        "source_sha": source_sha or None,
    }
    try:
        bucket.blob(name).upload_from_string(
            json.dumps(record, sort_keys=True), content_type="application/json", if_generation_match=0)
    except PreconditionFailed:
        held = json.loads(bucket.blob(name).download_as_bytes())
        if held.get("function_call_id") != function_call_id:
            raise RuntimeError(f"training_capture_run_id_claimed:{name}:{held.get('function_call_id')}") from None
        print(f"[finlab_v4_training_capture] reentry run_id={run_id} function_call_id={function_call_id} "
              f"input_id={input_id} claimed_at={held.get('claimed_at')}", flush=True)
        return {"state": "reentered", "object": name, "claim": held}
    # A fresh claim must also find no capture written by anything else (local tool runs).
    assert_run_id_unused(bucket, gcs_prefix=gcs_prefix, run_id=run_id)
    return {"state": "claimed", "object": name, "claim": record}
