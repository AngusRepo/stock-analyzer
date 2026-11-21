"""C28-25 (ii): a daily capture whose composition is skipped for another lane's blocker must not write
NULL margin/short when the late-published fields are not out yet; it reports finlab_source_not_ready."""
from __future__ import annotations

import json
import re
import sys

import pandas as pd
import pytest

from test_finlab_remote_backfill_tool_contract import _load_tool_module

PRIOR, TARGET = "2026-10-12", "2026-10-13"
LATE_FIELDS = ("margin_balance", "short_balance")
DAILY_PRICE_BLOCKER = {"lane": "daily_price", "kind": "wide_fields", "reason": "required_wide_field_incomplete",
                       "errors": ["close=missing_target_date:" + TARGET]}
REGIME_BLOCKER = {"lane": "regime_context", "kind": "official_index", "reason": "official_index_target_date_missing"}
CHIP_BLOCKER = {"lane": "chip_diversity", "kind": "wide_fields", "reason": "required_wide_field_incomplete",
                "errors": ["foreign_net=missing_target_date:" + TARGET]}
# updateOrchestrator.ts: a summary carrying any of these is a partial failure, never the late-lane retry.
WORKER_PARTIAL_FAILURE = re.compile(r"partial_failed|source_key_blockers|required_wide_field_incomplete|"
                                    r"materializer_(?:blocked|failed)", re.I)


def wide(dates, values):
    frame = pd.DataFrame(values, index=pd.to_datetime(dates))
    frame.index.name = "date"
    return frame


def chip_api_key(tool, field):
    return tool.CORE_SPECS[[s.lane for s in tool.CORE_SPECS].index("chip_diversity")].keys[field]


def write_chip_lane(tool, run_dir, *, late):
    """late: 'missing' (target row absent), 'partial' (one symbol published), 'published', 'failed' /
    'schema_mismatch' (the margin/short fetch raised: report row only, no parquet, no blocker, as in
    materialize_specs' non-quota except branch) or 'absent' (no margin/short report at all)."""
    lane_dir = run_dir / "raw" / "chip_diversity"
    reports = []
    frames = {"foreign_net": wide([PRIOR, TARGET], {"2330": [1.0, 2.0], "2317": [3.0, 4.0]})}
    for field in LATE_FIELDS:
        if late == "empty":
            # Production daily window is target-only: an unpublished late field has no rows at all.
            frames[field] = wide([TARGET], {"2330": [None], "2317": [None]})
        elif late in {"failed", "schema_mismatch"}:
            reports.append(tool.source_key_report_row(
                run_id=run_dir.name, generated_at=TARGET + "T13:45:00+00:00", target_date=TARGET,
                lane="chip_diversity", field=field, api_key=chip_api_key(tool, field), status=late,
                error=RuntimeError("HTTP 500" if late == "failed" else "ColumnNotFound: " + field),
                metadata={"kind": "wide_fields"}))
        elif late == "absent":
            continue
        elif late == "missing":
            frames[field] = wide([PRIOR], {"2330": [10.0], "2317": [20.0]})
        elif late == "partial":
            frames[field] = wide([PRIOR, TARGET], {"2330": [10.0, 11.0], "2317": [20.0, None]})
        else:
            frames[field] = wide([PRIOR, TARGET], {"2330": [10.0, 11.0], "2317": [20.0, 21.0]})
    for field, frame in frames.items():
        path = lane_dir / f"{field}.parquet"
        tool.write_parquet(path, frame)
        rows, target_rows = tool.non_null_cells(frame), tool._target_non_null_cells(frame, TARGET)
        reports.append(tool.source_key_report_row(
            run_id=run_dir.name, generated_at=TARGET + "T13:45:00+00:00", target_date=TARGET, lane="chip_diversity",
            field=field, api_key=chip_api_key(tool, field),
            status=tool.source_key_status(rows=rows, target_rows=target_rows, target_date=TARGET),
            rows=rows, target_rows=target_rows, latest_date=tool.latest_index(frame), path=path, run_dir=run_dir))
    return reports


