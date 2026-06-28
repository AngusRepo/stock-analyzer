from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TOOL_PATH = ROOT / "tools" / "finlab_macro_context_snapshot.py"


def _load_tool_module():
    spec = importlib.util.spec_from_file_location("finlab_macro_context_snapshot_tool", TOOL_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_macro_context_snapshot_builds_canonical_regime_context_rows() -> None:
    tool = _load_tool_module()
    rows = [{
        "source": "finlab",
        "dataset": "tw_business_indicators",
        "as_of_date": "2026-06-29",
        "freshness_status": "ok",
        "missing_rate": 0,
        "duplicate_rate": 0,
        "schema_drift_status": "ok",
        "entity_link_confidence": 0.95,
        "latest_materialization": "2026-05-01",
        "metrics_json": {
            "fields": {
                "景氣對策信號(分)": {
                    "api_key": "tw_business_indicators:景氣對策信號(分)",
                    "date": "2026-05-01",
                    "value": 39.0,
                },
                "領先指標綜合指數(點)": {
                    "api_key": "tw_business_indicators:領先指標綜合指數(點)",
                    "date": "2026-05-01",
                    "value": 101.2,
                },
            },
        },
    }]

    canonical = tool.collect_canonical_regime_context_rows(rows, generated_at="2026-06-29T01:02:03+00:00")

    assert {
        (row["dataset"], row["field"], row["date"], row["value"], row["source"])
        for row in canonical
    } == {
        ("tw_business_indicators", "business_signal_score", "2026-05-01", 39.0, "finlab.tw_business_indicators"),
        ("tw_business_indicators", "leading_index", "2026-05-01", 101.2, "finlab.tw_business_indicators"),
    }
    statements = tool.build_d1_upsert_statements(rows, canonical)
    assert any("INSERT INTO source_quality_metrics" in sql for sql, _ in statements)
    assert any("INSERT INTO canonical_regime_context_daily" in sql for sql, _ in statements)
