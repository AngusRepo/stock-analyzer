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
    assert out["multiple_testing"]["method"] == "holm_bonferroni"
    assert out["multiple_testing"]["family_size"] == 3
    assert out["candidate_evidence"]["steady"]["monte_carlo"]["method"] == "regime_block_bootstrap"
    assert out["candidate_evidence"]["steady"]["multiple_testing"]["passed"] is True
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


def test_strategy_evidence_fails_null_candidate_after_family_wise_adjustment():
    oscillating = [0.002 if index % 2 == 0 else -0.002 for index in range(40)]
    rows = [
        _row("strong", [0.02] * 8, [0.001] * 40),
        _row("null", [0.001, -0.001] * 4, oscillating),
    ]
    out = build_strategy_mining_evidence(rows, n_partitions=8, n_simulations=20)
    null_test = out["candidate_evidence"]["null"]["multiple_testing"]
    assert null_test["adjustment_method"] == "holm_bonferroni"
    assert null_test["family_size"] == 2
    assert null_test["passed"] is False
    assert "holdout_hac_holm_bonferroni" in out["candidate_evidence"]["null"]["failed_gates"]
