"""Guards and argv for the sealed R33 FinLab training capture run on Modal.

The capture writes only its own GCS prefix (plus the shared official-history
cache). It never writes D1, never calls the Worker or controller, and keeps the
daily `finlab_v4_backfill` dispatch path untouched.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, MutableMapping

# Same scrub as the local capture runbook: no D1, controller proxy, or callback credentials.
ENV_DROP_PREFIXES = ("CF_", "FINLAB_CONTROLLER_", "ML_CONTROLLER_")
ENV_DROP_NAMES = (
    "MULTI_D1_ACTIVE_DOMAINS",
    "FINLAB_DAILY_HISTORY_BOOTSTRAP_REF",
    "STOCKVISION_AUTH_TOKEN",
    "STOCKVISION_WORKER_URL",
)
FINLAB_AUTH_ENV_NAMES = ("FINLAB_API_KEY", "FINLAB_REFRESH_TOKEN", "FINLAB_SESSION_ID")

DEFAULT_GCS_PREFIX = "finlab/v4/backfill"
DEFAULT_OUTPUT_DIR = "/tmp/finlab_training_capture"
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


def training_capture_argv(payload: dict[str, Any], *, bucket_name: str) -> list[str]:
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
    if not run_id.startswith(f"finlab-v4-{years}y-") or not all(c.isalnum() or c == "-" for c in run_id):
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
        "--lanes", str(payload["lanes"]),
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
