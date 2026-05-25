from __future__ import annotations

import inspect
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import backtest_engine  # noqa: E402
from services.backtest_engine import (  # noqa: E402
    Candidate,
    ScreenerParams,
    _build_partial_screener_score_v2,
    _candidate_screener_norm,
    apply_screener_score_calibration,
)


def _candidate(
    *,
    chip_score: float,
    tech_score: float,
    momentum_score: float,
) -> Candidate:
    score_components = _build_partial_screener_score_v2(
        chip_score=chip_score,
        tech_score=tech_score,
        momentum_score=momentum_score,
        reasons=["fixture"],
    )
    return Candidate(
        symbol="2330",
        date="2026-01-10",
        close=100.0,
        industry="semi",
        base_score=score_components["finalScore"],
        chip_score=chip_score,
        tech_score=tech_score,
        momentum_score=momentum_score,
        combined_score=0.0,
        reasons=["fixture"],
        score_components=score_components,
    )


def test_backtest_screener_norm_uses_score_v2_components_with_momentum_folded_into_technical():
    candidate = _candidate(chip_score=10.0, tech_score=10.0, momentum_score=20.0)

    components = candidate.score_components["components"]
    assert components["chipFlow"] == pytest.approx(6.3)
    assert components["technicalStructure"] == pytest.approx(15.0)
    assert candidate.score_components["seedComponents"]["screenerMomentumSeed20"] == pytest.approx(20.0)

    score_v2_norm = _candidate_screener_norm(candidate)
    legacy_chip_tech_only_norm = (candidate.chip_score + candidate.tech_score) / 60.0
    assert score_v2_norm == pytest.approx((6.3 + 15.0) / 50.0)
    assert abs(score_v2_norm - legacy_chip_tech_only_norm) > 0.05


def test_backtest_calibration_refreshes_score_v2_payload_after_seed_scores_change():
    candidate = _candidate(chip_score=40.0, tech_score=30.0, momentum_score=20.0)
    candidate.score_components = _build_partial_screener_score_v2(
        chip_score=0.0,
        tech_score=0.0,
        momentum_score=0.0,
        reasons=["stale"],
    )

    apply_screener_score_calibration(
        [candidate],
        ScreenerParams(score_calibration_enabled=True, score_calibration_min_size=1),
    )

    components = candidate.score_components["components"]
    assert candidate.chip_score == pytest.approx(20.0)
    assert candidate.tech_score == pytest.approx(15.0)
    assert candidate.momentum_score == pytest.approx(10.0)
    assert candidate.base_score == pytest.approx(25.0)
    assert components["chipFlow"] == pytest.approx(12.5)
    assert components["technicalStructure"] == pytest.approx(12.5)
    assert _candidate_screener_norm(candidate) == pytest.approx(0.5)


def test_backtest_ranking_rejects_legacy_chip_tech_denominator_owner():
    source = Path(backtest_engine.__file__).read_text(encoding="utf-8")
    assert "(c.chip_score + c.tech_score) / ranking.screener_denominator" not in source
    assert "_candidate_screener_norm(c)" in source


def test_backtest_runtime_paths_ignore_deprecated_screener_denominator():
    for function_name in ("replay_screener_for_date", "diagnose_replay_for_date"):
        source = inspect.getsource(getattr(backtest_engine, function_name))
        assert "_candidate_screener_norm(c)" in source
        assert "screener_denominator" not in source

    params_source = inspect.getsource(backtest_engine.RankingParams)
    assert "Deprecated compatibility only" in params_source
