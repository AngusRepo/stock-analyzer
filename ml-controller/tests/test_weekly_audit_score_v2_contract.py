import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from graphs.weekly_audit_graph import _component_contributions, _score_v2_regime  # noqa: E402
from services.recommendation_service import build_score_components  # noqa: E402


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def _technical_fixture_expected() -> dict:
    fixture_path = ROOT / "worker" / "src" / "lib" / "technicalIndicatorsV2.fixture.json"
    return json.loads(fixture_path.read_text(encoding="utf-8"))["expectedIndicators"]


def test_weekly_audit_uses_score_v2_decision_attribution() -> None:
    source = read("ml-controller/graphs/weekly_audit_graph.py")

    assert "score_components" in source
    assert "Score V2 payload coverage" in source
    assert "avg_ml_edge_contribution" in source
    assert "avg_chip_flow_contribution" in source
    assert "avg_technical_structure_contribution" in source
    assert "avg_fundamental_quality_contribution" in source
    assert "avg_news_theme_contribution" in source
    assert "regime_factor_attribution" in source
    assert "Regime factor attribution" in source
    assert "ML Edge" in source
    assert "Chip Flow" in source
    assert "Technical Structure" in source
    assert "Fundamental Quality" in source
    assert "News/Theme" in source
    assert "legacy_pct" not in source
    assert "chip_pct" not in source
    assert "tech_pct" not in source
    assert "ml_pct" not in source
    assert "chip_score" not in source
    assert "tech_score" not in source
    assert "ml_score" not in source
    assert "total_score" not in source
    assert "avg_chip_contribution" not in source
    assert "avg_tech_contribution" not in source
    assert "avg_ml_contribution" not in source
    assert "Avg contribution: Chip" not in source
    assert "Dominant factor:" not in source


def test_decision_logs_persist_score_v2_payload_for_audit() -> None:
    migration = read("worker/migration_decision_logs_score_v2.sql")
    paper_entry_tasks = read("worker/src/lib/paperEntryTasks.ts")

    assert "ALTER TABLE decision_logs ADD COLUMN score_components TEXT" in migration
    assert "date, symbol, action, score_components" in paper_entry_tasks
    assert "decisionScoreComponents" in paper_entry_tasks
    assert "finalScore: scoreV2.finalScore" in paper_entry_tasks
    assert "alphaAdjustment: scoreV2.alphaAdjustment" in paper_entry_tasks


def test_weekly_review_template_renders_score_v2_average_attribution() -> None:
    template = read("ml-controller/templates/weekly_review.md.j2")

    assert "| Factor | Avg Contribution |" in template
    assert "f.avg_pct" in template
    assert "Win Contribution" not in template
    assert "Loss Contribution" not in template


def test_score_v2_factor_contribution_accepts_technical_v2_fixture_payload() -> None:
    expected = _technical_fixture_expected()
    payload = build_score_components(
        {
            "score_seed_inputs": {
                "chipFlowSeed40": 18.0,
                "technicalSeed30": 18.0,
                "screenerMomentumSeed20": 12.0,
                "mlEdgeSeed30": 21.0,
                "personaAlphaSeed": 0.0,
            },
            "current_price": 119.9132,
            "ma20": expected["ma20"],
            "macd_hist": expected["macdHist"],
            "atr14": expected["atr14"],
            "plus_di14": expected["plusDi14"],
            "minus_di14": expected["minusDi14"],
            "adx14": expected["adx14"],
            "parabolic_sar": expected["parabolicSar"],
            "cci20": expected["cci20"],
            "rsi14": expected["rsi14"],
            "volume_weighted_rsi14": expected["volumeWeightedRsi14"],
            "volume_momentum_divergence_13_27_10": expected["volumeMomentumDivergence132710"],
            "alpha_context": {
                "regime": "bull",
                "score_adjustment": 0.0,
            },
        },
        raw_score=69.0,
    )

    contributions, is_score_v2 = _component_contributions({"score_components": payload})

    assert is_score_v2 is True
    assert _score_v2_regime({"score_components": payload}) == "bull"
    assert contributions["technicalStructure"] > 0
    assert contributions["mlEdge"] > 0
    assert contributions["chipFlow"] > 0
    assert sum(contributions.values()) == pytest.approx(1.0, abs=0.02)
    assert payload["technicalBreakdown"]["trendStructure"] > 0
    assert payload["technicalBreakdown"]["volumeConfirmation"] > 0
