import hashlib,json
import polars as pl
import pytest
from services.training_snapshot_integrity import verify_snapshot_manifest,verify_component_file,REQUIRED_COMPONENTS

def fixture(tmp_path):
    frame=pl.DataFrame({"stock_id":[1],"date":["2026-10-07"],"value":[1.]})
    path=tmp_path/"source.parquet";frame.write_parquet(path)
    components={name:{"name":name,"row_count":1,"gcs_uri":"gs://bucket/run/"+name+".parquet","columns":frame.columns,"bytes":path.stat().st_size,"content_checksum":"sha256:"+hashlib.sha256(path.read_bytes()).hexdigest()} for name in REQUIRED_COMPONENTS}
    meta={"start_date":"2023-07-01","end_date":"2026-10-07","component_meta":components,"components":{k:v["gcs_uri"] for k,v in components.items()}}
    snap={"kind":"backtest_dataset","business_date":"2026-10-07","row_count":len(components),"gcs_uri":"gs://bucket/run","metadata_json":json.dumps(meta)}
    seal(snap)
    return snap,path

def seal(snap):
    meta=json.loads(snap["metadata_json"])
    payload={k:snap[k] for k in ("kind","business_date","row_count")}
    payload.update({k:meta[k] for k in ("start_date","end_date","component_meta")})
    snap["checksum"]="sha256:"+hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()

def test_real_parquet_verified(tmp_path):
    snap,path=fixture(tmp_path)
    metas=verify_snapshot_manifest(snap,business_date="2026-10-07")
    assert verify_component_file(path,metas["prices"]).height==1

@pytest.mark.parametrize("field",["canonical_fundamentals","monthly_revenue","margin_data","shareholding","broker_flows"])
def test_missing_component_rejected_even_resealed(tmp_path,field):
    snap,_=fixture(tmp_path);meta=json.loads(snap["metadata_json"]);meta["component_meta"].pop(field)
    snap["metadata_json"]=json.dumps(meta);seal(snap)
    with pytest.raises(ValueError,match="components_missing"):verify_snapshot_manifest(snap,business_date="2026-10-07")

def test_wrong_date_and_manifest_rejected(tmp_path):
    snap,_=fixture(tmp_path)
    with pytest.raises(ValueError,match="date_mismatch"):verify_snapshot_manifest(snap,business_date="2026-10-08")
    snap["checksum"]="sha256:"+"0"*64
    with pytest.raises(ValueError,match="checksum"):verify_snapshot_manifest(snap,business_date="2026-10-07")

@pytest.mark.parametrize("mutation",["bytes","row_count","columns","content_checksum"])
def test_real_parquet_tamper_rejected(tmp_path,mutation):
    snap,path=fixture(tmp_path);meta=json.loads(snap["metadata_json"])["component_meta"]["prices"]
    meta[mutation]=[] if mutation=="columns" else ("sha256:"+"0"*64 if mutation=="content_checksum" else 999)
    with pytest.raises(ValueError,match="component_(checksum|shape)_mismatch"):verify_component_file(path,meta)
