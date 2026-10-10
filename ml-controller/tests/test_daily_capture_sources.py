import asyncio,hashlib,json
from copy import deepcopy
import pytest
from services.paired_nav_journal import digest
from services.daily_capture_sources import bind_daily_capture_sources,sequences_from_daily_capture
from services.training_price_capture import load_training_institutional_capture,load_training_market_cap_capture
from test_training_market_cap_capture import setup
from test_training_price_capture import institutional_fixture

DAY="2026-09-29"
def fixture():
    bucket,prices,price=setup()
    from test_training_global_capture import attach_daily_calendar
    from test_training_price_capture import load
    attach_daily_calendar(bucket)
    prices,_,price=load(bucket)
    institution,_,_=institutional_fixture()
    bucket.data.update({k:v for k,v in institution.data.items() if "chip_diversity_full_vintage" in k})
    stocks=[{"id":1,"symbol":"3004"}]
    _,chip=load_training_institutional_capture(bucket,price_capture=price,stock_rows=stocks,prices_map=prices,prior_chips={},run_date=DAY)
    _,cap=load_training_market_cap_capture(bucket,price_capture=price,stock_rows=stocks,prices_map=prices,prior_ts={})
    receipt={"status":"ready","business_date":DAY,"output_gcs_prefix":"features","price_capture":price,
             "institutional_capture":chip,"market_cap_capture":cap}
    from test_training_auxiliary_capture import attach
    receipt["auxiliary_capture"]=attach(bucket,price)
    from test_training_long_sources import attach_long
    receipt["long_source_capture"]=attach_long(bucket,price)
    from test_training_global_capture import attach_global
    receipt["global_capture"]=attach_global(bucket,price)
    receipt["receipt_checksum"]=hashlib.sha256(json.dumps(receipt,sort_keys=True).encode()).hexdigest()
    bucket.data["features/prep/immutable_receipt.json"]=json.dumps(receipt).encode()
    source={"status":"ready","signal_date":DAY,"source_gcs_prefix":"features","source_receipt_checksum":receipt["receipt_checksum"],"sequence_gcs_prefix":"seq"}
    raw={name:{"1":[]} for name in ("prices_by_id","indicators_by_id","sentiment_by_id")}
    raw.update({name:{"1":{}} for name in ("real_acc_by_id","model_stats_by_id","misc_by_id")})
    raw.update(chips_by_sym={"3004":[]},tag_rows=[])
    raw["prices_by_id"]["1"]=[{"date":DAY,"close":999.}]
    packet={"schema_version":"payload-source-observations-v1","decision_date":DAY,"stocks":stocks,"sources":raw,
        "started_at":"2026-09-29T10:00:00+00:00","observed_at":"2026-09-29T10:01:00+00:00","knowledge_scope":"observed_at_capture_not_historical_asof"}
    packet["source_checksum"]=digest(packet)
    return bucket,source,packet

def test_real_binding_sequence_and_frozen_retry():
    bucket,source,packet=fixture();before=deepcopy(packet)
    bound=bind_daily_capture_sources(packet,capture_source=source,decision_date=DAY,bucket=bucket)
    assert packet==before and bound["sources"]["prices_by_id"]["1"][0]["adj_close"]==50.5
    assert bound["sources"]["chips_by_sym"]["3004"][0]["dealer_net"]==10.
    assert bound["sources"]["misc_by_id"]["1"]["per_stock_ts"][DAY]["market_cap_proxy"] is None
    payload=[{"symbol":"3004","stock_id":1,"prices":bound["sources"]["prices_by_id"]["1"]}]
    seq,meta=sequences_from_daily_capture(payload,packet=bound,decision_date=DAY,target_points=100)
    assert seq[0]["prices"]==[50.5,51.] and meta["capture_id"]=="capture-1"
    class NoReads:
        def blob(self,*a):pytest.fail("same-run retry must not reread source")
    assert bind_daily_capture_sources(bound,capture_source=source,decision_date=DAY,bucket=NoReads())==bound
    payload[0]["prices"]=deepcopy(payload[0]["prices"]);payload[0]["prices"][0]["adj_close"]=999.
    with pytest.raises(ValueError,match="payload_changed"):
        sequences_from_daily_capture(payload,packet=bound,decision_date=DAY,target_points=100)

@pytest.mark.parametrize("fault",["source","receipt","auxiliary","frozen"])
def test_rejects_missing_tampered_or_switched_capture(fault):
    bucket,source,packet=fixture()
    if fault=="source":source=None
    elif fault=="receipt":source["source_receipt_checksum"]="bad"
    elif fault=="auxiliary":
        r=json.loads(bucket.data["features/prep/immutable_receipt.json"]);r.pop("receipt_checksum")
        r["institutional_capture"]["capture_id"]="wrong"
        r["receipt_checksum"]=hashlib.sha256(json.dumps(r,sort_keys=True).encode()).hexdigest()
        source["source_receipt_checksum"]=r["receipt_checksum"];bucket.data["features/prep/immutable_receipt.json"]=json.dumps(r).encode()
    else:
        packet=bind_daily_capture_sources(packet,capture_source=source,decision_date=DAY,bucket=bucket)
        source["source_receipt_checksum"]="changed"
    with pytest.raises(ValueError,match="daily_capture_"):
        bind_daily_capture_sources(packet,capture_source=source,decision_date=DAY,bucket=bucket)

