from copy import deepcopy
import hashlib
from pathlib import Path

import pytest

from services import active8_paper_admission as paper
from test_paper_runtime_approval import runtime_pair, reseal, wrapper


@pytest.fixture(autouse=True)
def approved_capture_source(monkeypatch):
    # The r333 transition pinned the 10/12 paired_nav_collection.py bytes, which later
    # releases changed under their own approvals. Pin the current bytes so these tests
    # keep checking the transition rules rather than today's file contents.
    current = hashlib.sha256((Path(paper.__file__).parent / 'paired_nav_collection.py').read_bytes()).hexdigest()
    monkeypatch.setitem(paper.CAPTURE_PROVENANCE_SOURCE_CHANGE, 'approved', current)


def successor(runtime_pair):
    admission, prior = deepcopy(runtime_pair)
    for cfg in (admission['configuration'], prior['configuration'], prior['admission']['configuration']):
        cfg['allocator_source_identity']['paired_nav_collection.py'] = paper.CAPTURE_PROVENANCE_SOURCE_CHANGE['previous']
    prior['configuration']['l3_inference_source_identity']['active8_paper_admission.py'] = 'acb9ac8cf162cdbb26d6f94e2c3f4d38a94706ffde48addcde07363d988bc2b5'
    reseal(prior)
    config = deepcopy(prior['configuration'])
    config['allocator_source_identity']['paired_nav_collection.py'] = paper.CAPTURE_PROVENANCE_SOURCE_CHANGE['approved']
    config['l3_inference_source_identity']['active8_paper_admission.py'] = hashlib.sha256(Path(paper.__file__).read_bytes()).hexdigest()
    current = wrapper(admission, config)
    current.update(prior_runtime_approval=prior,
                   approved_capture_provenance_source_change=deepcopy(paper.CAPTURE_PROVENANCE_SOURCE_CHANGE))
    return admission, reseal(current)


def test_exact_capture_fix_preserves_original_approval(runtime_pair):
    admission, current = successor(runtime_pair)
    before = deepcopy(current)
    assert paper.validate_runtime_approval(current, admission) == before
    assert current == before


@pytest.mark.parametrize('fault', ['risk', 'trading', 'other_source', 'reader', 'capture', 'prior',
                                  'declaration', 'live', 'nested', 'checksum', 'unknown'])
def test_capture_reapproval_rejects_any_other_change(runtime_pair, fault):
    admission, current = successor(runtime_pair)
    cfg = current['configuration']
    if fault == 'risk': cfg['risk_config']['cap'] = .9
    elif fault == 'trading': cfg['trading_config']['weight'] = .9
    elif fault == 'other_source': cfg['l3_inference_source_identity']['other.py'] = 'f' * 64
    elif fault == 'reader': cfg['l3_inference_source_identity']['active8_paper_admission.py'] = 'f' * 64
    elif fault == 'capture': cfg['allocator_source_identity']['paired_nav_collection.py'] = 'f' * 64
    elif fault == 'prior': current['prior_runtime_approval']['approved'] = False
    elif fault == 'declaration': current['approved_capture_provenance_source_change']['scope'] = 'live'
    elif fault == 'live': cfg['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED'] = '1'
    elif fault == 'nested': current['prior_runtime_approval']['approved_capture_provenance_source_change'] = {}
    elif fault == 'unknown': cfg['unknown_policy'] = True
    reseal(current)
    if fault == 'checksum': current['approval_checksum'] = 'f' * 64
    with pytest.raises(RuntimeError):
        paper.validate_runtime_approval(current, admission)
