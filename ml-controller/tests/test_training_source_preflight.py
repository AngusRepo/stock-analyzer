import asyncio
import copy
import hashlib
import json
from unittest.mock import AsyncMock
import pytest
from services.training_source_preflight import require_single_adjustment_capture


def seal(value,compact=False):
    value=copy.deepcopy(value)
    value.pop("manifest_checksum",None)
    opts={"sort_keys":True}
    if compact:opts["separators"]=(",",":")
    value["manifest_checksum"]=hashlib.sha256(json.dumps(value,**opts).encode()).hexdigest()
    return value



def feature_fixture():
    import io
    import numpy as np
    names = json.dumps([f"f{i}" for i in range(137)]).encode()
    buf = io.BytesIO()
    np.savez(buf, X=np.zeros((2,137)), missingness_rates=np.zeros(137))
    objects = {"prep/prep/feature_names.json":names,"prep/prep/batch_0.npz":buf.getvalue()}
    fields = {"source_gcs_prefix":"source", "batch_rows":[2],"output_rows":2,
              "source_checksums":{"source/prep/feature_names.json":hashlib.sha256(names).hexdigest()},
              "output_checksums":{"prep/prep/batch_0.npz":hashlib.sha256(buf.getvalue()).hexdigest()}}
    return fields, objects


def manifests():
    seq=seal({"status":"ready","output_gcs_prefix":"seq", "lane_reports":[{"lane":"daily_price","source_uri":{
        "capture_id":"capture-1","close":"gs://bucket/capture/adj_close.parquet","open":"gs://bucket/capture/adj_open.parquet",
        "checksums":{"adj_close":"a"*64,"adj_open":"b"*64}}}]},True)
    prep=seal({"status":"ready","output_gcs_prefix":"prep","sequence_gcs_prefix":"seq","sequence_manifest_checksum":seq["manifest_checksum"],
        "market_cap_capture":{"schema_version":"training-market-cap-capture-binding-v1","capture_id":"capture-1",
            "market_value_sha256":"f"*64,"actual_values_sha256":"e"*64},
        "institutional_capture":{"schema_version":"training-institutional-capture-binding-v1","capture_id":"capture-1",
            "actual_values_sha256":"d"*64,"checksums":{k:"e"*64 for k in ("foreign_net","trust_net","dealer_self_net","dealer_hedge_net")}},
        "price_capture":{"schema_version":"training-price-capture-binding-v1","capture_id":"capture-1",
            "sequence_manifest_checksum":seq["manifest_checksum"],"actual_price_values_sha256":"c"*64,
            "checksums":{"adj_close":"a"*64,"adj_open":"b"*64}}})
    from test_training_session_calendar import calendar_fixture
    calendar_bucket,calendar=calendar_fixture()
    prep["price_capture"].update(calendar)
    prep["price_capture"]["indicator_capture"]={"recipe":"Worker computeTechnicalIndicators, latest 70 observed raw bars, minimum 20","rows":100,
        **{key:"d"*64 for key in ("formula_sha256","runner_sha256","input_sha256","output_sha256")}}
    from test_training_auxiliary_capture import attach
    class AuxBucket:
        data={}
    aux_bucket=AuxBucket()
    prep["auxiliary_capture"]=attach(aux_bucket,{"capture_manifest_path":"capture/raw/daily_price_full_vintage/manifest.json","capture_id":"capture-1"})
    from test_training_long_sources import attach_long
    prep["long_source_capture"]=attach_long(aux_bucket,{"capture_manifest_path":"capture/raw/daily_price_full_vintage/manifest.json","capture_id":"capture-1"})
    from test_training_global_capture import attach_global
    prep["global_capture"]=attach_global(calendar_bucket,prep["price_capture"])
    prep.update(feature_fixture()[0])
    return seal(prep),seq


