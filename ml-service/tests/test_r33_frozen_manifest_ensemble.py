"""The Modal-side validator accepts the R33 equal7 ensemble only through its own owner (R33-NEW-01).

Modal mounts ml-controller/services at /root/services; locally run with ../ml-controller
and ../ml-controller/tests on PYTHONPATH."""
import copy

import pytest

from app.active8_ensemble_runtime import Active8EnsembleContractError, validate_active8_ensemble_artifact

r33_fixture = pytest.importorskip("test_r33_l4_equal7")


def _pool(ensemble):
    return {m: {"serving_artifact_id": a["artifact_id"], "version": a["version"], "checksum": a["checksum"],
                "serving_eligible": True} for m, a in ensemble["base_artifacts"].items()}


def test_r33_object_is_validated_by_its_owner_and_bound_to_the_serving_pool():
    ensemble = r33_fixture._ensemble()
    validate_active8_ensemble_artifact(ensemble, pool_models=_pool(ensemble))
    pool = _pool(ensemble)
    pool["GNN"]["version"] = "GNN-v0"
    with pytest.raises(Active8EnsembleContractError, match="active8_ensemble_base_artifact_mismatch:GNN"):
        validate_active8_ensemble_artifact(ensemble, pool_models=pool)
    pool = _pool(ensemble)
    pool["TabM"]["serving_eligible"] = False
    with pytest.raises(Active8EnsembleContractError, match="active8_ensemble_base_artifact_not_serving:TabM"):
        validate_active8_ensemble_artifact(ensemble, pool_models=pool)


def test_tampered_r33_object_and_nav_authority_are_rejected():
    ensemble = r33_fixture._ensemble()
    tampered = copy.deepcopy(ensemble)
    tampered["variant"] = "mean_z_restandardized"
    with pytest.raises(Active8EnsembleContractError, match="r33_ensemble_"):
        validate_active8_ensemble_artifact(tampered, pool_models=_pool(ensemble))
    with pytest.raises(Active8EnsembleContractError, match="r33_ensemble_nav_inference_unsupported"):
        validate_active8_ensemble_artifact(ensemble, pool_models=_pool(ensemble), nav_authority=object())
