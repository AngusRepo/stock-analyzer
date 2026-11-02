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
TOOL = _load("finlab_v4_remote_backfill_training_capture", ROOT / "tools" / "finlab_v4_remote_backfill.py")
TOOL_LANES = {spec.lane for spec in TOOL.CORE_SPECS}


def _function_block(source: str, name: str) -> tuple[str, str]:
    """Return (decorator, body) of a Modal function in modal_app.py."""
    head, rest = source.split(f"def {name}(payload: dict) -> dict:", 1)
    decorator = head[head.rindex("@app.function("):]
    body = re.split(r"\n@app\.|\n# ASGI web endpoint", rest, maxsplit=1)[0]
    return decorator, body


def test_k15_payload_maps_to_the_local_runbook_argv():
    argv = capture.training_capture_argv(dict(K15_PAYLOAD), bucket_name="stockvision-models", known_lanes=TOOL_LANES)
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
        capture.training_capture_argv({**K15_PAYLOAD, key: True}, bucket_name="b", known_lanes=TOOL_LANES)


@pytest.mark.parametrize("change, error", [
    ({"training_capture_start_date": ""}, "training_capture_payload_missing"),
    ({"source_end_date": None}, "training_capture_payload_missing"),
    ({"run_id": "finlab-v4-daily-20261104-x"}, "training_capture_run_id_invalid"),
    ({"run_id": "finlab-v4-3y-r33full/20261104"}, "training_capture_run_id_invalid"),
    ({"run_id": "finlab-v4-3y-r33full-２0261104"}, "training_capture_run_id_invalid"),
    ({"source_end_date": "2026-11-4"}, "training_capture_date_invalid"),
    ({"fundamental_training_fields_only": "true"}, "training_capture_fundamental_flag_not_bool"),
])
def test_invalid_payloads_fail_closed(change, error):
    with pytest.raises(ValueError, match=error):
        capture.training_capture_argv({**K15_PAYLOAD, **change}, bucket_name="b", known_lanes=TOOL_LANES)
    with pytest.raises(ValueError, match="training_capture_gcs_bucket_missing"):
        capture.training_capture_argv(dict(K15_PAYLOAD), bucket_name="", known_lanes=TOOL_LANES)


def test_env_scrub_removes_d1_controller_and_callback_names_only():
    env = {
        "CF_API_TOKEN": "x", "CF_ACCOUNT_ID": "x", "CF_D1_DB_ID": "x", "CF_D1_MARKET_DB_ID": "x",
        "FINLAB_CONTROLLER_TOKEN": "x", "ML_CONTROLLER_TOKEN": "x", "ML_CONTROLLER_SECRET": "x",
        "MULTI_D1_ACTIVE_DOMAINS": "x", "FINLAB_DAILY_HISTORY_BOOTSTRAP_REF": "x",
        "STOCKVISION_AUTH_TOKEN": "x", "STOCKVISION_WORKER_URL": "x", "RETRAIN_CALLBACK_TOKEN": "x",
        "FINLAB_API_KEY": "k", "GCS_BUCKET_NAME": "b", "GOOGLE_APPLICATION_CREDENTIALS": "p",
    }
    removed = capture.scrub_training_capture_env(env)
    assert set(env) == {"FINLAB_API_KEY", "GCS_BUCKET_NAME", "GOOGLE_APPLICATION_CREDENTIALS"}
    assert removed == sorted(removed) and "FINLAB_API_KEY" not in removed and len(removed) == 12


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
    tool = TOOL
    seen = {}

    class Stop(Exception):
        pass

    def fake_materialize_specs(**kwargs):
        seen.update(kwargs)
        raise Stop

    monkeypatch.setattr(tool, "materialize_specs", fake_materialize_specs)
    monkeypatch.setenv("FINLAB_API_KEY", "dummy-not-a-key")
    argv = capture.training_capture_argv({**K15_PAYLOAD, "output_dir": str(tmp_path)}, bucket_name="stockvision-models",
                                         known_lanes=TOOL_LANES)
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
    for setting in ("cpu=2,", "memory=16384,", "timeout=28800,", "max_containers=1,", "retries=0,",
                    "nonpreemptible=True,"):
        assert setting in decorator
    assert "gpu" not in decorator  # Modal: nonpreemptible is CPU-only
    for forbidden in ("_post_worker_scheduler_callback", "write_d1", "_write_finlab_macro_context_to_d1",
                      "_write_external_evidence_to_d1", "StageProgress"):
        assert forbidden not in body
    assert body.index("scrub_training_capture_env(os.environ)") < body.index("finlab_v4_remote_backfill.main()")
    order = ["scrub_training_capture_env(os.environ)", "from tools import finlab_v4_remote_backfill",
             "training_capture_argv(", "claim_run(", "verify_gcs_object_lifecycle(", "verify_capture_upload(bucket)",
             "finlab_v4_remote_backfill.main()"]
    assert [body.index(step) for step in order] == sorted(body.index(step) for step in order)
    assert "known_lanes={spec.lane for spec in finlab_v4_remote_backfill.CORE_SPECS}" in body
    assert "function_call_id=modal.current_function_call_id()" in body
    assert "input_id=modal.current_input_id()" in body
    # Only the two cache/bucket defaults may write env after the scrub.
    assert re.findall(r"os\.environ(?:\[|\.(?:update|setdefault|__setitem__)\()", body) == ["os.environ.setdefault("] * 2


def test_daily_backfill_function_keeps_its_settings_and_ignores_training_keys():
    source = MODAL_APP.read_text(encoding="utf-8")
    decorator, body = _function_block(source, "finlab_v4_backfill")
    for setting in ("cpu=2,", "memory=4096,", "timeout=7200,", "max_containers=1,"):
        assert setting in decorator
    for training_only in ("training_capture", "--training-capture-start-date", "--fundamental-training-fields-only"):
        assert training_only not in body
    assert "_post_worker_scheduler_callback(payload, result, status, summary, duration_ms)" in body


