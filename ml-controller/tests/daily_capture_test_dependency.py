"""Mock the new external capture dependency in pre-existing pool-isolation tests.

Actual sealed producer/reader and graph integration live in test_daily_capture_sources.
These fixtures retain their intentionally tiny price panels and diagnostic sequence owner.
"""
from services.paired_nav_journal import digest

def stub_daily_capture_dependency(monkeypatch):
    from services import active8_prep_lifecycle as prep,daily_capture_sources as capture
    from graphs import daily_pipeline_v2 as graph
    monkeypatch.setattr(graph,"assert_canonical_window_open",lambda *a,**kw:None)
    async def ensure(**kw):
        return {"status":"ready","signal_date":kw["end_date"],"source_receipt_checksum":"fixture-capture"}
    # Existing tests focus on pool isolation and already mock all raw price owners.
    def bind(packet,**kw):
        return packet
    monkeypatch.setattr(prep,"ensure_active8_daily_prep",ensure)
    monkeypatch.setattr(capture,"bind_daily_capture_sources",bind)



def stub_bound_capture_dependency(monkeypatch, *, history_points=512):
    """Synthetic sealed upstream packet for downstream dispatch/merge tests.

    Does not claim producer verification; real producer/reader tests are separate.
    Preserve each tiny fixture's recent path and extend only its earlier history.
    """
    from copy import deepcopy
    from datetime import date, timedelta
    from services import daily_capture_sources as capture
    def bind(packet, *, capture_source, decision_date, **kwargs):
        result=deepcopy(packet)
        if result.get("single_capture_binding"):
            return result
        for rows in result["sources"]["prices_by_id"].values():
            if not rows:continue
            for row in rows:row.setdefault("adj_close",row["close"])
            first=date.fromisoformat(rows[0]["date"])
            prefix=[{**rows[0],"date":(first-timedelta(days=age)).isoformat()}
                    for age in reversed(range(1,max(0,history_points-len(rows))+1))]
            rows[:0]=prefix
        result["single_capture_binding"]={"schema_version":"daily-single-capture-binding-v1",
            "feature_source_digest":digest(capture_source),"price_capture":{"capture_id":"synthetic-downstream-fixture"}}
        result["source_checksum"]=digest({k:v for k,v in result.items() if k!="source_checksum"})
        return result
    monkeypatch.setattr(capture,"bind_daily_capture_sources",bind)



def attach_frozen_capture_fixture(state, series):
    """Synthetic upstream seal for legacy downstream transport/membership tests.

    The source producer itself is verified by test_daily_capture_sources.
    """
    from copy import deepcopy
    from services.state_space_series import sequence_input_fingerprints
    payloads=state.get("l3_payloads") or state["payloads"]
    stocks=[];sources={name:{} for name in ("prices_by_id","indicators_by_id","sentiment_by_id",
        "chips_by_sym","real_acc_by_id","model_stats_by_id","misc_by_id")}
    sources["tag_rows"]=[]
    for i,p in enumerate(payloads,1):
        p.setdefault("stock_id",i);sid=str(p["stock_id"])
        stocks.append({"id":p["stock_id"],"symbol":p["symbol"]})
        for name in ("prices_by_id","indicators_by_id","sentiment_by_id"):sources[name][sid]=[]
        sources["prices_by_id"][sid]=deepcopy(p.get("prices",[]))
        for name in ("real_acc_by_id","model_stats_by_id","misc_by_id"):sources[name][sid]={}
        sources["chips_by_sym"][p["symbol"]]=[]
    source={"status":"ready","signal_date":state["run_date"],"source_receipt_checksum":"synthetic-frozen-source"}
    packet={"schema_version":"payload-source-observations-v1","decision_date":state["run_date"],
        "stocks":stocks,"sources":sources,"started_at":state["run_date"]+"T09:00:00Z",
        "observed_at":state["run_date"]+"T09:01:00Z","knowledge_scope":"observed_at_capture_not_historical_asof",
        "single_capture_binding":{"schema_version":"daily-single-capture-binding-v1",
            "feature_source_digest":digest(source),"price_capture":{"capture_id":"frozen-fixture"}}}
    packet["source_checksum"]=digest(packet)
    state.update(payload_source_observations=packet,timexer_feature_source=source)
    frozen={"schema_version":"pipeline-sequence-observations-v1","signal_date":state["run_date"],
        "input_fingerprints":sequence_input_fingerprints(payloads),"series":deepcopy(series),
        "metadata":{"source_packet_checksum":packet["source_checksum"],"source":"synthetic-frozen-fixture"},
        "observed_at":state["run_date"]+"T09:02:00Z"}
    # Mirror the actual JSON wire serialization used by pipeline snapshots.
    from graphs.daily_pipeline_v2 import _json_safe
    frozen=_json_safe(frozen);frozen["source_checksum"]=digest(frozen)
    state["pipeline_sequence_observations"]=frozen
