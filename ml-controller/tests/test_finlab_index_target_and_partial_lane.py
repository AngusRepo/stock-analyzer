"""Daily refresh: official index target-date gate and lane-only composition reuse."""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

from test_finlab_remote_backfill_tool_contract import ROOT, TOOL_PATH, _load_tool_module

TARGET = "2026-10-29"
TWSE_TARGET = {"stat": "OK", "data": [["115/10/28", "1", "1", "1", "22000"], ["115/10/29", "1", "1", "1", "22100"]]}
TPEX_TARGET = [{"Date": "1151029", "Close": "250.10"}]
TPEX_PREVIOUS = [{"Date": "1151028", "Close": "249.00"}]


def run_regime(monkeypatch, tmp_path, *, tpex, twse=None, daily_refresh=True, today=TARGET):
    tool = _load_tool_module()
    tpex_bodies, twse_bodies = list(tpex), list(twse or [TWSE_TARGET] * 3)
    calls = {"tpex": 0, "twse": 0, "sleep": [], "urls": []}

    def official(url, *, label, timeout=30.0):
        name = "tpex" if "tpex_index" in url else "twse"
        calls[name] += 1
        calls["urls"].append(url)
        bodies = tpex_bodies if name == "tpex" else twse_bodies
        return bodies.pop(0) if len(bodies) > 1 else bodies[0]

    monkeypatch.setitem(sys.modules, "finlab", SimpleNamespace(data=SimpleNamespace(get=lambda key: pytest.fail(key)), login=lambda: None))
    monkeypatch.setattr(tool, "login_finlab_sdk", lambda login: None)
    monkeypatch.setattr(tool, "d1_counts", lambda start: {})
    monkeypatch.setattr(tool, "official_json_get", official)
    monkeypatch.setattr(tool, "taipei_today", lambda: today)
    monkeypatch.setattr(tool.time, "sleep", lambda seconds: calls["sleep"].append(seconds))
    _, _, reports, blockers = tool.materialize_specs(
        years=3, run_dir=tmp_path, lanes=["regime_context"], source_start_date=TARGET, source_end_date=TARGET,
        daily_refresh=daily_refresh, key_scope={"regime_context": {"official_tpex_index"}})
    official_reports = {row["field"]: row for row in reports if row["field"].startswith("official_")}
    return tool, official_reports, blockers, calls


@pytest.mark.parametrize("bodies", [[None], [{"message": "not a list"}], [TPEX_PREVIOUS]],
                         ids=["none", "non_list", "previous_day_only"])
def test_daily_refresh_tpex_without_target_row_blocks_as_not_ready(monkeypatch, tmp_path, bodies):
    tool, reports, blockers, calls = run_regime(monkeypatch, tmp_path, tpex=bodies)
    latest = "2026-10-28" if bodies == [TPEX_PREVIOUS] else None
    assert blockers == [{"lane": "regime_context", "kind": "official_index", "reason": "official_index_target_date_missing",
                         "field": "official_tpex_index", "target_date": TARGET, "latest_date": latest, "attempts": 3}]
    row = reports["official_tpex_index"]
    # Worker late-lane contract: required contract field, not-ready status, same lane/target date.
    assert (row["lane"], row["status"], row["target_date"], row["required"]) == ("regime_context", "missing_target_date", TARGET, True)
    assert row["latest_date"] == latest and row["target_rows"] == 0 and row["artifact_path"] is None
    assert row["status"] in tool.FINLAB_SOURCE_CONTRACT["statuses"]
    assert "official_tpex_index" in tool.FINLAB_SOURCE_CONTRACT["lanes"]["regime_context"]["required_fields"]
    assert not (tmp_path / "raw/regime_context/official_tpex_index.parquet").exists()
    assert calls["tpex"] == 3 and calls["sleep"] == [2.0, 5.0]
    assert reports["official_twse_index"]["status"] == "ok" and reports["official_twse_index"]["target_rows"] == 1


