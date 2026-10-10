"""Bind daily root inputs before either formal or private-slate features are built."""
import hashlib,json
from datetime import datetime,timezone
from services.paired_nav_journal import digest
from services.payload_builder import _read_frozen_payload_sources
from services.training_price_capture import (load_training_price_capture,
    load_training_institutional_capture,load_training_market_cap_capture)


def bind_daily_capture_sources(packet, *, capture_source, decision_date, bucket=None):
    stocks=packet.get("stocks") or []
    raw=_read_frozen_payload_sources(packet,stocks,decision_date)
    if (not isinstance(capture_source,dict) or capture_source.get("status")!="ready"
            or capture_source.get("signal_date")!=decision_date):
        raise ValueError("daily_capture_feature_source_required")
    existing=packet.get("single_capture_binding")
    if existing is not None:
        if existing.get("feature_source_digest")!=digest(capture_source):
            raise ValueError("daily_capture_frozen_source_changed")
        return packet
    if bucket is None:
        from services.walk_forward_retrain import _get_bucket
        bucket=_get_bucket()
    if bucket is None:raise ValueError("daily_capture_bucket_missing")
    prefix=capture_source.get("source_gcs_prefix")
    receipt=json.loads(bucket.blob(f"{prefix}/prep/immutable_receipt.json").download_as_bytes())
    unsigned={k:v for k,v in receipt.items() if k!="receipt_checksum"}
    checksum=hashlib.sha256(json.dumps(unsigned,sort_keys=True).encode()).hexdigest()
    if (checksum!=receipt.get("receipt_checksum") or checksum!=capture_source.get("source_receipt_checksum")
            or receipt.get("status")!="ready" or receipt.get("business_date")!=decision_date
            or receipt.get("output_gcs_prefix")!=prefix):
        raise ValueError("daily_capture_feature_receipt_mismatch")
    from services.active_model_policy import daily_price_history_limit
    prices,indicators,price=load_training_price_capture(bucket,
        sequence_gcs_prefix=capture_source.get("sequence_gcs_prefix"),stock_rows=stocks,
        prices_lookback=daily_price_history_limit(),run_date=decision_date,
        prior_prices=raw["prices_by_id"],prior_indicators=raw["indicators_by_id"])
    expected=receipt.get("price_capture") or {}
    if any(price.get(k)!=expected.get(k) for k in ("capture_id","capture_manifest_sha256","checksums","sequence_manifest_checksum")):
        raise ValueError("daily_capture_root_feature_price_mismatch")
    # Private/formal pools may differ; their formula owner and recipe must not.
    current_indicator=price.get("indicator_capture") or {}
    expected_indicator=expected.get("indicator_capture") or {}
    if any(not current_indicator.get(k) or current_indicator.get(k)!=expected_indicator.get(k)
           for k in ("recipe","formula_sha256","runner_sha256")):
        raise ValueError("daily_capture_indicator_owner_mismatch")
    chips,institutional=load_training_institutional_capture(bucket,price_capture=price,run_date=decision_date,
        stock_rows=stocks,prices_map=prices,prior_chips=raw["chips_by_sym"])
    prior={sid:(misc.get("per_stock_ts") or {}) for sid,misc in raw["misc_by_id"].items()}
    dated,cap=load_training_market_cap_capture(bucket,price_capture=price,stock_rows=stocks,prices_map=prices,prior_ts=prior)
    for name,proof in (("institutional_capture",institutional),("market_cap_capture",cap)):
        expected=receipt.get(name) or {}
        keys=("capture_id","capture_manifest_sha256","checksums") if name=="institutional_capture" else ("capture_id","capture_manifest_sha256","market_value_sha256")
        if any(proof.get(k)!=expected.get(k) for k in keys):raise ValueError("daily_capture_root_feature_aux_mismatch:"+name)
    from services.training_auxiliary_capture import load_training_auxiliary_capture
    dated,chips,auxiliary=load_training_auxiliary_capture(bucket,price_capture=price,stock_rows=stocks,
        prices_map=prices,prior_ts=dated,prior_chips=chips,run_date=decision_date)
    expected=receipt.get("auxiliary_capture") or {}
    if any(auxiliary.get(k)!=expected.get(k) for k in ("capture_id","capture_manifest_sha256")):
        raise ValueError("daily_capture_root_feature_auxiliary_mismatch")
    from services.training_long_sources import bind_long_sources
    dated,chips,long_source=bind_long_sources(bucket,price_capture=price,stock_rows=stocks,
        prices_map=prices,prior_ts=dated,prior_chips=chips,run_date=decision_date)
    expected=receipt.get("long_source_capture") or {}
    if any(long_source.get(name,{}).get("manifest_sha256")!=expected.get(name,{}).get("manifest_sha256") for name in ("broker","holding")):
        raise ValueError("daily_capture_root_feature_long_source_mismatch")
    from services.training_global_capture import read_market_history
    expected=receipt.get("global_capture") or {}
    history,global_capture=read_market_history(bucket,price_capture=price,us_component=expected.get("us_component") or {})
    if global_capture["history_sha256"]!=expected.get("history_sha256"):
        raise ValueError("daily_capture_global_history_mismatch")
    for sid,misc in raw["misc_by_id"].items():misc["per_stock_ts"]=dated.get(sid,{})
    raw.update(prices_by_id=prices,indicators_by_id=indicators,chips_by_sym=chips)
    binding={"schema_version":"daily-single-capture-binding-v1","feature_source_digest":digest(capture_source),
        "price_capture":price,"institutional_capture":institutional,"market_cap_capture":cap,"auxiliary_capture":auxiliary,"long_source_capture":long_source,"global_capture":global_capture,
        "prior_source_checksum":packet["source_checksum"]}
    body={k:v for k,v in packet.items() if k!="source_checksum"}
    body.update(sources=raw,global_market_history=history,single_capture_binding=binding,observed_at=datetime.now(timezone.utc).isoformat())
    body=json.loads(json.dumps(body,allow_nan=False))
    result={**body,"source_checksum":digest(body)}
    _read_frozen_payload_sources(result,stocks,decision_date)
    return result