class Bucket:
    name="fixture"
    def __init__(self,prep,seq):
        from test_training_session_calendar import calendar_fixture
        bucket,_=calendar_fixture()
        from test_training_auxiliary_capture import attach
        attach(bucket,{"capture_manifest_path":"capture/raw/daily_price_full_vintage/manifest.json","capture_id":"capture-1"})
        from test_training_long_sources import attach_long
        attach_long(bucket,{"capture_manifest_path":"capture/raw/daily_price_full_vintage/manifest.json","capture_id":"capture-1"})
        from test_training_global_capture import attach_global
        attach_global(bucket,prep["price_capture"])
        self.objects={**bucket.data,**feature_fixture()[1],"prep/prep/manifest.json":prep,"seq/prep/sequence_manifest.json":seq}
    def blob(self,path):
        outer=self
        class Blob:
            def exists(self):return path in outer.objects
            def download_as_bytes(self):
                value=outer.objects[path]
                return value if isinstance(value,bytes) else json.dumps(value).encode()
            def download_as_text(self):return self.download_as_bytes().decode()
        return Blob()


def test_valid_capture_has_narrow_provenance_claim():
    result=require_single_adjustment_capture(Bucket(*manifests()),prep_gcs_prefix="prep",sequence_gcs_prefix="seq")
    assert result["capture_id"]=="capture-1" and result["all_root_sources_certified"] is False


@pytest.mark.parametrize("fault,reason",[("mixed","single_adjustment_capture_required"),("tamper","manifest_invalid"),
    ("link","binding_mismatch"),("missing","manifest_missing"),("checksum","capture_invalid"),("split","capture_mixed")])
def test_provenance_faults_block(fault,reason):
    prep,seq=manifests()
    if fault=="mixed":seq["lane_reports"][0]["source_uri"]={"close":["gs://old/close","gs://new/close"],"open":["gs://old/open","gs://new/open"]}
    elif fault=="tamper":seq["status"]="tampered"
    elif fault=="checksum":seq["lane_reports"][0]["source_uri"]["checksums"]["adj_open"]="bad"
    elif fault=="split":seq["lane_reports"][0]["source_uri"]["open"]="gs://bucket/other/adj_open.parquet"
    if fault!="tamper":seq=seal(seq,True)
    prep["sequence_manifest_checksum"]=seq["manifest_checksum"] if fault!="link" else "wrong"
    prep=seal(prep)
    bucket=Bucket(prep,seq)
    if fault=="missing":bucket.objects.pop("seq/prep/sequence_manifest.json")
    with pytest.raises(ValueError,match=reason):require_single_adjustment_capture(bucket,prep_gcs_prefix="prep",sequence_gcs_prefix="seq")


def test_paid_oof_dispatch_not_called_for_mixed_source(monkeypatch):
    from routers import walk_forward as wf
    from services import walk_forward_retrain as retrain,modal_client
    prep,seq=manifests();seq["lane_reports"][0]["source_uri"].pop("capture_id")
    seq=seal(seq,True);prep["sequence_manifest_checksum"]=seq["manifest_checksum"];prep=seal(prep)
    monkeypatch.setattr(retrain,"_get_bucket",lambda:Bucket(prep,seq))
    spawn=AsyncMock();monkeypatch.setattr(modal_client,"spawn_walk_forward_orchestrator",spawn)
    req=wf.WalkForwardRequest(start_date="2026-01-01",end_date="2026-04-01",confirm=True,prep_gcs_prefix="prep",sequence_gcs_prefix="seq")
    with pytest.raises(wf.HTTPException) as error:asyncio.run(wf.walk_forward_run(req))
    assert error.value.status_code==422
    assert "single_adjustment_capture_required" in str(error.value.detail)
    spawn.assert_not_called()


@pytest.mark.parametrize("fault",["missing","different_capture","missing_field"])
def test_institutional_lineage_is_required(fault):
    prep,seq=manifests()
    if fault=="missing":prep.pop("institutional_capture")
    elif fault=="different_capture":prep["institutional_capture"]["capture_id"]="other"
    else:prep["institutional_capture"]["checksums"].pop("dealer_hedge_net")
    with pytest.raises(ValueError,match="institutional_binding_required"):
        require_single_adjustment_capture(Bucket(seal(prep),seq),prep_gcs_prefix="prep",sequence_gcs_prefix="seq")