def test_gated_twse_queries_target_month_after_month_rollover(monkeypatch, tmp_path):
    twse = {"stat": "OK", "data": [["115/10/28", "1", "1", "1", "22000"], ["115/10/29", "1", "1", "1", "22100"]]}
    _, reports, blockers, calls = run_regime(monkeypatch, tmp_path, tpex=[TPEX_TARGET], twse=[twse], today="2026-11-02")
    assert blockers == [] and reports["official_twse_index"]["status"] == "ok"
    assert any("MI_5MINS_HIST?date=20261029" in url for url in calls["urls"])


@pytest.mark.parametrize("row", [{"Close": "250.10"}, {"Date": "not-a-date", "Close": "250.10"}], ids=["no_date", "bad_date"])
def test_gated_tpex_row_without_parseable_date_is_not_stamped_as_target(monkeypatch, tmp_path, row):
    _, reports, blockers, _ = run_regime(monkeypatch, tmp_path, tpex=[[row]])
    assert [b["field"] for b in blockers] == ["official_tpex_index"]
    assert reports["official_tpex_index"]["status"] == "missing_target_date"
    assert not (tmp_path / "raw/regime_context/official_tpex_index.parquet").exists()


@pytest.mark.parametrize("row", [["", "1", "1", "1", "22100"], ["not-a-date", "1", "1", "1", "22100"]], ids=["no_date", "bad_date"])
def test_gated_twse_row_without_parseable_date_is_not_stamped_as_target(monkeypatch, tmp_path, row):
    _, reports, blockers, _ = run_regime(monkeypatch, tmp_path, tpex=[TPEX_TARGET], twse=[{"stat": "OK", "data": [row]}])
    assert [b["field"] for b in blockers] == ["official_twse_index"]
    assert reports["official_twse_index"]["status"] == "missing_target_date"


def test_daily_refresh_twse_without_target_row_also_blocks(monkeypatch, tmp_path):
    _, reports, blockers, _ = run_regime(monkeypatch, tmp_path, tpex=[TPEX_TARGET], twse=[None])
    assert [(b["field"], b["reason"]) for b in blockers] == [("official_twse_index", "official_index_target_date_missing")]
    assert reports["official_twse_index"]["status"] == "missing_target_date"
    assert not (tmp_path / "raw/regime_context/official_twse_index.parquet").exists()
    assert reports["official_tpex_index"]["status"] == "ok"


def test_daily_refresh_tpex_second_attempt_succeeds_without_blocker(monkeypatch, tmp_path):
    _, reports, blockers, calls = run_regime(monkeypatch, tmp_path, tpex=[None, TPEX_TARGET])
    assert blockers == []
    assert calls["tpex"] == 2 and calls["sleep"] == [2.0]
    row = reports["official_tpex_index"]
    assert (row["status"], row["target_rows"], row["latest_date"], row["source"]) == ("ok", 1, TARGET, "official")
    assert row["artifact_checksum"].startswith("sha256:")
    frame = pd.read_parquet(tmp_path / "raw/regime_context/official_tpex_index.parquet")
    assert frame["date"].tolist() == [TARGET]


@pytest.mark.parametrize("bodies, written", [([None], False), ([TPEX_PREVIOUS], True)], ids=["none", "previous_day"])
def test_non_daily_refresh_keeps_single_fetch_and_no_index_gate(monkeypatch, tmp_path, bodies, written):
    _, reports, blockers, calls = run_regime(monkeypatch, tmp_path, tpex=bodies, daily_refresh=False)
    assert blockers == [] and reports == {}
    assert calls["tpex"] == 1 and calls["twse"] == 1 and calls["sleep"] == []
    assert (tmp_path / "raw/regime_context/official_tpex_index.parquet").exists() is written


# ---- lane-only repair: composition inputs ----

COMPOSITION_DIRS = ("daily_price_full_vintage", "training_auxiliary_full_vintage", "training_long_full_vintage")


