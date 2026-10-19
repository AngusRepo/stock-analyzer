"""Synthetic sparse-state regression; no production data or cloud access."""
import numpy as np

from app.hmm_input_contract import CONTRACT_HASH
from app.hmm_maintenance import validate_candidate
from app.regime import RegimeDetector


def test_sparse_state_keeps_full_covariance_positive_definite():
    rng = np.random.default_rng(7)
    features = np.insert(rng.normal(0, .01, (56, 6)), 28, np.full(6, 10.), axis=0)
    detector = RegimeDetector().fit(features, input_contract=CONTRACT_HASH,
                                    training_input_checksum='a' * 64)
    # A single-observation state has a rank-deficient empirical covariance.
    # Admission must still validate the fitted distribution without relaxing it.
    validate_candidate(detector, features)
    assert np.all(np.linalg.eigvalsh(detector.model.covars_) > 0)
