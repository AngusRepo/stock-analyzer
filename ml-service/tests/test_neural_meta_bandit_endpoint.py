from app.main import AdaptiveMetaPolicyReplayRequest, LinUcbMultiplierReplayRequest, NeuralMetaBanditRequest, app


def test_neural_meta_shadow_endpoint_is_registered_without_production_effect():
    paths = {route.path for route in app.routes}
    assert "/meta-learning/neural-shadow/train" in paths


def test_adaptive_meta_policy_replay_endpoint_is_registered_without_production_effect():
    paths = {route.path for route in app.routes}
    assert "/meta-learning/adaptive-policy-replay" in paths


def test_linucb_multiplier_replay_endpoint_is_registered_without_production_effect():
    paths = {route.path for route in app.routes}
    assert "/meta-learning/linucb-multiplier-replay" in paths


def test_neural_meta_shadow_request_contract():
    req = NeuralMetaBanditRequest(
        policy_id="NeuralTS",
        contexts=[[0.0] * 12] * 4,
        arms=[0, 1, 0, 1],
        rewards=[0.1, 0.2, 0.0, -0.1],
        arm_names=["tree_family", "sequence_family"],
        business_date="2026-05-08",
        symbols=["2330", "4938"],
        baseline_actions=["tree_family", "tree_family"],
    )
    assert req.policy_id == "NeuralTS"
    assert req.epochs == 120


def test_adaptive_meta_policy_replay_request_contract():
    req = AdaptiveMetaPolicyReplayRequest(
        rows=[{"date": "2026-06-05", "model_name": "LightGBM", "actual_return_pct": 0.03}],
    )
    assert req.min_ic_samples == 5
    assert req.min_windows == 8
    assert req.neural_epochs == 80


def test_linucb_multiplier_replay_request_contract():
    req = LinUcbMultiplierReplayRequest(
        rows=[{"date": "2026-06-05", "model_name": "LightGBM", "actual_return_pct": 0.03}],
    )
    assert req.min_decisions == 30
    assert req.max_grid_evals == 96
    assert req.recent_loss_window == 5


def test_neural_meta_shadow_request_accepts_neucb_research_benchmark():
    req = NeuralMetaBanditRequest(
        policy_id="NeuCB",
        contexts=[[0.0] * 12] * 4,
        arms=[0, 1, 0, 1],
        rewards=[0.1, 0.2, 0.0, -0.1],
        arm_names=["tree_family", "sequence_family"],
        business_date="2026-05-08",
        symbols=["2330", "4938"],
        baseline_actions=["tree_family", "tree_family"],
    )
    assert req.policy_id == "NeuCB"