def _functions_touching_composition_dirs() -> set[str]:
    """Functions (tool + services) that name a composition dir directly, through a module-level
    constant, through a same-file call, or through a cross-file call of a uniquely defined function."""
    owners, edges, direct = {}, set(), set()
    mentions = lambda node, names: any(
        (isinstance(sub, ast.Constant) and isinstance(sub.value, str) and any(d in sub.value for d in COMPOSITION_DIRS))
        or (isinstance(sub, ast.Name) and sub.id in names) for sub in ast.walk(node))
    parsed = []
    for path in [TOOL_PATH, *sorted((ROOT / "ml-controller/services").glob("*.py"))]:
        tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        constants = {target.id for node in tree.body if isinstance(node, (ast.Assign, ast.AnnAssign))
                     for target in (node.targets if isinstance(node, ast.Assign) else [node.target])
                     if isinstance(target, ast.Name) and node.value is not None and mentions(node.value, set())}
        funcs = [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)]
        parsed.append((path, funcs))
        for node in funcs:
            owners.setdefault(node.name, set()).add(path)
            if mentions(node, constants):
                direct.add((path, node.name))
    local = {(path, node.name) for path, funcs in parsed for node in funcs}
    for path, funcs in parsed:
        for node in funcs:
            for sub in ast.walk(node):
                if not isinstance(sub, ast.Call):
                    continue
                name = sub.func.id if isinstance(sub.func, ast.Name) else getattr(sub.func, "attr", "")
                if (path, name) in local:
                    edges.add(((path, node.name), (path, name)))
                elif isinstance(sub.func, ast.Name) and len(owners.get(name, ())) == 1:
                    edges.add(((path, node.name), (next(iter(owners[name])), name)))
    changed = True
    while changed:
        grown = {caller for caller, callee in edges if callee in direct} - direct
        changed, direct = bool(grown), direct | grown
    return {name for _, name in direct} - {"materialize_specs", "main"}


def _lane_guards(tool, node_path) -> set[str] | None:
    lanes = None
    by_kind = lambda kind: {spec.lane for spec in tool.CORE_SPECS if spec.kind == kind}
    for parent, child in zip(node_path, node_path[1:]):
        if not isinstance(parent, ast.If) or child not in parent.body:
            continue
        if any(isinstance(n, (ast.BoolOp, ast.UnaryOp)) and isinstance(n.op, (ast.Or, ast.Not)) for n in ast.walk(parent.test)):
            continue  # an "or"/"not" guard never narrows the lanes that can reach the write
        for cmp in [n for n in ast.walk(parent.test) if isinstance(n, ast.Compare)]:
            attr = cmp.left.attr if isinstance(cmp.left, ast.Attribute) else None
            right = cmp.comparators[0]
            if attr == "lane" and isinstance(cmp.ops[0], ast.Eq) and isinstance(right, ast.Constant):
                found = {right.value}
            elif attr == "lane" and isinstance(cmp.ops[0], ast.In) and isinstance(right, ast.Name):
                found = set(getattr(tool, right.id))
            elif attr == "kind" and isinstance(cmp.ops[0], ast.Eq) and isinstance(right, ast.Constant):
                found = by_kind(right.value)
            else:
                continue
            lanes = found if lanes is None else lanes & found
    return lanes


def test_composition_input_lanes_cover_every_lane_that_writes_composition_dirs():
    tool = _load_tool_module()
    writers = _functions_touching_composition_dirs()
    assert {"write_adjusted_price_vintage", "write_training_auxiliary_vintage", "write_broker_capture",
            "write_holding_capture"} <= writers
    tree = ast.parse(TOOL_PATH.read_text(encoding="utf-8-sig"))
    root = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "materialize_specs")
    derived: set[str] = set()
    sites = 0

    def visit(node, path):
        nonlocal sites
        path = [*path, node]
        hit = (isinstance(node, ast.Call) and (getattr(node.func, "id", None) or getattr(node.func, "attr", None)) in writers) or (
            isinstance(node, ast.Constant) and isinstance(node.value, str) and any(d in node.value for d in COMPOSITION_DIRS))
        if hit:
            sites += 1
            lanes = _lane_guards(tool, path)
            assert lanes, f"unguarded composition-dir write at line {node.lineno}"
            derived.update(lanes)
        for child in ast.iter_child_nodes(node):
            visit(child, path)

    visit(root, [])
    assert sites >= 5
    assert derived == set(tool.COMPOSITION_INPUT_LANES)