def run_main(monkeypatch, tmp_path, *, blockers, late, produce_error=None, write_d1=False, apply_args=None,
             extra_args=()):
    from google.cloud import storage
    from services import daily_history_capture, daily_inference_producer
    from services.finlab_canonical_materializer import build_d1_upsert_statements, materialize_finlab_canonical_outputs
    tool = _load_tool_module()
    calls = {"produce": 0, "publish": 0, "apply": [], "chip_rows": [], "upload": 0, "key_report": 0, "d1": 0}

    def fake_specs(**kwargs):
        return [], [], write_chip_lane(tool, kwargs["run_dir"], late=late), [dict(b) for b in blockers]

    def fake_produce(**kwargs):
        calls["produce"] += 1
        if produce_error:
            raise ValueError(produce_error)
        return {"path": "x/inference/manifest.json", "sha256": "a" * 64, "capture_id": "x", "business_date": TARGET}

    def fake_apply(manifest, *, start_date, end_date, datasets, **kwargs):
        # Real materializer and upsert builder; only the D1 transport is left out.
        calls["apply"].extend(datasets)
        outputs = materialize_finlab_canonical_outputs(manifest["artifact_root"], run_id=manifest["run_id"],
            generated_at=manifest["generated_at"], start_date=start_date, end_date=end_date, datasets=datasets,
            include_emerging=False)
        calls["chip_rows"].extend(outputs.canonical_chip_daily)
        statements = [s for s in build_d1_upsert_statements(outputs) if "canonical_chip_daily" in s[0]]
        rows = len(outputs.canonical_chip_daily)
        return {"apply_result": {"total": len(statements), "success_count": len(statements), "error_count": 0,
                                 "changes_total": rows}, "statement_count": len(statements),
                "row_counts": {"canonical_chip_daily": rows}}

    monkeypatch.setattr(daily_inference_producer, "produce_daily_inference_composition", fake_produce)
    monkeypatch.setattr(daily_inference_producer, "publish_daily_inference_head",
                        lambda *a, **k: calls.__setitem__("publish", calls["publish"] + 1))
    monkeypatch.setattr(tool, "materialize_specs", fake_specs)
    monkeypatch.setattr(tool, "materialize_canonical_to_d1", fake_apply)
    monkeypatch.setattr(daily_history_capture, "load_daily_history", lambda *a, **k: {})
    monkeypatch.setattr(storage, "Client", lambda: type("Client", (), {"bucket": lambda self, _: object()})())
    def fake_upload(local_dir, **kwargs):
        calls["upload"] += 1
        return {"objects": 0}

    def fake_key_report(manifest, **kwargs):
        calls["key_report"] += 1
        return {"status": "ok", "rows": len(manifest["source_key_reports"])}

    monkeypatch.setattr(tool, "upload_dir_to_gcs", fake_upload)
    monkeypatch.setattr(tool, "insert_source_key_report", fake_key_report)
    monkeypatch.setattr(tool, "insert_d1_summary", lambda manifest: calls.__setitem__("d1", calls["d1"] + 1))
    monkeypatch.setattr(tool, "insert_finlab_runtime_tables", lambda manifest: {})
    monkeypatch.setenv("FINLAB_KEY_REPORT_ENABLED", "true")
    for name in ("FINLAB_API_KEY", "CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DB_ID"):
        monkeypatch.setenv(name, "offline-fixture")
    monkeypatch.setattr(sys, "argv", [
        "tool", "--years", "3", "--run-id", "late-lane", "--output-dir", str(tmp_path / "out"), "--daily-refresh",
        "--gcs-bucket", "test", "--source-end-date", TARGET, *(["--write-d1"] if write_d1 else []),
        *(apply_args if apply_args is not None else [
            "--apply-canonical-d1", "--canonical-datasets", "canonical_chip_daily"]),
        "--canonical-start-date", PRIOR, "--canonical-end-date", TARGET, *extra_args])
    return tool, calls


def target_rows(calls):
    return [row for row in calls["chip_rows"] if row["date"] == TARGET]


