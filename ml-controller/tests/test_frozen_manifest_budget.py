import asyncio
import hashlib
import json
import random
import sys
from pathlib import Path

import pytest
ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'ml-controller'),str(ROOT/'ml-service')]
from services.frozen_manifest_budget import canonical_manifest_bytes, COMPACT_MAX_BYTES
from graphs import daily_pipeline_v2 as graph
from app.serving_resolver import serving_manifest_digest, ServingPoolResolutionError


def evidence(payload):
    return {'schema_version':'pipeline-modal-serving-manifest-v1','models':[],
        'active8_nav_inference':{'schema_version':'active8-nav-frozen-inference-v1',
        'scope':'frozen_compute_only','publication_receipt':{'paper_admission':payload}}}


def test_large_evidence_preserves_controller_modal_digest_and_all_bytes():
    # Two copies of a model, as in the original Paper configuration + bundle.
    member = [random.Random(i).random() for i in range(48_000)]
    value = evidence({'configuration':member,'candidate_configuration':member})
    raw = canonical_manifest_bytes(value)
    assert len(raw)>COMPACT_MAX_BYTES
    expected=hashlib.sha256(raw).hexdigest()
    assert graph._pipeline_modal_canonical_digest(value)==serving_manifest_digest(value)==expected
    restored=json.loads(raw)
    assert restored==value


@pytest.mark.parametrize('value',[
    {'junk':'x'*(COMPACT_MAX_BYTES+1)},
    evidence({'huge':'x'*(4*COMPACT_MAX_BYTES)}),
    {**evidence({}),'models':['x'*COMPACT_MAX_BYTES]},
    {'active8_nav_inference':{'schema_version':'fake','scope':'frozen_compute_only','data':'x'*COMPACT_MAX_BYTES}},
])
def test_both_sides_reject_unsupported_oversize(value):
    with pytest.raises(RuntimeError):graph._pipeline_modal_canonical_digest(value)
    with pytest.raises(ServingPoolResolutionError):serving_manifest_digest(value)


def test_invalid_manifest_fails_before_feature_and_l2_cost(monkeypatch):
    reached=[]
    async def run_nodes(state,nodes): reached.extend(node.__name__ for node in nodes)
    async def reject(state): raise RuntimeError('manifest_budget_fixture')
    monkeypatch.setattr(graph,'_run_pipeline_nodes',run_nodes)
    monkeypatch.setattr(graph,'_attach_pipeline_modal_serving_context',reject)
    result=asyncio.run(graph.run_pipeline_v2_until_modal_prediction_spawn('2026-10-01','fixture'))
    assert result['status']=='error'
    assert reached==['node_load_inputs','node_load_market_env']