# ---- lane-only repair: main() composition decision ----

def sealed_head(tmp_path):
    from test_daily_inference_producer import Bucket, baseline, current_capture, produce, upload
    from services.daily_inference_producer import publish_daily_inference_head
    bucket = Bucket()
    baseline(bucket)
    root, _ = current_capture(tmp_path / "first", "2026-10-13")
    reference = produce(bucket, root, "2026-10-13")
    upload(bucket, root)
    publish_daily_inference_head(bucket, reference)
    return bucket, reference


def run_main(monkeypatch, tmp_path, bucket, *, lanes, key_scope="", blockers=(), extra=(), patch=None, run_id="lane-retry"):
    from google.cloud import storage
    from services import daily_history_capture, daily_inference_producer
    tool = _load_tool_module()
    calls = {"produce": 0, "publish": 0}

    def fake_produce(**kwargs):
        calls["produce"] += 1
        return {"path": "x/inference/manifest.json", "sha256": "a" * 64, "capture_id": "x", "business_date": "2026-10-13"}

    monkeypatch.setattr(daily_inference_producer, "produce_daily_inference_composition", fake_produce)
    monkeypatch.setattr(daily_inference_producer, "publish_daily_inference_head",
                        lambda *a, **k: calls.__setitem__("publish", calls["publish"] + 1))
    monkeypatch.setattr(tool, "materialize_specs", lambda **kwargs: ([], [], [], [dict(b) for b in blockers]))
    monkeypatch.setattr(daily_history_capture, "load_daily_history", lambda *a, **k: {})
    monkeypatch.setattr(storage, "Client", lambda: type("Client", (), {"bucket": lambda self, _: bucket})())
    monkeypatch.setattr(tool, "upload_dir_to_gcs", lambda local_dir, **kwargs: {"objects": 0})
    for name in ("FINLAB_API_KEY", "CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DB_ID"):
        monkeypatch.setenv(name, "offline-fixture")
    argv = ["tool", "--years", "3", "--run-id", run_id, "--output-dir", str(tmp_path / "out"), "--daily-refresh",
            "--gcs-bucket", "test", "--source-end-date", "2026-10-13"] + (["--lanes", ",".join(lanes)] if lanes else [])
    if key_scope:
        argv += ["--key-scope-json", key_scope]
    argv += list(extra)
    if patch:
        patch(tool)
    monkeypatch.setattr(sys, "argv", argv)
    code = tool.main()
    manifest = json.loads((tmp_path / "out" / run_id / "manifest.json").read_bytes())
    return tool, code, manifest, calls


def test_regime_only_repair_reuses_sealed_head_without_republish(monkeypatch, tmp_path):
    from services.daily_inference_producer import HEAD_PREFIX
    bucket, reference = sealed_head(tmp_path)
    head = bucket.files[HEAD_PREFIX + "2026-10-13.json"]
    _, code, manifest, calls = run_main(monkeypatch, tmp_path, bucket, lanes=["regime_context"],
                                        run_id=reference["capture_id"])
    assert code == 0 and manifest["backfill_status"] == "ready" and manifest["source_key_blockers"] == []
    assert manifest["inference_composition"] == {"status": "reused_sealed_head", "business_date": "2026-10-13",
        "capture_id": reference["capture_id"], "path": reference["path"], "sha256": reference["sha256"]}
    assert calls == {"produce": 0, "publish": 0}
    assert bucket.files[HEAD_PREFIX + "2026-10-13.json"] == head


