import numpy as np

from app.feature_selection import (
    _permuted_target,
    cur_representative_evidence,
    mutual_information_evidence,
    stability_selection_evidence,
    update_feature_pool,
)


def test_permuted_target_preserves_each_date_distribution():
    y = np.array([0.1, 0.2, 0.3, 0.9, 0.8, 0.7])
    dates = np.array(["2026-04-01"] * 3 + ["2026-04-02"] * 3)
    rng = np.random.RandomState(7)

    shuffled = _permuted_target(y, rng=rng, dates=dates, mode="within_date")

    assert sorted(shuffled[:3].tolist()) == sorted(y[:3].tolist())
    assert sorted(shuffled[3:].tolist()) == sorted(y[3:].tolist())
    assert sorted(shuffled.tolist()) == sorted(y.tolist())


def test_permuted_target_global_mode_keeps_legacy_fallback():
    y = np.array([0.1, 0.2, 0.3, 0.9, 0.8, 0.7])
    rng = np.random.RandomState(7)

    shuffled = _permuted_target(y, rng=rng, dates=None, mode="global")

    assert sorted(shuffled.tolist()) == sorted(y.tolist())


def test_permuted_target_sector_aware_preserves_date_sector_blocks():
    y = np.array([0.1, 0.2, 0.8, 0.9, 0.3, 0.4, 0.6, 0.7])
    dates = np.array(["2026-04-01"] * 4 + ["2026-04-02"] * 4)
    sectors = np.array(["semi", "semi", "bio", "bio", "semi", "semi", "bio", "bio"])
    rng = np.random.RandomState(11)

    shuffled = _permuted_target(
        y,
        rng=rng,
        dates=dates,
        sectors=sectors,
        mode="within_date_sector",
    )

    for date in sorted(set(dates)):
        for sector in sorted(set(sectors)):
            mask = (dates == date) & (sectors == sector)
            assert sorted(shuffled[mask].tolist()) == sorted(y[mask].tolist())
    assert sorted(shuffled.tolist()) == sorted(y.tolist())


def test_permuted_target_sector_mode_falls_back_to_date_blocks_without_sector_data():
    y = np.array([0.1, 0.2, 0.3, 0.9, 0.8, 0.7])
    dates = np.array(["2026-04-01"] * 3 + ["2026-04-02"] * 3)
    rng = np.random.RandomState(7)

    shuffled = _permuted_target(y, rng=rng, dates=dates, mode="within_date_sector")

    assert sorted(shuffled[:3].tolist()) == sorted(y[:3].tolist())
    assert sorted(shuffled[3:].tolist()) == sorted(y[3:].tolist())


def test_feature_governance_evidence_produces_scores():
    rng = np.random.RandomState(42)
    x1 = np.linspace(0, 1, 80)
    x2 = rng.normal(size=80)
    x3 = rng.normal(size=80)
    X = np.column_stack([x1, x2, x3])
    y = x1 + rng.normal(scale=0.01, size=80)
    dates = np.array([f"2026-04-{(i // 8) + 1:02d}" for i in range(80)])
    feature_names = ["signal", "noise_a", "noise_b"]
    cluster = {
        "feature_to_group": {"signal": 1, "noise_a": 2, "noise_b": 2},
    }

    mi = mutual_information_evidence(X, y, feature_names)
    stability = stability_selection_evidence(X, y, dates, feature_names)
    cur = cur_representative_evidence(X, feature_names, cluster)

    assert mi["status"] == "ok"
    assert stability["status"] == "ok"
    assert cur["status"] == "ok"
    assert mi["per_feature"]["signal"]["score"] >= mi["per_feature"]["noise_a"]["score"]
    assert "signal" in stability["per_feature"]
    assert "signal" in cur["per_feature"]


def test_feature_pool_records_active_governance_evidence():
    pool = update_feature_pool(
        ["signal"],
        ["noise"],
        cluster_result={
            "n_groups": 1,
            "best_k": 1,
            "best_silhouette": 0.5,
            "dropped_features": [],
        },
        tp_stats={"n_permutations": 10, "elapsed_s": 1.2, "permutation_mode": "within_date_sector", "sector_aware": True},
        all_feature_names=["signal", "noise"],
        extra_evidence={"mutual_information": {"status": "ok"}},
    )

    assert pool["feature_policy_schema_version"] == "feature-pool-policy-v1"
    assert pool["selection_governance"]["methods"]["mutual_information"]["status"] == "active"
    assert pool["selection_evidence"]["governance"]["mutual_information"]["status"] == "ok"
    assert pool["target_permutation"]["sector_aware"] is True