def test_k15_lanes_are_tool_lanes_and_bad_lanes_fail_before_any_write():
    assert set(K15_PAYLOAD["lanes"].split(",")) <= TOOL_LANES
    assert capture.validate_lanes(K15_PAYLOAD["lanes"], TOOL_LANES) == K15_PAYLOAD["lanes"]
    cases = {
        K15_PAYLOAD["lanes"].replace("broker_flow_diversity", "broker_flow_diversty"): "training_capture_lanes_unknown",
        K15_PAYLOAD["lanes"] + ",daily_price": "training_capture_lanes_malformed",
        K15_PAYLOAD["lanes"] + ",": "training_capture_lanes_malformed",
    }
    for lanes, error in cases.items():
        with pytest.raises(ValueError, match=error):
            capture.training_capture_argv({**K15_PAYLOAD, "lanes": lanes}, bucket_name="b", known_lanes=TOOL_LANES)
    with pytest.raises(ValueError, match="training_capture_lanes_not_string"):
        capture.training_capture_argv({**K15_PAYLOAD, "lanes": K15_PAYLOAD["lanes"].split(",")},
                                      bucket_name="b", known_lanes=TOOL_LANES)


class _PreconditionBucket:
    """In-memory GCS bucket with if_generation_match=0 create-only semantics."""

    name = "stockvision-models"

    def __init__(self, objects=None):
        import threading
        self.objects = dict(objects or {})
        self.lock = threading.Lock()
        self.uploads = []

    def blob(self, name):
        bucket = self

        class Blob:
            def upload_from_string(self, data, content_type=None, **kwargs):
                from google.api_core.exceptions import PreconditionFailed
                bucket.uploads.append((name, kwargs))
                with bucket.lock:
                    if kwargs.get("if_generation_match") == 0 and name in bucket.objects:
                        raise PreconditionFailed("exists")
                    bucket.objects[name] = data.encode() if isinstance(data, str) else data

            def download_as_bytes(self):
                return bucket.objects[name]

        return Blob()

    def list_blobs(self, prefix, max_results=None):
        return iter([n for n in sorted(self.objects) if n.startswith(prefix)][:max_results])


RUN = "finlab-v4-3y-r33full-20261104"
CLAIM = f"finlab/v4/training-capture-claims/{RUN}.json"


def _claim(bucket, call_id="fc-1", input_id="in-1"):
    return capture.claim_run(bucket, gcs_prefix="finlab/v4/backfill", run_id=RUN, function_call_id=call_id,
                             input_id=input_id, source_sha="a" * 40)


def test_claim_is_create_only_outside_selector_prefixes_and_records_identity():
    import json
    bucket = _PreconditionBucket()
    result = _claim(bucket)
    assert result["state"] == "claimed" and result["object"] == CLAIM
    assert bucket.uploads == [(CLAIM, {"if_generation_match": 0})]
    record = json.loads(bucket.objects[CLAIM])
    assert {k: record[k] for k in ("run_id", "function_call_id", "input_id", "source_sha", "capture_prefix")} == {
        "run_id": RUN, "function_call_id": "fc-1", "input_id": "in-1", "source_sha": "a" * 40,
        "capture_prefix": f"finlab/v4/backfill/{RUN}/"}
    assert record["claimed_at"] and set(record) == {"schema_version", "run_id", "capture_prefix", "function_call_id",
                                                     "input_id", "claimed_at", "source_sha"}
    for selector in ("finlab/v4/backfill", "universal/sequence_long/runs", "finlab/v4/official-history-cache"):
        assert not CLAIM.startswith(selector)


def test_same_call_reenters_even_over_its_partial_upload(capsys):
    bucket = _PreconditionBucket()
    _claim(bucket, input_id="in-1")
    bucket.objects[f"finlab/v4/backfill/{RUN}/raw/daily_price_full_vintage/close.parquet"] = b"partial"
    result = _claim(bucket, input_id="in-2")  # preemption restart of the same call
    assert result["state"] == "reentered" and result["claim"]["input_id"] == "in-1"
    assert "reentry run_id=" + RUN in capsys.readouterr().out


def test_another_call_is_refused_even_before_any_capture_object():
    bucket = _PreconditionBucket()
    _claim(bucket, call_id="fc-1")
    with pytest.raises(RuntimeError, match="training_capture_run_id_claimed:.*fc-1"):
        _claim(bucket, call_id="fc-2")


def test_fresh_claim_still_refuses_a_capture_written_by_anything_else():
    bucket = _PreconditionBucket({f"finlab/v4/backfill/{RUN}/manifest.json": b"{}"})
    with pytest.raises(RuntimeError, match="training_capture_run_id_exists"):
        _claim(bucket)


def test_missing_modal_identity_fails_closed():
    with pytest.raises(RuntimeError, match="training_capture_identity_unavailable"):
        _claim(_PreconditionBucket(), call_id=None)


def test_two_racing_spawns_get_exactly_one_claim():
    from concurrent.futures import ThreadPoolExecutor
    import threading
    bucket = _PreconditionBucket()
    barrier = threading.Barrier(8)

    def attempt(i):
        barrier.wait()
        try:
            return _claim(bucket, call_id=f"fc-{i}")["state"]
        except RuntimeError as exc:
            return str(exc).split(":", 1)[0]

    with ThreadPoolExecutor(8) as pool:
        states = sorted(pool.map(attempt, range(8)))
    assert states == ["claimed"] + ["training_capture_run_id_claimed"] * 7