def test_regime_only_repair_without_head_fails_closed(monkeypatch, tmp_path):
    from test_daily_inference_producer import Bucket
    bucket = Bucket()
    tool, code, manifest, calls = run_main(monkeypatch, tmp_path, bucket, lanes=["regime_context"])
    assert code == 2 and manifest["backfill_status"] == "partial_failed"
    blockers = manifest["source_key_blockers"]
    assert [(b["lane"], b["reason"]) for b in blockers] == [("regime_context", "daily_inference_composition_requires_full_capture")]
    # The repaired lane's canonical apply stays blocked, so readiness cannot pass without a sealed composition.
    assert {"canonical_market_index_daily", "canonical_futures_daily", "canonical_regime_context_daily"} <= \
        tool.canonical_datasets_for_source_key_blockers(blockers)
    assert "inference_composition" not in manifest
    assert calls == {"produce": 0, "publish": 0} and bucket.files == {}


@pytest.mark.parametrize("corruption", ["auxiliary_bytes", "head_date", "identity"])
def test_regime_only_repair_with_invalid_head_fails_closed(monkeypatch, tmp_path, corruption):
    import hashlib
    from services.daily_inference_producer import HEAD_PREFIX
    bucket, reference = sealed_head(tmp_path)
    value = json.loads(bucket.files[reference["path"]])
    if corruption == "auxiliary_bytes":
        bucket.files[value["auxiliary"]["pe"]["path"]] = b"changed"
    elif corruption == "identity":
        # Checksums stay consistent; only validate_composition can reject this head.
        raw = json.dumps({**value, "training_admitted": True}).encode()
        bucket.files[reference["path"]] = raw
        head = json.loads(bucket.files[HEAD_PREFIX + "2026-10-13.json"])
        bucket.files[HEAD_PREFIX + "2026-10-13.json"] = json.dumps(
            {**head, "sha256": hashlib.sha256(raw).hexdigest()}).encode()
    else:
        head = json.loads(bucket.files[HEAD_PREFIX + "2026-10-13.json"])
        bucket.files[HEAD_PREFIX + "2026-10-13.json"] = json.dumps({**head, "business_date": "2026-10-12"}).encode()
    _, code, manifest, calls = run_main(monkeypatch, tmp_path, bucket, lanes=["regime_context"],
                                        run_id=reference["capture_id"])
    assert code == 2 and manifest["backfill_status"] == "partial_failed"
    assert manifest["source_key_blockers"][0]["reason"] == "daily_inference_composition_requires_full_capture"
    assert calls == {"produce": 0, "publish": 0}


def test_mixed_lanes_with_composition_input_always_produce(monkeypatch, tmp_path):
    bucket, _ = sealed_head(tmp_path)
    _, code, manifest, calls = run_main(monkeypatch, tmp_path, bucket, lanes=["regime_context", "daily_price"])
    assert calls["produce"] == 1 and manifest["inference_composition"].get("status") != "reused_sealed_head"


def test_key_scope_lane_counts_toward_composition_inputs(monkeypatch, tmp_path):
    bucket, _ = sealed_head(tmp_path)
    _, _, _, calls = run_main(monkeypatch, tmp_path, bucket, lanes=["regime_context"],
                              key_scope='{"daily_price": ["close"]}')
    assert calls["produce"] == 1


@pytest.mark.parametrize("lane", sorted(_load_tool_module().COMPOSITION_INPUT_LANES))
def test_each_composition_input_lane_alone_never_skips_production(monkeypatch, tmp_path, lane):
    bucket, _ = sealed_head(tmp_path)
    _, _, manifest, calls = run_main(monkeypatch, tmp_path, bucket, lanes=[lane])
    assert calls["produce"] == 1
    assert manifest["inference_composition"].get("status") != "reused_sealed_head"


# ---- seal composition when every blocker is on a non-input lane ----

REGIME_BLOCKER = {"lane": "regime_context", "kind": "official_index", "reason": "official_index_target_date_missing",
                  "field": "official_tpex_index"}