def test_composition_skipped_for_other_lane_reports_late_lane_not_ready(monkeypatch, tmp_path):
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[DAILY_PRICE_BLOCKER], late="missing")
    with pytest.raises(ValueError, match=r"^finlab_source_not_ready ") as raised:
        tool.main()
    message = str(raised.value)
    assert "lane=chip_diversity" in message and "fields=margin_balance,short_balance" in message
    assert f"target_date={TARGET}" in message and f"latest={PRIOR}" in message
    assert "composition_blocked_lanes=daily_price" in message
    # Worker (finlabSourceContract.ts classifyFinLabLateLaneNotReady + updateOrchestrator.ts gating) reads it as
    # the late-lane retry, not as a partial failure.
    head = f"{type(raised.value).__name__}: {message}"
    assert re.search(r"\bfinlab_source_not_ready\b", head) and not WORKER_PARTIAL_FAILURE.search(head)
    assert calls["apply"] == [] and calls["chip_rows"] == []
    assert calls["produce"] == 0 and calls["publish"] == 0


@pytest.mark.parametrize("blocker", [{k: v for k, v in DAILY_PRICE_BLOCKER.items() if k != "lane"},
                                     {**DAILY_PRICE_BLOCKER, "lane": "broker_flow_diversity"}],
                         ids=["no_lane", "broker_lane"])
def test_any_unsealable_blocker_with_late_lane_missing_is_not_ready(monkeypatch, tmp_path, blocker):
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[blocker], late="missing")
    with pytest.raises(ValueError, match=r"^finlab_source_not_ready "):
        tool.main()
    assert calls["apply"] == [] and calls["produce"] == 0


def test_composition_skipped_with_late_lane_published_still_applies_unchanged(monkeypatch, tmp_path):
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[DAILY_PRICE_BLOCKER], late="published")
    assert tool.main() == 2
    manifest = json.loads((tmp_path / "out" / "late-lane" / "manifest.json").read_bytes())
    assert manifest["backfill_status"] == "partial_failed" and calls["produce"] == 0
    assert calls["apply"] == ["canonical_chip_daily"]
    assert {(r["stock_id"], r["margin_balance"], r["short_balance"]) for r in target_rows(calls)} == {
        ("2330", 11.0, 11.0), ("2317", 21.0, 21.0)}


def test_partial_late_publication_stays_report_only(monkeypatch, tmp_path):
    """Policy (i) is unchanged: a target row with some published values is not blocked here."""
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[DAILY_PRICE_BLOCKER], late="partial")
    assert tool.main() == 2
    assert calls["apply"] == ["canonical_chip_daily"]
    assert {r["stock_id"]: r["margin_balance"] for r in target_rows(calls)} == {"2330": 11.0, "2317": None}


def test_chip_lane_blocked_itself_keeps_existing_blocked_apply(monkeypatch, tmp_path):
    """The chip apply is already blocked, so no NULL margin is written and nothing changes."""
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[CHIP_BLOCKER], late="missing")
    assert tool.main() == 2
    manifest = json.loads((tmp_path / "out" / "late-lane" / "manifest.json").read_bytes())
    assert manifest["blocked_datasets"] == ["canonical_chip_daily"] and calls["apply"] == []


@pytest.mark.parametrize("blockers", [[], [REGIME_BLOCKER]], ids=["no_blocker", "sealable_blocker"])
def test_segment_a_composition_still_owns_late_lane_error(monkeypatch, tmp_path, blockers):
    """Composition runs (segment A): its own daily_composition_market_dates_missing error is unchanged."""
    error = "daily_composition_market_dates_missing:margin_balance,short_balance"
    tool, calls = run_main(monkeypatch, tmp_path, blockers=blockers, late="missing", produce_error=error)
    with pytest.raises(ValueError, match="^" + error + "$"):
        tool.main()
    assert calls["produce"] == 1 and calls["apply"] == [] and calls["publish"] == 0


def test_normal_run_with_late_lane_published_produces_and_applies(monkeypatch, tmp_path):
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[], late="published")
    assert tool.main() == 0
    assert calls["produce"] == 1 and calls["publish"] == 1 and calls["apply"] == ["canonical_chip_daily"]
    assert all(r["margin_balance"] is not None for r in target_rows(calls))


