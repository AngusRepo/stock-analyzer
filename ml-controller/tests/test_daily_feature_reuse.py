import hashlib,json
import pytest
from services import active8_prep_lifecycle as lifecycle


class Bucket:
    def __init__(self,data):self.data=data
    def blob(self,name):
        data=self.data
        class Blob:
            def exists(self):return name in data
            def download_as_text(self):return data[name].decode()
            def download_as_bytes(self):return data[name]
        return Blob()


def fixture(tmp_path,monkeypatch):
    monkeypatch.setattr(lifecycle,"Path",lambda _:tmp_path/"lifecycle.py")
    prefix="old-source"
    data={prefix+"/prep/batch_0.npz":b"fixture-only",prefix+"/prep/feature_names.json":b"[]"}
    receipt={"schema_version":"active8-immutable-feature-prep-receipt-v2","status":"ready",
        "business_date":"2026-10-08","output_gcs_prefix":prefix,"producer_source_sha":"a"*40,
        "feature_semantic_version":lifecycle.FEATURE_SEMANTIC_VERSION,
        "feature_imputation_semantic":lifecycle.FEATURE_IMPUTATION_SEMANTIC_VERSION,
        "training_dispatched":False,"batch_count":1,"feature_names_path":prefix+"/prep/feature_names.json",
        "output_checksums":{p:hashlib.sha256(raw).hexdigest() for p,raw in data.items()},
        "price_capture":{"sequence_manifest_checksum":"b"*64}}
    receipt["receipt_checksum"]=hashlib.sha256(json.dumps(receipt,sort_keys=True).encode()).hexdigest()
    data[prefix+"/prep/immutable_receipt.json"]=json.dumps(receipt).encode()
    pin={"source_gcs_prefix":prefix,"receipt_checksum":receipt["receipt_checksum"],
        "producer_source_sha":"a"*40,"snapshot_checksum":"c"*64,"sequence_manifest_checksum":"b"*64,
        "sequence_gcs_prefix":"sequence","model_profile_schema_version":"profile"}
    plan={"business_date":"2026-10-08","snapshot_checksum":"c"*64,"sequence_manifest_checksum":"b"*64,
        "sequence_gcs_prefix":"sequence","feature_semantic_version":lifecycle.FEATURE_SEMANTIC_VERSION,
        "feature_imputation_semantic":lifecycle.FEATURE_IMPUTATION_SEMANTIC_VERSION,"producer_source_sha":"d"*40}
    (tmp_path/"active8_feature_sources.json").write_text(json.dumps({plan["business_date"]:pin}))
    return Bucket(data),pin,plan


def test_registered_reuse_preserves_old_producer_and_verifies_actual_bytes(tmp_path,monkeypatch):
    bucket,pin,plan=fixture(tmp_path,monkeypatch)
    before=dict(bucket.data)
    result=lifecycle._registered_feature_source(bucket,plan,"profile")
    assert result["source_gcs_prefix"]=="old-source" and result["training_dispatched"] is False
    assert bucket.data==before
    assert json.loads(bucket.data["old-source/prep/immutable_receipt.json"])["producer_source_sha"]=="a"*40
    bucket.data["old-source/prep/batch_0.npz"]+=b"tampered"
    with pytest.raises(ValueError,match="sealed_checksum_mismatch"):
        lifecycle._registered_feature_source(bucket,plan,"profile")


@pytest.mark.parametrize("field",["snapshot_checksum","sequence_manifest_checksum","sequence_gcs_prefix",
    "receipt_checksum","producer_source_sha","model_profile_schema_version"])
def test_registered_reuse_rejects_changed_bindings(tmp_path,monkeypatch,field):
    bucket,pin,plan=fixture(tmp_path,monkeypatch)
    pin[field]="f"*64
    (tmp_path/"active8_feature_sources.json").write_text(json.dumps({plan["business_date"]:pin}))
    with pytest.raises(ValueError):lifecycle._registered_feature_source(bucket,plan,"profile")


def test_other_date_does_not_reuse_registered_inputs(tmp_path,monkeypatch):
    bucket,pin,plan=fixture(tmp_path,monkeypatch)
    plan["business_date"]="2026-10-09"
    assert lifecycle._registered_feature_source(bucket,plan,"profile") is None