@pytest.mark.parametrize("blockers, failed, allowed", [
    ([], [], True),
    ([REGIME_BLOCKER], [], True),
    ([REGIME_BLOCKER, {**REGIME_BLOCKER, "lane": "market_summary"}], [], True),
    ([{**REGIME_BLOCKER, "lane": "daily_price"}], [], False),
    ([REGIME_BLOCKER, {**REGIME_BLOCKER, "lane": "broker_flow_diversity"}], [], False),
    ([{k: v for k, v in REGIME_BLOCKER.items() if k != "lane"}], [], False),
    ([{**REGIME_BLOCKER, "lane": ""}], [], False),
    ([{**REGIME_BLOCKER, "lane": "not_a_lane"}], [], False),
    (["regime_context"], [], False),
    ([REGIME_BLOCKER], ["canonical_market_daily"], False),
    ([], ["canonical_market_index_daily"], False),
], ids=["none", "regime", "two_non_input", "input", "mixed", "no_lane", "empty_lane", "unknown_lane", "not_dict",
        "canonical_failed", "canonical_failed_no_blocker"])
def test_composition_seal_predicate(blockers, failed, allowed):
    tool = _load_tool_module()
    assert tool.composition_seal_allowed(blockers, failed) is allowed


@pytest.mark.parametrize("lane", sorted(_load_tool_module().COMPOSITION_INPUT_LANES))
def test_each_input_lane_blocker_prevents_seal(lane):
    tool = _load_tool_module()
    assert tool.composition_seal_allowed([{**REGIME_BLOCKER, "lane": lane}]) is False


@pytest.mark.parametrize("blocker", [{**REGIME_BLOCKER, "lane": "daily_price"},
                                     {k: v for k, v in REGIME_BLOCKER.items() if k != "lane"},
                                     {**REGIME_BLOCKER, "lane": "not_a_lane"}], ids=["input_lane", "no_lane", "unknown_lane"])
def test_full_run_with_unsealable_blocker_never_produces_or_publishes(monkeypatch, tmp_path, blocker):
    from test_daily_inference_producer import Bucket
    bucket = Bucket()
    _, code, manifest, calls = run_main(monkeypatch, tmp_path, bucket, lanes=[], blockers=[blocker])
    assert code == 2 and manifest["backfill_status"] == "partial_failed"
    assert calls == {"produce": 0, "publish": 0} and "inference_composition" not in manifest


def test_regime_only_blocker_seals_head_then_lane_retry_reuses_it(monkeypatch, tmp_path):
    """First full run: TPEx missing (regime only) -> partial_failed but head sealed; the regime retry reuses it."""
    from google.cloud import storage
    from services import daily_history_capture, daily_vendor_capture
    from services.daily_inference_producer import HEAD_PREFIX
    from test_daily_inference_producer import Bucket, baseline, current_capture, upload, vendor_factory
    bucket = Bucket()
    baseline(bucket)
    root, _ = current_capture(tmp_path, "2026-10-13")
    for name in ("FINLAB_API_KEY", "CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DB_ID"):
        monkeypatch.setenv(name, "offline-fixture")
    monkeypatch.setattr(daily_history_capture, "load_daily_history", lambda *a, **k: {})
    monkeypatch.setattr(storage, "Client", lambda: type("Client", (), {"bucket": lambda self, _: bucket})())
    monkeypatch.setattr(daily_vendor_capture, "DailyVendorCapture", vendor_factory("2026-10-13"))

    def run(run_id, extra, blockers):
        tool = _load_tool_module()
        monkeypatch.setattr(tool, "materialize_specs", lambda **kwargs: ([], [], [], [dict(b) for b in blockers]))
        monkeypatch.setattr(tool, "upload_dir_to_gcs",
                            lambda local_dir, **kwargs: upload(bucket, local_dir, kwargs["prefix"]) or {"objects": len(bucket.files)})
        monkeypatch.setattr(sys, "argv", ["tool", "--years", "3", "--run-id", run_id, "--output-dir", str(tmp_path),
            "--daily-refresh", "--gcs-bucket", "test", "--source-end-date", "2026-10-13", *extra])
        code = tool.main()
        return code, json.loads((tmp_path / run_id / "manifest.json").read_bytes())

    code, first = run(root.name, [], [REGIME_BLOCKER])
    assert code == 2 and first["backfill_status"] == "partial_failed"
    assert first["inference_composition"]["capture_id"] == root.name
    head = json.loads(bucket.files[HEAD_PREFIX + "2026-10-13.json"])
    assert head["path"] == first["inference_composition"]["path"]

    code, retry = run(root.name, ["--lanes", "regime_context"], [])
    assert code == 0 and retry["backfill_status"] == "ready"
    assert retry["inference_composition"]["status"] == "reused_sealed_head"
    assert retry["inference_composition"]["path"] == head["path"]