def test_not_ready_reason_names_only_unblocked_late_lanes():
    tool = _load_tool_module()
    report = {"lane": "chip_diversity", "field": "margin_balance", "status": "missing_target_date",
              "target_date": TARGET, "latest_date": PRIOR}
    assert tool.late_publication_not_ready([report], [DAILY_PRICE_BLOCKER]).startswith("finlab_source_not_ready ")
    assert tool.late_publication_not_ready([report], [CHIP_BLOCKER]) is None
    assert tool.late_publication_not_ready([{**report, "status": "ok"}], [DAILY_PRICE_BLOCKER]) is None
    assert tool.late_publication_not_ready([{**report, "field": "foreign_net"}], [DAILY_PRICE_BLOCKER]) is None


# B-1: a margin/short fetch that raised (non-quota) leaves a failed / schema_mismatch report and no blocker. The
# chip upsert sets every column from excluded, so applying would NULL the whole window's margin/short.
@pytest.mark.parametrize("late", ["failed", "schema_mismatch", "absent"])
def test_late_fetch_not_ok_raises_before_any_write(monkeypatch, tmp_path, late):
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[DAILY_PRICE_BLOCKER], late=late, write_d1=True)
    with pytest.raises(ValueError, match=r"^finlab_source_not_ready ") as raised:
        tool.main()
    message = str(raised.value)
    assert "lane=chip_diversity" in message and "fields=margin_balance,short_balance" in message
    assert f"statuses={'no_report' if late == 'absent' else late}" in message
    assert not WORKER_PARTIAL_FAILURE.search(f"{type(raised.value).__name__}: {message}")
    assert calls["apply"] == [] and calls["chip_rows"] == []
    assert calls["upload"] == 0 and calls["key_report"] == 0 and calls["d1"] == 0
    assert calls["produce"] == 0 and calls["publish"] == 0


def test_failed_margin_probe_no_longer_nulls_prior_days(monkeypatch, tmp_path):
    """The review probe: before the fix main() returned 2 and upserted PRIOR and TARGET with NULL margin/short."""
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[DAILY_PRICE_BLOCKER], late="failed")
    with pytest.raises(ValueError, match=r"^finlab_source_not_ready "):
        tool.main()
    assert not [row for row in calls["chip_rows"] if row.get("margin_balance") is None]
    assert calls["apply"] == []


@pytest.mark.parametrize("late", ["failed", "missing"])
def test_chip_lane_blocked_itself_with_late_fetch_not_ok_keeps_blocked_apply(monkeypatch, tmp_path, late):
    """Holiday / no-session shape: the chip lane carries its own blocker, its apply is blocked, no late verdict."""
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[CHIP_BLOCKER], late=late, write_d1=True)
    assert tool.main() == 2
    manifest = json.loads((tmp_path / "out" / "late-lane" / "manifest.json").read_bytes())
    assert manifest["blocked_datasets"] == ["canonical_chip_daily"] and calls["apply"] == []
    assert calls["key_report"] == 1 and calls["upload"] == 2


# B-3: the verdict is scoped to runs that will upsert canonical_chip_daily.
@pytest.mark.parametrize("apply_args", [[], ["--apply-canonical-d1", "--canonical-datasets", "canonical_market_daily"],
                                        ["--apply-canonical-d1", "--canonical-datasets", "canonical_chip_daily",
                                         "--canonical-dry-run"]],
                         ids=["no_apply", "chip_not_requested", "dry_run"])
@pytest.mark.parametrize("late", ["missing", "failed"])
def test_no_chip_write_keeps_partial_failed_without_late_verdict(monkeypatch, tmp_path, apply_args, late):
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[DAILY_PRICE_BLOCKER], late=late, apply_args=apply_args)
    if apply_args and "canonical_market_daily" in apply_args:
        monkeypatch.setattr(tool, "materialize_canonical_to_d1", lambda manifest, *, datasets, **kwargs: {
            "apply_result": {"total": 0, "success_count": 0, "error_count": 0, "changes_total": 0},
            "statement_count": 0, "row_counts": {}})
    if "--canonical-dry-run" in apply_args:
        monkeypatch.setattr(tool, "validate_canonical_apply_result", lambda *a, **k: None)
    assert tool.main() == 2
    manifest = json.loads((tmp_path / "out" / "late-lane" / "manifest.json").read_bytes())
    assert manifest["backfill_status"] == "partial_failed" and calls["produce"] == 0
    assert "canonical_chip_daily" not in (manifest.get("materialized_datasets") or []) or "--canonical-dry-run" in apply_args


