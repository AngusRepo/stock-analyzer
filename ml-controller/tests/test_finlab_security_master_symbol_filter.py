from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import polars as pl
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_canonical_materializer import (  # noqa: E402
    build_d1_upsert_statements,
    materialize_finlab_canonical_outputs,
)

OBSERVED = "2026-11-20T04:00:00+00:00"
TRIGGER_SQL = (
    "CREATE TRIGGER stocks_listing_capture_conflict BEFORE UPDATE OF listing_observed_at,listing_checksum ON stocks "
    "WHEN NEW.listing_observed_at=OLD.listing_observed_at AND NEW.listing_checksum IS NOT OLD.listing_checksum "
    "BEGIN SELECT RAISE(ABORT,'stocks_listing_capture_conflict'); END"
)


def _write(path: Path, frame: pl.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.write_parquet(path)


def _sha(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _capture(root: Path, run_id: str = "sm-run-01") -> Path:
    raw = root / "raw" / "security_master"
    # FinLab still says rotc for 6467 (moved to TWSE) and 2249 (moved to OTC); 7000 is a true ROTC name.
    _write(raw / "company_basic_info.parquet", pl.DataFrame({
        "symbol": ["2330", "6467", "2249", "7000"],
        "公司簡稱": ["台積電", "泰合", "湧盛", "興櫃甲"],
        "市場別": ["sii", "rotc", "rotc", "rotc"],
        "上市日期": ["1994-09-05", "2026-10-20", None, None],
        "上櫃日期": [None, None, "2026-11-03", None],
        "興櫃日期": [None, "2024-12-30", "2019-12-19", "2025-01-02"],
        "__observed_at": [OBSERVED] * 4,
    }))
    _write(raw / "tw_etf_basic_info.parquet", pl.DataFrame({
        "symbol": ["0050"], "證券簡稱": ["元大台灣50"], "上市日期": ["2003-06-30"],
        "ETF詳情頁": ["https://www.twse.com.tw/zh/ETFortune-institute/etfInfo/0050"],
        "__observed_at": [OBSERVED],
    }))
    # Rosters must clear OFFICIAL_BOARD_MIN_ROWS to arbitrate the venue.
    twse = [str(1000 + i) for i in range(800)] + ["2330", "6467"]
    otc = [str(3000 + i) for i in range(600)] + ["2249"]
    rotc = [str(8000 + i) for i in range(100)] + ["7000"]
    _write(raw / "official_boards.parquet", pl.DataFrame({
        "symbol": twse + otc + rotc,
        "board": ["TWSE"] * len(twse) + ["OTC"] * len(otc) + ["ROTC"] * len(rotc),
    }))
    _write(raw / "table.parquet", pl.DataFrame({"stock_id": ["2330"], "category": ["半導體"]}))
    reports = [
        {"lane": "security_master", "field": field, "artifact_checksum": _sha(raw / name),
         "artifact_uri": f"gs://bucket/finlab/v4/backfill/{run_id}/raw/security_master/{name}"}
        for field, name in (("company_basic_info", "company_basic_info.parquet"),
                            ("tw_etf_basic_info", "tw_etf_basic_info.parquet"),
                            ("table", "table.parquet"))
    ]
    (root / "manifest.json").write_text(json.dumps({"run_id": run_id, "source_key_reports": reports}))
    return root


def _stock_statements(outputs) -> list[tuple[str, list]]:
    return [(sql, params) for sql, params in build_d1_upsert_statements(outputs) if sql.startswith("INSERT INTO stocks")]


def test_default_stocks_materialization_is_unchanged(tmp_path: Path) -> None:
    root = _capture(tmp_path / "sm-run-01")
    outputs = materialize_finlab_canonical_outputs(root, datasets=["stocks"], generated_at=OBSERVED)
    assert [row["symbol"] for row in outputs.security_master] == ["0050", "2249", "2330", "6467", "7000"]
    assert "symbols" not in outputs.manifest["filters"]
    assert "symbol_filter" not in outputs.manifest
    assert len(_stock_statements(outputs)) == 5


def test_symbol_allowlist_restricts_stocks_upsert(tmp_path: Path) -> None:
    root = _capture(tmp_path / "sm-run-01")
    full = materialize_finlab_canonical_outputs(root, datasets=["stocks"], generated_at=OBSERVED)
    scoped = materialize_finlab_canonical_outputs(
        root, datasets=["stocks"], generated_at=OBSERVED, symbols=["6467", " 2249 "])

    rows = {row["symbol"]: row for row in scoped.security_master}
    assert sorted(rows) == ["2249", "6467"]
    # Same normalized rows as the unscoped run, venue arbitration included.
    assert rows == {row["symbol"]: row for row in full.security_master if row["symbol"] in rows}
    assert (rows["6467"]["listing_market"], rows["6467"]["listed_date"]) == ("TWSE", "2026-10-20")
    assert (rows["2249"]["listing_market"], rows["2249"]["listed_date"]) == ("OTC", "2026-11-03")
    assert scoped.manifest["filters"]["symbols"] == ["2249", "6467"]
    assert scoped.manifest["symbol_filter"] == {"requested": 2, "written": 2, "skipped": 3, "source_rows": 5}
    statements = _stock_statements(scoped)
    assert sorted(params[0] for _, params in statements) == ["2249", "6467"]


def test_symbol_allowlist_fails_closed(tmp_path: Path) -> None:
    root = _capture(tmp_path / "sm-run-01")
    with pytest.raises(ValueError, match="finlab_security_master_symbols_missing:9999"):
        materialize_finlab_canonical_outputs(root, datasets=["stocks"], symbols=["6467", "9999"])
    with pytest.raises(ValueError, match="finlab_security_master_symbols_empty"):
        materialize_finlab_canonical_outputs(root, datasets=["stocks"], symbols=[" "])
    with pytest.raises(ValueError, match="finlab_security_master_symbols_require_stocks_only"):
        materialize_finlab_canonical_outputs(root, symbols=["6467"])
    with pytest.raises(ValueError, match="finlab_security_master_symbols_require_stocks_only"):
        materialize_finlab_canonical_outputs(root, datasets=["stocks", "finlab_taxonomy_tags"], symbols=["6467"])
    with pytest.raises(ValueError, match="finlab_security_master_symbols_conflict_with_limit"):
        materialize_finlab_canonical_outputs(root, datasets=["stocks"], symbols=["6467"], limit_per_dataset=10)


def _run_apply_tool(monkeypatch, argv: list[str], core: dict | None = None,
                    drop_core_writes: bool = False) -> tuple[int, dict, dict[str, list]]:
    import tools.finlab_canonical_apply_d1 as apply_tool
    import tools.finlab_v4_remote_backfill as backfill

    core = {} if core is None else core
    writes: dict[str, list] = {}

    def batch(statements, *, domain=None, **_):
        writes.setdefault(domain or "legacy", []).extend(statements)
        for sql, params in statements if domain == "core" and not drop_core_writes else []:
            # INSERT ... ON CONFLICT DO UPDATE ... WHERE listing_observed_at guard
            old = core.get(params[0])
            if old is None or not old["listing_observed_at"] or params[6] >= old["listing_observed_at"]:
                core[params[0]] = {"symbol": params[0], "listing_observed_at": params[6], "listing_checksum": params[7]}
        return {"total": len(statements), "success_count": len(statements), "error_count": 0, "changes_total": len(statements)}

    def query(sql, params=None, *, domain=None):
        if "sqlite_master" in sql:
            return [{"sql": TRIGGER_SQL}]
        if "FROM stocks WHERE symbol IN" in sql:
            return [dict(core[symbol]) for symbol in params or [] if symbol in core]
        return []

    monkeypatch.setattr(backfill, "d1_batch_execute", batch)
    monkeypatch.setattr(backfill, "controller_d1_batch_execute", lambda statements, **kw: batch(statements, domain="legacy"))
    monkeypatch.setattr(backfill, "d1_query", query)
    monkeypatch.setattr(backfill, "market_domain_active", lambda: True)
    monkeypatch.setattr(sys, "argv", ["finlab_canonical_apply_d1.py", *argv])
    printed: list[str] = []
    monkeypatch.setattr("builtins.print", lambda *a, **k: printed.append(" ".join(str(x) for x in a)))
    try:
        code = apply_tool.main()
    except SystemExit:
        _run_apply_tool.last_writes = writes
        raise
    return code, json.loads(printed[-1]), writes


def _pin(monkeypatch, root: Path, symbols: str = "6467,2249") -> str:
    _, dry, _ = _run_apply_tool(monkeypatch, ["--artifact-root", str(root), "--run-id", "sm-run-01",
                                              "--datasets", "stocks", "--symbols", symbols])
    return dry["raw_pin"]["raw_sha256"]


def test_apply_tool_writes_only_pinned_symbols(tmp_path: Path, monkeypatch) -> None:
    root = _capture(tmp_path / "sm-run-01")
    base = ["--artifact-root", str(root), "--run-id", "sm-run-01", "--datasets", "stocks", "--symbols", "6467,2249"]

    code, dry, writes = _run_apply_tool(monkeypatch, base)
    assert code == 0 and writes == {}
    assert dry["mode"] == "dry_run"
    assert dry["raw_pin"]["manifest_verified"] == [
        "company_basic_info.parquet", "table.parquet", "tw_etf_basic_info.parquet"]
    assert [row["symbol"] for row in dry["stocks_rows"]] == ["2249", "6467"]
    pin = dry["raw_pin"]["raw_sha256"]

    # Core holds an older capture of both targets plus an untouched non-target.
    core = {s: {"symbol": s, "listing_observed_at": "2026-09-12T12:51:54.734175+00:00", "listing_checksum": "old"}
            for s in ("6467", "2249", "7000")}
    code, applied, writes = _run_apply_tool(monkeypatch, [*base, "--apply", "--expect-raw-sha256", pin], core=core)
    assert code == 0
    assert sorted(params[0] for _, params in writes["core"]) == ["2249", "6467"]
    assert all(sql.startswith("INSERT INTO stocks") for sql, _ in writes["core"])
    assert not any("INSERT INTO stocks" in sql for domain in ("legacy", "market", "ops") for sql, _ in writes.get(domain, []))
    assert applied["writes_by_domain"]["core"] == 2
    assert applied["symbol_filter"]["skipped"] == 3
    assert applied["stocks_rows_written"] == 2 and applied["stocks_rows_unwritten"] == []
    assert core["7000"]["listing_checksum"] == "old"


def test_apply_tool_refuses_empty_or_missing_allowlist(tmp_path: Path, monkeypatch) -> None:
    root = _capture(tmp_path / "sm-run-01")
    pin = _pin(monkeypatch, root)
    common = ["--artifact-root", str(root), "--run-id", "sm-run-01", "--datasets", "stocks"]
    for argv, reason in (
        ([*common, "--symbols", "", "--apply", "--expect-raw-sha256", pin], "security_master_symbols_empty"),
        ([*common, "--symbols", " , ", "--apply", "--expect-raw-sha256", pin], "security_master_symbols_empty"),
        ([*common, "--apply", "--expect-raw-sha256", pin], "security_master_raw_pin_requires_symbols"),
    ):
        with pytest.raises(SystemExit, match=reason):
            _run_apply_tool(monkeypatch, argv)
        assert _run_apply_tool.last_writes == {}


def test_apply_tool_refuses_unpinned_or_changed_capture(tmp_path: Path, monkeypatch) -> None:
    root = _capture(tmp_path / "sm-run-01")
    base = ["--artifact-root", str(root), "--run-id", "sm-run-01", "--datasets", "stocks", "--symbols", "6467"]
    pin = _pin(monkeypatch, root, "6467")

    with pytest.raises(SystemExit, match="security_master_apply_requires_expect_raw_sha256"):
        _run_apply_tool(monkeypatch, [*base, "--apply"])
    with pytest.raises(SystemExit, match="security_master_manifest_run_id_mismatch"):
        _run_apply_tool(monkeypatch, ["--artifact-root", str(root), "--run-id", "other-run", "--datasets", "stocks",
                                      "--symbols", "6467", "--apply", "--expect-raw-sha256", pin])
    # official_boards has no manifest checksum; the dry-run digest still pins it.
    boards = root / "raw" / "security_master" / "official_boards.parquet"
    _write(boards, pl.read_parquet(boards).head(10))
    with pytest.raises(SystemExit, match="security_master_raw_sha256_mismatch"):
        _run_apply_tool(monkeypatch, [*base, "--apply", "--expect-raw-sha256", pin])
    # A refetched FinLab master no longer matches the dry-run run's manifest.
    _write(root / "raw" / "security_master" / "company_basic_info.parquet", pl.DataFrame({
        "symbol": ["6467"], "公司簡稱": ["泰合"], "市場別": ["sii"], "上市日期": ["2026-10-20"],
        "上櫃日期": [None], "興櫃日期": [None], "__observed_at": [OBSERVED]}))
    with pytest.raises(SystemExit, match="security_master_artifact_checksum_mismatch:company_basic_info.parquet"):
        _run_apply_tool(monkeypatch, base)


def test_apply_tool_requires_official_snapshot(tmp_path: Path, monkeypatch) -> None:
    root = _capture(tmp_path / "sm-run-01")
    (root / "raw" / "security_master" / "official_boards.parquet").unlink()
    pin = _pin(monkeypatch, root)
    with pytest.raises(SystemExit, match="security_master_apply_requires_official_snapshot"):
        _run_apply_tool(monkeypatch, ["--artifact-root", str(root), "--run-id", "sm-run-01", "--datasets", "stocks",
                                      "--symbols", "6467,2249", "--apply", "--expect-raw-sha256", pin])
    assert _run_apply_tool.last_writes == {}


def test_apply_tool_aborts_when_guard_would_skip_a_target(tmp_path: Path, monkeypatch) -> None:
    root = _capture(tmp_path / "sm-run-01")
    pin = _pin(monkeypatch, root)
    argv = ["--artifact-root", str(root), "--run-id", "sm-run-01", "--datasets", "stocks",
            "--symbols", "6467,2249", "--apply", "--expect-raw-sha256", pin]
    newer = {"6467": {"symbol": "6467", "listing_observed_at": "2026-11-21T00:00:00.000000+00:00", "listing_checksum": "x"}}
    with pytest.raises(SystemExit, match="security_master_apply_rows_not_writable:6467:capture_older_than_core"):
        _run_apply_tool(monkeypatch, argv, core=newer)
    assert _run_apply_tool.last_writes == {}
    same_clock = {"2249": {"symbol": "2249", "listing_observed_at": "2026-11-20T04:00:00.000000+00:00",
                           "listing_checksum": "other"}}
    with pytest.raises(SystemExit, match="2249:capture_conflict_same_clock"):
        _run_apply_tool(monkeypatch, argv, core=same_clock)
    # Acknowledged statements that left a target unwritten are reported, not counted.
    code, applied, _ = _run_apply_tool(monkeypatch, argv, core={}, drop_core_writes=True)
    assert code == 2
    assert applied["stocks_rows_written"] == 0 and applied["stocks_rows_unwritten"] == ["2249", "6467"]
