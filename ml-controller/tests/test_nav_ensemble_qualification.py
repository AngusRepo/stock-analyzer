"""Qualification is immutable advisory evidence, never NAV authority."""
from copy import deepcopy
from pathlib import Path
import json
import pytest
from services.ensemble_qualification import assess_ensemble_qualifications, qualify_directional_signal
from test_active8_ensemble_artifact import _build, _rows


@pytest.mark.parametrize('width', [0., 1.])
def test_calibration_and_direction_do_not_reject_ranked_candidate(width, monkeypatch):
    import services.active8_ensemble_artifact as builder
    monkeypatch.setattr(builder, 'finite_sample_quantile', lambda *args: width)
    artifact = _build(_rows())
    before = deepcopy(artifact)
    q = assess_ensemble_qualifications(artifact)
    assert q['ranking']['decision'] == 'PASS'
    assert q['directional']['decision'] == 'BLOCKED'
    assert artifact == before
    if width == 0.: assert q['calibration']['decision'] == 'INSUFFICIENT'
    else: assert artifact['validation']['directional_signal_rows'] == 0


def test_original_saved_artifact_is_immutable_and_only_advisory():
    artifact = json.loads((Path(__file__).parent / 'fixtures/active8_ensemble_20260909.json').read_text(encoding='utf-8'))
    before = deepcopy(artifact)
    result = qualify_directional_signal('BUY', artifact)
    assert result['signal'] == 'HOLD'
    assert result['advisory_signal'] == 'BUY'
    assert result['signal_role'] == 'advisory_only'
    assert result['final_decision_owner'] == 'allocator_opb_policy'
    assert 'signal_unreachable' in result['signal_blockers']
    assert artifact == before


def test_controller_modal_share_identical_qualification():
    root = Path(__file__).resolve().parents[2]
    assert (root / 'ml-controller/services/ensemble_qualification.py').read_bytes() == (root / 'ml-service/app/ensemble_qualification.py').read_bytes()
