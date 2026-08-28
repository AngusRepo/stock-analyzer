from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "tools" / "run_s12_profit_continuation_paired_replay.py"


def _module():
    spec = importlib.util.spec_from_file_location("s12_profit_continuation_paired_replay", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_artifact(cache_dir: Path, *, business_date: str, symbol: str, bars: list[dict]) -> str:
    document = {
        "schema_version": "s12-research-minute-bars-v2",
        "business_date": business_date,
        "payload": {"symbol": symbol, "bars": bars},
    }
    body = json.dumps(document, separators=(",", ":")).encode()
    digest = hashlib.sha256(body).hexdigest()
    (cache_dir / f"{digest}.json").write_bytes(body)
    return digest


def test_selected_artifacts_remain_request_scoped_and_pit_bounded(tmp_path: Path) -> None:
    module = _module()
    module.CACHE_DIR = tmp_path
    day_1 = 1_788_480_000_000  # 2026-09-04 00:00 UTC = 2026-09-04 08:00 TW
    day_2 = day_1 + 86_400_000
    digest_1 = _write_artifact(
        tmp_path,
        business_date="2026-09-05",
        symbol="2330",
        bars=[
            {"startMs": day_1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 1},
            {"startMs": day_2, "open": 200, "high": 201, "low": 199, "close": 200, "volume": 1},
        ],
    )
    digest_2 = _write_artifact(
        tmp_path,
        business_date="2026-09-06",
        symbol="2330",
        bars=[
            {"startMs": day_1, "open": 110, "high": 111, "low": 109, "close": 110, "volume": 1},
            {"startMs": day_2, "open": 210, "high": 211, "low": 209, "close": 210, "volume": 1},
        ],
    )
    selected, receipt = module.load_selected_bars([
        {
            "request_key": "2330|2026-09-04",
            "symbol": "2330",
            "trade_date": "2026-09-04",
            "business_date": "2026-09-05",
            "checksum": digest_1,
        },
        {
            "request_key": "2330|2026-09-05",
            "symbol": "2330",
            "trade_date": "2026-09-05",
            "business_date": "2026-09-06",
            "checksum": digest_2,
        },
    ])

    assert [bar["close"] for bar in selected["2330|2026-09-04"]] == [100.0]
    assert [bar["close"] for bar in selected["2330|2026-09-05"]] == [110.0, 210.0]
    assert receipt["artifacts"] == 2
    assert receipt["symbols"] == 1


def test_manifest_selection_matches_production_resolver_contract() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "ORDER BY ra.business_date ASC, ra.created_at DESC, ra.r2_key ASC" in source
    assert "for session_date in requested_dates:" in source
    assert "merged_bars[int(bar[\"startMs\"])] = bar" in source