def sequences_from_daily_capture(payloads, *, packet, decision_date, target_points):
    """Sequence models and root features consume the same actual adjusted values."""
    if type(target_points) is not int or target_points<=0:raise ValueError("daily_capture_sequence_target_invalid")
    binding=packet.get("single_capture_binding") or {}
    if binding.get("schema_version")!="daily-single-capture-binding-v1":raise ValueError("daily_capture_sequence_binding_required")
    stocks=[{"id":p["stock_id"],"symbol":p["symbol"]} for p in payloads]
    raw=_read_frozen_payload_sources(packet,stocks,decision_date)
    out=[]
    for p in payloads:
        prices=raw["prices_by_id"][p["stock_id"]]
        if prices!=p.get("prices"):raise ValueError("daily_capture_sequence_payload_changed")
        rows=prices[-target_points:]
        out.append({"symbol":p["symbol"],"dates":[r["date"] for r in rows],"prices":[r["adj_close"] for r in rows],
            "price_basis":"finlab_adjusted_close","sequence_source":"finlab_single_capture",
            "history_points_available":len(prices),"status":"ready" if rows else "unavailable",
            "reason":None if rows else "payload_market_dates_missing"})
    return out,{"schema_version":"state-space-single-capture-v1","source":"finlab_single_capture",
        "decision_date":decision_date,"target_points":target_points,"input_series":len(payloads),"output_series":len(out),
        "capture_id":binding["price_capture"]["capture_id"],"feature_source_digest":binding["feature_source_digest"],
        "source_packet_checksum":packet["source_checksum"],"knowledge_scope":"observed_at_capture_not_historical_asof"}
