from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MODAL_APP = ROOT / "ml-service" / "modal_app.py"

K15_PAYLOAD = {
    "run_id": "finlab-v4-3y-r33full-20261104",
    "years": 3,
    "lanes": "daily_price,chip_diversity,revenue,fundamental_factor_diversity,training_shareholding,broker_flow_diversity",
    "fundamental_training_fields_only": True,
    "source_start_date": "2020-05-04",
    "training_capture_start_date": "2020-05-04",
    "source_end_date": "2026-11-04",
}


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


capture = _load("finlab_training_capture_under_test", ROOT / "ml-service" / "app" / "finlab_training_capture.py")


def _function_block(source: str, name: str) -> tuple[str, str]:
    """Return (decorator, body) of a Modal function in modal_app.py."""
    head, rest = source.split(f"def {name}(payload: dict) -> dict:", 1)
    decorator = head[head.rindex("@app.function("):]
    body = re.split(r"\n@app\.|\n# ASGI web endpoint", rest, maxsplit=1)[0]
    return decorator, body


def test_k15_payload_maps_to_the_local_runbook_argv():
    argv = capture.training_capture_argv(dict(K15_PAYLOAD), bucket_name="stockvision-models")
    assert argv == [
        "finlab_v4_remote_backfill.py",
        "--years", "3",
        "--run-id", "finlab-v4-3y-r33full-20261104",
        "--output-dir", "/tmp/finlab_training_capture",
        "--gcs-bucket", "stockvision-models",
        "--gcs-prefix", "finlab/v4/backfill",
        "--lanes", K15_PAYLOAD["lanes"],
        "--fundamental-training-fields-only",
        "--source-start-date", "2020-05-04",
        "--training-capture-start-date", "2020-05-04",
        "--source-end-date", "2026-11-04",
    ]
    for forbidden in ("--write-d1", "--apply-canonical-d1", "--daily-refresh", "--require-official-market-summary"):
        assert forbidden not in argv


@pytest.mark.parametrize("key", ["write_d1", "apply_canonical_d1", "daily_refresh", "continue_evening_chain",
                                 "callback_url", "controller_callback_url", "controller_token", "canonical_datasets"])
def test_daily_only_or_write_keys_fail_closed(key):
    with pytest.raises(ValueError, match="training_capture_payload_unknown_keys"):
        capture.training_capture_argv({**K15_PAYLOAD, key: True}, bucket_name="b")


@pytest.mark.parametrize("change, error", [
    ({"training_capture_start_date": ""}, "training_capture_payload_missing"),
    ({"source_end_date": None}, "training_capture_payload_missing"),
    ({"run_id": "finlab-v4-daily-20261104-x"}, "training_capture_run_id_invalid"),
    ({"run_id": "finlab-v4-3y-r33full/20261104"}, "training_capture_run_id_invalid"),
    ({"source_end_date": "2026-11-4"}, "training_capture_date_invalid"),
    ({"fundamental_training_fields_only": "true"}, "training_capture_fundamental_flag_not_bool"),
])
def test_invalid_payloads_fail_closed(change, error):
    with pytest.raises(ValueError, match=error):
        capture.training_capture_argv({**K15_PAYLOAD, **change}, bucket_name="b")
    with pytest.raises(ValueError, match="training_capture_gcs_bucket_missing"):
        capture.training_capture_argv(dict(K15_PAYLOAD), bucket_name="")


def test_env_scrub_removes_d1_controller_and_callback_names_only():
    env = {
        "CF_API_TOKEN": "x", "CF_ACCOUNT_ID": "x", "CF_D1_DB_ID": "x", "CF_D1_MARKET_DB_ID": "x",
        "FINLAB_CONTROLLER_TOKEN": "x", "ML_CONTROLLER_TOKEN": "x", "ML_CONTROLLER_SECRET": "x",
        "MULTI_D1_ACTIVE_DOMAINS": "x", "FINLAB_DAILY_HISTORY_BOOTSTRAP_REF": "x",
        "STOCKVISION_AUTH_TOKEN": "x", "STOCKVISION_WORKER_URL": "x",
        "FINLAB_API_KEY": "k", "GCS_BUCKET_NAME": "b", "GOOGLE_APPLICATION_CREDENTIALS": "p",
    }
    removed = capture.scrub_training_capture_env(env)
    assert set(env) == {"FINLAB_API_KEY", "GCS_BUCKET_NAME", "GOOGLE_APPLICATION_CREDENTIALS"}
    assert removed == sorted(removed) and "FINLAB_API_KEY" not in removed and len(removed) == 11


