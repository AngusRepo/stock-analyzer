from copy import deepcopy
import numpy as np
import pytest
from services.l4_distribution import predict,digest
from services import l4_mlp_weights as weights
from test_full_mlp_median import model


def test_complete_compact_state_has_exact_prediction_parity_and_no_inline_weights():
    from test_l4_distribution import features
    m=model();compact,objects=weights.compact_candidate({'model':m})
    rows=[{'features':features(x)} for x in (.1,.5,.9)]
    before,after=predict(rows,m),predict(rows,compact['model'])
    assert [p['expected_return_gross'] for p in before]==[p['expected_return_gross'] for p in after]
    assert len(objects)==3
    for member in compact['model']['residual_mlp']['members']:
        value=member['model'];assert 'state' not in value
        assert len(weights.load(value['weights']))==22
        assert all(a.dtype==np.float32 for a in weights.load(value['weights']).values())


def test_missing_or_corrupt_weight_reference_fails_closed_even_with_cached_sha(monkeypatch):
    compact,objects=weights.compact_candidate({'model':model()})
    ref=compact['model']['residual_mlp']['members'][0]['model']['weights'];raw=objects[ref['path']]
    with pytest.raises(ValueError,match='checksum_mismatch'):weights.prime(ref,raw[:-1])
    with pytest.raises(ValueError,match='reference_invalid'):weights.load({**ref,'path':'elsewhere.npz'})
    monkeypatch.delenv('GCS_BUCKET_NAME',raising=False)
    with pytest.raises(ValueError,match='bucket_missing'):weights.load({**ref,'bytes':ref['bytes']-1})
    value=deepcopy(compact['model']['residual_mlp']['members'][0]['model']);value['state']={}
    value['payload_checksum']=digest({k:v for k,v in value.items() if k!='payload_checksum'})
    from services.l4_residual_mlp import validate
    with pytest.raises(ValueError,match='multiple_weight_owners'):
        validate(value,anchor_model={k:compact['model'][k] for k in ('recipe','heads')})
