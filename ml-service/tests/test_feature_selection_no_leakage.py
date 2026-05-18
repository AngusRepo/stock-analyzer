import sys
import types

import numpy as np

from app.feature_selection import (
    _k_sweep_summary,
    _permuted_target,
    cur_representative_evidence,
    mutual_information_evidence,
    optuna_k_sweep,
    signal_sanity_gate,
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


def test_signal_sanity_gate_parallel_keeps_permutation_count_and_seed_order(monkeypatch):
    calls = []

    class FakeModel:
        def __init__(self, seed: int):
            self.seed = seed

        def predict(self, X_val):
            base = np.linspace(0.0, 1.0, len(X_val))
            return base if self.seed == 42 else base[::-1] + (self.seed * 1e-6)

    def fake_train(X_train, y_train, X_val, y_val, seed=42, lightgbm_n_jobs=-1):
        calls.append({"seed": seed, "n_jobs": lightgbm_n_jobs, "y": tuple(np.round(y_train, 6))})
        return FakeModel(seed)

    monkeypatch.setattr("app.feature_selection._train_lgbm_regression", fake_train)

    X = np.arange(120, dtype=float).reshape(40, 3)
    y = np.linspace(0.0, 1.0, 40)
    dates = np.array(["2026-05-01"] * 20 + ["2026-05-02"] * 20)

    result = signal_sanity_gate(
        X,
        y,
        X,
        y,
        n_permutations=6,
        dates_train=dates,
        permutation_mode="within_date",
        max_parallel_workers=3,
    )

    assert result["n_permutations"] == 6
    assert result["max_parallel_workers"] == 3
    assert calls[0]["seed"] == 42
    assert sorted(call["seed"] for call in calls[1:]) == [100, 101, 102, 103, 104, 105]
    assert all(call["n_jobs"] >= 1 for call in calls[1:])


def test_optuna_k_sweep_caches_duplicate_k_trials(monkeypatch):
    k_sequence = [5, 6, 5, 6, 7, 7]

    class FakeTrial:
        def __init__(self, k: int):
            self.params = {}
            self.values = None
            self._k = k

        def suggest_int(self, name, low, high):
            self.params[name] = self._k
            return self._k

    class FakeStudy:
        def __init__(self):
            self.trials = []

        @property
        def best_trials(self):
            return [trial for trial in self.trials if trial.values is not None]

        def optimize(self, objective, n_trials, n_jobs=1, show_progress_bar=False):
            for k in k_sequence[:n_trials]:
                trial = FakeTrial(k)
                trial.values = objective(trial)
                self.trials.append(trial)

    fake_optuna = types.SimpleNamespace(
        logging=types.SimpleNamespace(
            WARNING="WARNING",
            set_verbosity=lambda _level: None,
        ),
        samplers=types.SimpleNamespace(
            NSGAIISampler=lambda seed=None: object(),
        ),
        create_study=lambda directions, sampler: FakeStudy(),
    )
    monkeypatch.setitem(sys.modules, "optuna", fake_optuna)

    train_calls = []

    class FakeBooster:
        def __init__(self, k: int):
            self.k = k

        def predict(self, X_val):
            return np.linspace(0.0, 1.0, len(X_val)) + self.k * 0.001

    def fake_train(X_train, y_train, X_val, y_val, seed=42, lightgbm_n_jobs=-1):
        train_calls.append(X_train.shape[1])
        return FakeBooster(X_train.shape[1])

    monkeypatch.setattr("app.feature_selection._train_lgbm_regression", fake_train)

    feature_names = [f"f{i}" for i in range(7)]
    per_feature = {name: {"score": 10 - idx} for idx, name in enumerate(feature_names)}
    X_train = np.arange(140, dtype=float).reshape(20, 7)
    y_train = np.linspace(0.0, 1.0, 20)
    X_val = X_train.copy()
    y_val = y_train.copy()

    result = optuna_k_sweep(
        per_feature,
        X_train,
        y_train,
        X_val,
        y_val,
        feature_names,
        n_trials=len(k_sequence),
        min_k=5,
    )

    assert sorted(train_calls) == [5, 6, 7]
    assert result["objective_cache_hits"] == 3
    assert result["unique_k_evaluated"] == 3
    assert result["actual_trials"] == len(k_sequence)


def test_k_sweep_summary_preserves_trial_scope_for_telemetry():
    summary = _k_sweep_summary(
        {
            "best_k": 42,
            "best_ic": 0.1234,
            "n_trials": 150,
            "actual_trials": 120,
            "unique_k_evaluated": 30,
            "objective_cache_hits": 90,
            "pareto_front": [{"k": 42}],
        }
    )

    assert summary == {
        "best_k": 42,
        "best_ic": 0.1234,
        "n_trials": 150,
        "actual_trials": 120,
        "unique_k_evaluated": 30,
        "objective_cache_hits": 90,
    }