def test_canonical_apply_failure_after_produce_never_publishes(monkeypatch, tmp_path):
    from test_daily_inference_producer import Bucket
    seen = {}

    def failed_apply(manifest, **kwargs):
        seen["blockers"] = kwargs.get("source_key_blockers")
        return {"status": "partial_failed", "materialized_datasets": [], "blocked_datasets": [],
                "failed_datasets": ["daily_price_ohlcv"]}

    _, code, manifest, calls = run_main(
        monkeypatch, tmp_path, Bucket(), lanes=[], extra=["--apply-canonical-d1"],
        patch=lambda tool: monkeypatch.setattr(tool, "materialize_canonical_plan_to_d1", failed_apply))
    assert code == 2 and manifest["backfill_status"] == "partial_failed"
    assert manifest["failed_datasets"] == ["daily_price_ohlcv"] and seen["blockers"] == []
    assert calls == {"produce": 1, "publish": 0}


def test_lane_repair_under_new_run_id_never_reuses_another_capture_head(monkeypatch, tmp_path):
    """A new run_id has no price vintage under its prefix; a success callback would break the sequence refresh."""
    bucket, reference = sealed_head(tmp_path)
    assert reference["capture_id"] != "lane-retry"
    _, code, manifest, calls = run_main(monkeypatch, tmp_path, bucket, lanes=["regime_context"])
    assert code == 2 and manifest["backfill_status"] == "partial_failed"
    [blocker] = manifest["source_key_blockers"]
    assert blocker["reason"] == "daily_inference_composition_requires_full_capture"
    assert "daily_composition_head_capture_mismatch" in blocker["error"]
    assert "inference_composition" not in manifest and calls == {"produce": 0, "publish": 0}


def test_regime_blocker_with_blocked_canonical_apply_still_publishes(monkeypatch, tmp_path):
    from test_daily_inference_producer import Bucket
    seen = {}

    def blocked_apply(manifest, **kwargs):
        seen["blockers"] = kwargs.get("source_key_blockers")
        return {"status": "partial_failed", "materialized_datasets": ["canonical_daily_price"],
                "blocked_datasets": ["canonical_regime_context_daily"], "failed_datasets": []}

    _, code, manifest, calls = run_main(
        monkeypatch, tmp_path, Bucket(), lanes=[], blockers=[REGIME_BLOCKER], extra=["--apply-canonical-d1"],
        patch=lambda tool: monkeypatch.setattr(tool, "materialize_canonical_plan_to_d1", blocked_apply))
    assert code == 2 and manifest["backfill_status"] == "partial_failed" and manifest["failed_datasets"] == []
    assert seen["blockers"] == [REGIME_BLOCKER]
    assert calls == {"produce": 1, "publish": 1}


def test_disjoint_multi_lane_repair_blocks_every_scoped_lane(monkeypatch, tmp_path):
    from test_daily_inference_producer import Bucket
    _, code, manifest, calls = run_main(monkeypatch, tmp_path, Bucket(), lanes=["regime_context", "market_summary"])
    assert code == 2 and calls == {"produce": 0, "publish": 0}
    assert sorted((b["lane"], b["reason"], tuple(b["requested_lanes"])) for b in manifest["source_key_blockers"]) == [
        (lane, "daily_inference_composition_requires_full_capture", ("market_summary", "regime_context"))
        for lane in ("market_summary", "regime_context")]