@pytest.mark.parametrize("fault",[None,"omitted_batch","unsealed_names","wrong_count","outside_prefix"])
def test_prep_inventory_requires_every_batch_and_feature_names(monkeypatch,fault):
    from routers import retrain_trigger as rt
    from test_training_price_capture import Bucket as RawBucket
    bucket=RawBucket();prefix="features";names=f"{prefix}/prep/feature_names.json"
    bucket.data[names]=b'["feature"]'
    bucket.data[f"{prefix}/prep/batch_0.npz"]=b'batch-zero'
    bucket.data[f"{prefix}/prep/batch_1.npz"]=b'batch-one'
    checksums={path:hashlib.sha256(raw).hexdigest() for path,raw in bucket.data.items()}
    receipt={"schema_version":rt.ACTIVE8_PREP_RECEIPT_SCHEMA_VERSION,"status":"ready",
        "business_date":"2026-10-07","output_gcs_prefix":prefix,"batch_count":2,
        "feature_names_path":names,"output_checksums":checksums}
    if fault=="omitted_batch":checksums.pop(f"{prefix}/prep/batch_1.npz")
    elif fault=="unsealed_names":checksums.pop(names)
    elif fault=="wrong_count":receipt["batch_count"]=3
    elif fault=="outside_prefix":checksums["another/prep/batch_0.npz"]=checksums.pop(f"{prefix}/prep/batch_0.npz")
    receipt["receipt_checksum"]=hashlib.sha256(json.dumps(receipt,sort_keys=True).encode()).hexdigest()
    bucket.data[f"{prefix}/prep/immutable_receipt.json"]=json.dumps(receipt).encode()
    monkeypatch.setattr(rt,"_prep_receipt_lineage_matches",lambda *a,**kw:True)
    if fault:
        with pytest.raises(ValueError,match="batch_inventory_invalid"):
            rt._verified_prep_only_receipt(bucket,prefix,"2026-10-07",expected_producer_source_sha="test")
    else:
        assert rt._verified_prep_only_receipt(bucket,prefix,"2026-10-07",expected_producer_source_sha="test")["batch_count"]==2


@pytest.mark.parametrize("fault",["missing","identity","hash"])
def test_market_cap_binding_required(fault):
    prep,seq=manifests()
    if fault=="missing":prep.pop("market_cap_capture")
    elif fault=="identity":prep["market_cap_capture"]["capture_id"]="other"
    else:prep["market_cap_capture"]["market_value_sha256"]=""
    with pytest.raises(ValueError,match="market_cap_binding_required"):
        require_single_adjustment_capture(Bucket(seal(prep),seq),prep_gcs_prefix="prep",sequence_gcs_prefix="seq")


def test_missing_official_calendar_stops_actual_paid_oof_dispatch(monkeypatch):
    from routers import walk_forward as wf
    from services import walk_forward_retrain as retrain,modal_client
    prep,seq=manifests();bucket=Bucket(prep,seq)
    path=prep["price_capture"]["capture_manifest_path"]
    manifest=json.loads(bucket.objects[path]);manifest.pop("official_calendar_sha256")
    bucket.objects[path]=json.dumps(manifest).encode()
    prep["price_capture"]["capture_manifest_sha256"]=hashlib.sha256(bucket.objects[path]).hexdigest()
    bucket.objects["prep/prep/manifest.json"]=seal(prep)
    monkeypatch.setattr(retrain,"_get_bucket",lambda:bucket)
    spawn=AsyncMock();monkeypatch.setattr(modal_client,"spawn_walk_forward_orchestrator",spawn)
    req=wf.WalkForwardRequest(start_date="2026-01-01",end_date="2026-04-01",confirm=True,prep_gcs_prefix="prep",sequence_gcs_prefix="seq")
    with pytest.raises(wf.HTTPException,match="training_calendar_official_required"):
        asyncio.run(wf.walk_forward_run(req))
    spawn.assert_not_called()

def test_missing_indicator_owner_stops_paid_boundary():
    prep,seq=manifests()
    prep["price_capture"].pop("indicator_capture")
    prep=seal(prep)
    with pytest.raises(ValueError,match="training_source_indicator_owner_binding_required"):
        require_single_adjustment_capture(Bucket(prep,seq),prep_gcs_prefix="prep",sequence_gcs_prefix="seq")