def test_actual_graph_builds_from_capture_then_sequence_without_d1(monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    from services import active8_prep_lifecycle as prep,daily_capture_sources as capture
    bucket,source,packet=fixture()
    async def ensure(**kwargs):
        assert kwargs["feature_only"] is True
        return source
    monkeypatch.setattr(prep,"ensure_active8_daily_prep",ensure)
    original=capture.bind_daily_capture_sources
    monkeypatch.setattr(capture,"bind_daily_capture_sources",lambda p,**kw:original(p,bucket=bucket,**kw))
    state={"run_date":DAY,"market_env":{},"active_stocks":[{"id":1,"symbol":"3004"}],"payload_source_observations":packet}
    update=asyncio.run(graph.node_build_payloads(state));state.update(update)
    assert state["timexer_feature_source"]==source
    payload=state["payloads"][0]
    assert payload["prices"][0]["adj_close"]==50.5
    assert payload["market_env"]["per_stock_ts"]["2026-09-28"]["market_cap_proxy"]==100.
    monkeypatch.setattr(graph,"enrich_state_space_series_with_long_history",lambda *a,**kw:pytest.fail("old D1 sequence read"))
    series,_=graph._pipeline_sequence_inputs(state,state["payloads"])
    assert series[0]["prices"]==[50.5,51.]
    assert asyncio.run(graph.node_build_payloads(state))==update


def test_actual_dispatch_rejects_old_sources_and_accepts_bound_graph(monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    from services import active8_prep_lifecycle as prep,daily_capture_sources as capture
    from test_active8_cutover_contract import _artifact
    from test_pipeline_modal_manifest_parity import _pool_and_rows
    bucket,source,packet=fixture()
    artifact=_artifact();pool,registry=_pool_and_rows(artifact)
    manifest,sha=graph._build_pipeline_modal_serving_manifest(pool,registry_rows=registry,active8_ensemble=artifact)
    state={"run_date":DAY,"market_env":{},"active_stocks":[{"id":1,"symbol":"3004"}],"payload_source_observations":packet,
        "decision_universe_frozen_at":"2026-09-29T10:00:00Z","pipeline_modal_serving_context":{
        "schema_version":"pipeline-modal-serving-context-v1","serving_pool":graph._pipeline_modal_runtime_pool_from_manifest(pool,manifest),
        "serving_manifest":manifest,"serving_manifest_digest":sha,"model_status":{r['model']:r['effective_status'] for r in manifest['models']},
        "active_versions":{r['model']:r['version'] for r in manifest['models']},"pool_versions_loaded":True,"expected_source_sha":"a"*40}}
    with pytest.raises(ValueError,match="pipeline_daily_single_capture_required"):
        asyncio.run(graph._build_pipeline_modal_prediction_payload(state,state_gcs_uri="gs://fixture/state"))
    async def ensure(**kw):return source
    original=capture.bind_daily_capture_sources
    monkeypatch.setattr(prep,"ensure_active8_daily_prep",ensure)
    monkeypatch.setattr(capture,"bind_daily_capture_sources",lambda p,**kw:original(p,bucket=bucket,**kw))
    state.update(asyncio.run(graph.node_build_payloads(state)))
    monkeypatch.setattr(graph.LEARNING_D1_CLIENT,"query",lambda *a,**kw:[])
    monkeypatch.setattr(graph.kv_client,"get_json",lambda *a,**kw:None)
    monkeypatch.setattr(graph,"_pipeline_modal_prediction_callback_url",lambda:"https://fixture.invalid")
    monkeypatch.setattr(graph,"_pipeline_modal_prediction_callback_token",lambda:"fixture")
    request=asyncio.run(graph._build_pipeline_modal_prediction_payload(state,state_gcs_uri="gs://fixture/state"))
    assert request["timexer_feature_source"]==source
    assert request["payloads"][0]["prices"][0]["adj_close"]==50.5
    assert request["sequence_series"][0]["prices"]==[50.5,51.]
    state["pipeline_sequence_observations"]["metadata"]["source_packet_checksum"]="old-packet"
    with pytest.raises(ValueError,match="pipeline_daily_sequence_capture_mismatch"):
        asyncio.run(graph._build_pipeline_modal_prediction_payload(state,state_gcs_uri="gs://fixture/state"))

@pytest.mark.parametrize("field",["recipe","formula_sha256","runner_sha256"])
def test_resealed_different_indicator_owner_rejected(field):
    bucket,source,packet=fixture()
    r=json.loads(bucket.data["features/prep/immutable_receipt.json"]);r.pop("receipt_checksum")
    r["price_capture"]["indicator_capture"][field]="wrong"
    r["receipt_checksum"]=hashlib.sha256(json.dumps(r,sort_keys=True).encode()).hexdigest()
    source["source_receipt_checksum"]=r["receipt_checksum"]
    bucket.data["features/prep/immutable_receipt.json"]=json.dumps(r).encode()
    with pytest.raises(ValueError,match="daily_capture_indicator_owner_mismatch"):
        bind_daily_capture_sources(packet,capture_source=source,decision_date=DAY,bucket=bucket)
