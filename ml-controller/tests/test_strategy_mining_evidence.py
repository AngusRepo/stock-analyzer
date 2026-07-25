from __future__ import annotations

from services.strategy_mining_evidence import build_strategy_mining_evidence


def _row(candidate_id: str, partitions: list[float], daily: list[float]):
    return {
        "candidate_id": candidate_id,
        "status": "ok",
        "holdout_partition_returns": partitions,
        "holdout_daily_returns": daily,
        "holdout_regimes": ["bull"] * len(daily),
    }


def test_strategy_evidence_is_pending_when_common_matrix_is_missing():
    out = build_strategy_mining_evidence(
        [_row("only", [0.01] * 8, [0.001] * 40)],
        n_partitions=8,
        n_simulations=10,
    )
    assert out["status"] == "pending"
    assert out["pbo"]["status"] == "pending"


def test_strategy_evidence_computes_all_required_evidence():
    rows = [
        _row("steady", [0.02] * 8, [0.001] * 40),
        _row("weak", [-0.01] * 8, [-0.0005] * 40),
        _row("mixed", [0.01, 0.02, 0.01, 0.02, 0.01, 0.02, 0.01, 0.02], [0.0007] * 40),
    ]
    out = build_strategy_mining_evidence(rows, n_partitions=8, n_simulations=20)
    assert out["pbo"]["method"] == "cscv_rank_logit"
    assert out["walk_forward"]["method"] == "purged_expanding_candidate_selection"
    assert out["candidate_evidence"]["steady"]["monte_carlo"]["method"] == "regime_block_bootstrap"
    assert out["candidate_evidence"]["steady"]["status"] == "pass"


def test_strategy_evidence_rejects_misaligned_regimes_without_bypass():
    row = _row("bad", [0.01] * 8, [0.001] * 40)
    row["holdout_regimes"] = ["bull"]
    out = build_strategy_mining_evidence(
        [row, _row("good", [0.02] * 8, [0.001] * 40)],
        n_partitions=8,
        n_simulations=10,
    )
    assert out["status"] == "pending"
    assert out["common_candidate_matrix"]["rejected"]["bad"] == "holdout_regime_alignment_unmet"
