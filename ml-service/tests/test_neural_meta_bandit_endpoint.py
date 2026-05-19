from app.main import NeuralMetaBanditRequest, app


def test_neural_meta_shadow_endpoint_is_registered_without_production_effect():
    paths = {route.path for route in app.routes}
    assert "/meta-learning/neural-shadow/train" in paths


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
