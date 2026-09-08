import hashlib
import json
from pathlib import Path
import sys
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from services.oof_fold_lineage import verified_fold_producer_sha

class Blob:
    def __init__(self, raw):self.raw=raw
    def download_as_bytes(self):return self.raw
class Bucket:
    def __init__(self, prep):self.prep=prep;self.calls=0
    def blob(self,path):
        assert path=='old/prep/manifest.json'
        self.calls+=1
        return Blob(json.dumps(self.prep).encode())

def fixture():
    prep={'schema_version':'active8-canonical-adjusted-prep-v3','status':'ready','output_gcs_prefix':'old',
      'feature_semantic_version':'formal137-pit-rolling-rank-and-imputation-v2',
      'feature_imputation_semantic':'prior_252_row_median_then_zero_v2',
      'target_semantic_version':'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4',
      'roundtrip_cost_bps':18.,'producer_source_sha':'a'*40}
    prep['manifest_checksum']=hashlib.sha256(json.dumps(prep,sort_keys=True).encode()).hexdigest()
    parent={'prep_gcs_prefix':'old','prep_manifest':{'manifest_checksum':prep['manifest_checksum']}}
    return prep,parent

def test_original_fold_source_survives_new_release_and_cache_is_fenced(monkeypatch):
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','b'*40)
    prep,parent=fixture();bucket=Bucket(prep);cache={}
    assert verified_fold_producer_sha(parent,{},bucket=bucket,cache=cache)=='a'*40
    assert verified_fold_producer_sha(parent,{'source_producer_source_sha':'a'*40},bucket=bucket,cache=cache)=='a'*40
    assert bucket.calls==1
    with pytest.raises(ValueError,match='attestation_mismatch'):
        verified_fold_producer_sha(parent,{'source_producer_source_sha':'b'*40},bucket=bucket,cache=cache)

def test_reused_fold_cannot_change_input_under_existing_checksum():
    prep,parent=fixture();prep['producer_source_sha']='b'*40
    with pytest.raises(ValueError,match='prep_lineage_mismatch'):
        verified_fold_producer_sha(parent,{},bucket=Bucket(prep))

def test_cross_prep_window_uses_own_verified_lineage():
    prep,_=fixture();parent={'prep_gcs_prefix':'new','prep_manifest':{'manifest_checksum':'f'*64}}
    window={'source_prep_gcs_prefix':'old','source_prep_manifest_checksum':prep['manifest_checksum']}
    assert verified_fold_producer_sha(parent,window,bucket=Bucket(prep))=='a'*40