def test_fields_to_write_follows_scope_and_blockers():
    tool = _load_tool_module()
    chip = ["canonical_chip_daily"]
    late = {"chip_diversity": ["margin_balance", "short_balance"]}
    assert tool.late_publication_fields_to_write(requested_lanes=[], key_scope={}, canonical_datasets=chip,
                                                 blockers=[DAILY_PRICE_BLOCKER]) == late
    assert tool.late_publication_fields_to_write(requested_lanes=[], key_scope={}, canonical_datasets=chip,
                                                 blockers=[CHIP_BLOCKER]) == {}
    assert tool.late_publication_fields_to_write(requested_lanes=["daily_price"], key_scope={},
                                                 canonical_datasets=chip, blockers=[]) == {}
    # Key scope never narrows the check: the chip upsert writes margin and short whatever was fetched.
    for scope in ({"margin_balance"}, {"foreign_net"}):
        assert tool.late_publication_fields_to_write(requested_lanes=["chip_diversity"],
                                                     key_scope={"chip_diversity": scope},
                                                     canonical_datasets=chip, blockers=[]) == late
    assert tool.late_publication_fields_to_write(requested_lanes=["daily_price"], key_scope={"daily_price": {"close"}},
                                                 canonical_datasets=chip, blockers=[]) == {}
    assert tool.late_publication_fields_to_write(requested_lanes=[], key_scope={}, canonical_datasets=(),
                                                 blockers=[]) == {}


def test_empty_late_fields_on_target_only_window_raise(monkeypatch, tmp_path):
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[DAILY_PRICE_BLOCKER], late="empty", write_d1=True)
    with pytest.raises(ValueError, match=r"^finlab_source_not_ready .*statuses=empty "):
        tool.main()
    assert calls["apply"] == [] and calls["upload"] == 0 and calls["key_report"] == 0


def test_key_scoped_chip_retry_without_late_artifacts_raises(monkeypatch, tmp_path):
    """Worker key-level retry scopes chip to foreign_net; margin/short neither fetched nor reused must not be
    upserted as NULL."""
    scope = json.dumps({"chip_diversity": ["foreign_net"], "daily_price": ["close"]})
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[DAILY_PRICE_BLOCKER], late="absent", write_d1=True,
                           extra_args=["--key-scope-json", scope])
    with pytest.raises(ValueError, match=r"^finlab_source_not_ready .*fields=margin_balance,short_balance") as raised:
        tool.main()
    assert f"target_date={TARGET}" in str(raised.value) and "statuses=no_report" in str(raised.value)
    assert calls["apply"] == [] and calls["upload"] == 0 and calls["key_report"] == 0


@pytest.mark.parametrize("status", ["ok", "skipped_reused"])
def test_worker_chip_retry_scope_with_late_fields_ready_passes_and_applies(monkeypatch, tmp_path, status):
    """The Worker's chip retry scope now carries margin/short (updateOrchestrator withLatePublicationFields);
    once they are fetched (ok) or reused (skipped_reused) for the target date the guard lets the apply through."""
    scope = json.dumps([{"lane": "chip_diversity", "fields": ["foreign_net", *LATE_FIELDS]},
                        {"lane": "daily_price", "fields": ["close"]}])
    tool, calls = run_main(monkeypatch, tmp_path, blockers=[DAILY_PRICE_BLOCKER], late="published", write_d1=True,
                           extra_args=["--key-scope-json", scope])
    if status != "ok":
        original = tool.materialize_specs

        def reused_specs(**kwargs):
            summaries, diffs, reports, blockers = original(**kwargs)
            return summaries, diffs, [{**r, "status": status} if r["field"] in LATE_FIELDS else r for r in reports], blockers

        monkeypatch.setattr(tool, "materialize_specs", reused_specs)
    assert tool.main() == 2
    manifest = json.loads((tmp_path / "out" / "late-lane" / "manifest.json").read_bytes())
    assert manifest["key_scope"]["chip_diversity"] == ["foreign_net", *LATE_FIELDS]
    assert calls["apply"] == ["canonical_chip_daily"] and calls["key_report"] == 1
    assert {(r["stock_id"], r["margin_balance"], r["short_balance"]) for r in target_rows(calls)} == {
        ("2330", 11.0, 11.0), ("2317", 21.0, 21.0)}


