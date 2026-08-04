import numpy as np

from app.neural_meta_bandit import (
    NeuralMetaBanditConfig,
    build_shadow_decisions,
    train_neural_meta_bandit,
)


def test_neural_meta_bandit_trains_and_scores_actions():
    rng = np.random.default_rng(7)
    contexts = rng.normal(size=(80, 12)).astype("float32")
    arms = np.array([0 if row[0] > 0 else 1 for row in contexts], dtype=np.int64)
    rewards = np.where(arms == 0, contexts[:, 0] * 0.2 + 0.6, -contexts[:, 0] * 0.2 + 0.55).astype("float32")

    model = train_neural_meta_bandit(
        contexts,
        arms,
        rewards,
        arm_names=["tree_family", "sequence_family"],
        config=NeuralMetaBanditConfig(policy_id="NeuralUCB", epochs=80, seed=11),
    )

    scores = model.score_actions(contexts[:5], mode="ucb")
    assert scores.shape == (5, 2)
    assert model.training_report.samples == 80
    assert model.training_report.loss_final < model.training_report.loss_initial


def test_shadow_decisions_compare_baseline_to_neural_policy():
    contexts = np.array(
        [
            [1.0] + [0.0] * 11,
            [-1.0] + [0.0] * 11,
            [0.8] + [0.0] * 11,
            [-0.7] + [0.0] * 11,
        ],
        dtype="float32",
    )
    arms = np.array([0, 1, 0, 1], dtype=np.int64)
    rewards = np.array([0.8, 0.7, 0.75, 0.65], dtype="float32")
    model = train_neural_meta_bandit(
        contexts,
        arms,
        rewards,
        arm_names=["tree_family", "sequence_family"],
        config=NeuralMetaBanditConfig(policy_id="NeuralTS", epochs=60, seed=3),
    )

    decisions = build_shadow_decisions(
        model,
        business_date="2026-05-08",
        symbols=["2330", "4938"],
        contexts=contexts[:2],
        baseline_actions=["tree_family", "tree_family"],
        mode="ts",
    )

    assert len(decisions) == 2
    assert decisions[0]["policy_id"] == "NeuralTS"
    assert set(decisions[0]).issuperset({"symbol", "baseline_action", "shadow_action", "context", "evidence"})


def test_neucb_scores_with_context_dependent_uncertainty():
    contexts = np.array(
        [
            [1.0] + [0.0] * 11,
            [-1.0] + [0.0] * 11,
            [0.9] + [0.0] * 11,
            [-0.8] + [0.0] * 11,
        ],
        dtype="float32",
    )
    arms = np.array([0, 1, 0, 1], dtype=np.int64)
    rewards = np.array([0.8, 0.7, 0.78, 0.68], dtype="float32")

    model = train_neural_meta_bandit(

        contexts,
        arms,
        rewards,
        arm_names=["tree_family", "time_series_family"],
        config=NeuralMetaBanditConfig(policy_id="NeuCB", epochs=50, seed=9),
    )

    scores = model.score_actions(contexts[:2], mode="neucb")
    assert scores.shape == (2, 2)
    assert model.training_report.policy_id == "NeuCB"


def test_neural_policy_families_do_not_share_identical_models_or_scores():
    rng = np.random.default_rng(19)
    contexts = rng.normal(size=(60, 12)).astype("float32")
    arms = np.asarray([idx % 3 for idx in range(len(contexts))], dtype=np.int64)
    rewards = (0.2 * contexts[:, 0] + 0.1 * arms).astype("float32")
    arm_names = ["tree_family", "time_series_family", "do_nothing"]

    models = {
        policy_id: train_neural_meta_bandit(
            contexts,
            arms,
            rewards,
            arm_names=arm_names,
            config=NeuralMetaBanditConfig(
                policy_id=policy_id,
                epochs=20,
                seed=7,
                ucb_alpha=0.10,
            ),
        )
        for policy_id in ("NeuralUCB", "NeuralTS", "NeuCB")
    }
    scores = {
        "NeuralUCB": models["NeuralUCB"].score_actions(contexts[:4], mode="ucb"),
        "NeuralTS": models["NeuralTS"].score_actions(contexts[:4], mode="ts"),
        "NeuCB": models["NeuCB"].score_actions(contexts[:4], mode="neucb"),
    }

    assert not np.allclose(scores["NeuralUCB"], scores["NeuralTS"])
    assert not np.allclose(scores["NeuralUCB"], scores["NeuCB"])