class _Bucket:
    def __init__(self, names):
        self.names, self.calls = names, []

    def list_blobs(self, prefix, max_results):
        self.calls.append((prefix, max_results))
        return iter([n for n in self.names if n.startswith(prefix)][:max_results])


def test_run_id_guard_refuses_an_existing_capture_prefix():
    capture.assert_run_id_unused(_Bucket(["finlab/v4/backfill/finlab-v4-3y-r33full-20261104x/m.json"]),
                                 gcs_prefix="finlab/v4/backfill/", run_id="finlab-v4-3y-r33full-20261104")
    bucket = _Bucket(["finlab/v4/backfill/finlab-v4-3y-r33full-20261104/manifest.json"])
    with pytest.raises(RuntimeError, match="training_capture_run_id_exists"):
        capture.assert_run_id_unused(bucket, gcs_prefix="finlab/v4/backfill", run_id="finlab-v4-3y-r33full-20261104")
    assert bucket.calls == [("finlab/v4/backfill/finlab-v4-3y-r33full-20261104/", 1)]


def test_capture_tool_parses_the_modal_argv_into_training_capture_kwargs(monkeypatch, tmp_path):
    tool = _load("finlab_v4_remote_backfill_training_capture", ROOT / "tools" / "finlab_v4_remote_backfill.py")
    seen = {}

    class Stop(Exception):
        pass

    def fake_materialize_specs(**kwargs):
        seen.update(kwargs)
        raise Stop

    monkeypatch.setattr(tool, "materialize_specs", fake_materialize_specs)
    monkeypatch.setenv("FINLAB_API_KEY", "dummy-not-a-key")
    argv = capture.training_capture_argv({**K15_PAYLOAD, "output_dir": str(tmp_path)}, bucket_name="stockvision-models")
    monkeypatch.setattr(sys, "argv", argv)
    with pytest.raises(Stop):
        tool.main()
    assert seen["years"] == 3
    assert seen["run_dir"] == tmp_path / "finlab-v4-3y-r33full-20261104"
    assert seen["training_capture_start_date"] == "2020-05-04"
    assert seen["source_start_date"] == "2020-05-04"
    assert seen["source_end_date"] == "2026-11-04"
    assert seen["daily_refresh"] is False and seen["daily_history"] is None
    assert seen["gcs_bucket"] == "stockvision-models" and seen["gcs_prefix"] == "finlab/v4/backfill"
    assert seen["lanes"] == K15_PAYLOAD["lanes"].split(",")
    assert seen["key_scope"]["fundamental_factor_diversity"] == set(tool.FUNDAMENTAL_TRAINING_KEY_SCOPE["fundamental_factor_diversity"])
    assert seen["key_scope"]["daily_price"] == set()


def test_training_capture_modal_function_is_sized_and_isolated():
    source = MODAL_APP.read_text(encoding="utf-8")
    decorator, body = _function_block(source, "finlab_v4_training_capture")
    for setting in ("cpu=2,", "memory=16384,", "timeout=28800,", "max_containers=1,", "retries=0,"):
        assert setting in decorator
    for forbidden in ("_post_worker_scheduler_callback", "write_d1", "_write_finlab_macro_context_to_d1",
                      "_write_external_evidence_to_d1", "StageProgress"):
        assert forbidden not in body
    assert body.index("scrub_training_capture_env(os.environ)") < body.index("finlab_v4_remote_backfill.main()")
    assert body.index("assert_run_id_unused(") < body.index("verify_gcs_object_lifecycle(")
    assert body.index("verify_capture_upload(bucket)") < body.index("finlab_v4_remote_backfill.main()")


def test_daily_backfill_function_keeps_its_settings_and_ignores_training_keys():
    source = MODAL_APP.read_text(encoding="utf-8")
    decorator, body = _function_block(source, "finlab_v4_backfill")
    for setting in ("cpu=2,", "memory=4096,", "timeout=7200,", "max_containers=1,"):
        assert setting in decorator
    for training_only in ("training_capture", "--training-capture-start-date", "--fundamental-training-fields-only"):
        assert training_only not in body
    assert "_post_worker_scheduler_callback(payload, result, status, summary, duration_ms)" in body