def real_chip_specs(monkeypatch, tmp_path, *, ready, fetchable):
    """Real materialize_specs for chip_diversity with a fake FinLab SDK and prior ok artifacts for `ready`."""
    from types import SimpleNamespace
    tool = _load_tool_module()
    chip = next(spec for spec in tool.CORE_SPECS if spec.lane == "chip_diversity")
    frame = wide([PRIOR, TARGET], {str(symbol): [1.0, 2.0] for symbol in range(3000, 3010)})
    store = tmp_path / "prior-run"
    store.mkdir()
    rows = {}
    for field in ready:
        path = store / f"{field}.parquet"
        tool.write_parquet(path, frame)
        rows[field] = {"field": field, "api_key": chip.keys[field], "status": "ok", "rows": 20, "target_rows": 10,
                       "latest_date": TARGET, "artifact_uri": None, "artifact_path": str(path),
                       "artifact_checksum": tool.file_sha256(path), "last_run_id": "prior-run"}
    fetched = []

    def get(key):
        fetched.append(key)
        if any(chip.keys[field] == key for field in fetchable):
            return frame.copy()
        raise AssertionError("unexpected FinLab fetch: " + key)

    monkeypatch.setitem(sys.modules, "finlab", SimpleNamespace(data=SimpleNamespace(get=get), login=lambda *a, **k: None))
    monkeypatch.setattr(tool, "login_finlab_sdk", lambda login: None)
    monkeypatch.setattr(tool, "d1_counts", lambda start: {})
    monkeypatch.setattr(tool.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(tool, "read_ready_source_key_artifacts",
                        lambda *, target_date, lane, fields: {f: rows[f] for f in fields if f in rows})

    def run(scope):
        _, _, reports, blockers = tool.materialize_specs(
            years=3, run_dir=tmp_path / "run", lanes=["chip_diversity"], key_scope={"chip_diversity": set(scope)},
            source_start_date=TARGET, source_end_date=TARGET, daily_refresh=True, reuse_successful_artifacts=True)
        return {r["field"]: r["status"] for r in reports if r["field"] in {"foreign_net", *LATE_FIELDS}}, blockers
    return run, fetched


WORKER_CHIP_SCOPE = ("foreign_net", *LATE_FIELDS)


@pytest.mark.parametrize("ready,fetchable", [(("foreign_net", *LATE_FIELDS), ()), (LATE_FIELDS, ("foreign_net",))],
                         ids=["all_ready", "foreign_net_refetch"])
def test_worker_chip_scope_reuses_ready_late_fields_without_training_aux_crash(monkeypatch, tmp_path, ready, fetchable):
    """Verifier Blocker: a reused late field is the clipped daily tail, not a full vendor window, so the training
    auxiliary vintage must not request it (training_auxiliary_source_missing before the fix)."""
    run, fetched = real_chip_specs(monkeypatch, tmp_path, ready=ready, fetchable=fetchable)
    statuses, blockers = run(WORKER_CHIP_SCOPE)
    assert {field: statuses[field] for field in LATE_FIELDS} == {f: "skipped_reused" for f in LATE_FIELDS}
    assert blockers == []
    tool = _load_tool_module()
    chip = next(spec for spec in tool.CORE_SPECS if spec.lane == "chip_diversity")
    assert fetched == [chip.keys[field] for field in fetchable]


def test_worker_chip_scope_fetches_only_the_late_fields_not_yet_ready(monkeypatch, tmp_path):
    run, fetched = real_chip_specs(monkeypatch, tmp_path, ready=("foreign_net",), fetchable=LATE_FIELDS)
    statuses, blockers = run(WORKER_CHIP_SCOPE)
    assert statuses == {"foreign_net": "skipped_reused", "margin_balance": "ok", "short_balance": "ok"}
    assert len(fetched) == 2 and blockers == []
