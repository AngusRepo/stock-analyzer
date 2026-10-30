"""m-d end to end (Wei 10/30): a model with no usable score all day aborts the day through
node_ml_predict alike for feature, GNN and sequence models -- the error ops line first, then
r33_model_missing_for_day. Outside R33 the zero-usable raise is unchanged."""
import asyncio
import sys
from copy import deepcopy
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ml-service"))

from graphs import daily_pipeline_v2 as P
from app import serving_resolver as R
from services import d1_domain_client, paired_nav_collection, r33_rank_pool
from services.alpha_model_roster import R33_MODELS
from services.paired_nav_journal import digest
from services.r33_calibration_job import POOL_SOURCE
from services.r33_serving_inputs import COVERAGE_LOG_CRON
from test_r33_l4_equal7 import _ensemble
from test_pipeline_frozen_sequence_membership import dispatched  # noqa: F401 - the legacy (non-R33) day

DAY = "2026-09-09"
SYMBOLS = ["2330", "2317", "2454", "2303", "2881"]
EXT = {"LightGBM": "joblib", "ExtraTrees": "joblib", "TabM": "pt", "GNN": "pt", "TimeXer": "pt", "PatchTST": "zip",
       "iTransformer": "zip"}
SEQUENCE = {"TimeXer": "timexer_raw", "PatchTST": "patchtst_raw", "iTransformer": "itransformer_raw"}


def _pool_and_rows(ensemble):
    models, rows = {}, []
    for m in R33_MODELS:
        ident = ensemble["base_artifacts"][m]
        seq = None
        if m in SEQUENCE:
            seq = {"schema_version": "model-serving-sequence-contract-v1", "source": "model_artifact_registry",
                   "model": m, "artifact_id": ident["artifact_id"], "version": ident["version"], "seq_len": 512,
                   "pred_len": 5}
            if m == "TimeXer":
                seq["timexer"] = {"variant": "price", "feature_history_schema": "formal137-pit-asof-source-quality-v3"}
        graph = R.FORMAL_GNN_GRAPH_SEMANTIC_VERSION if m == "GNN" else None
        models[m] = {"status": "active", "version": ident["version"], "gcs_path": f"universal/{m.lower()}/v.{EXT[m]}",
                     "metadata_path": f"universal/{m.lower()}/metadata_v.json", "serving_artifact_id": ident["artifact_id"],
                     "checksum": ident["checksum"], "serving_eligible": True,
                     "target_semantic_version": P.LABEL_SCHEMA_VERSION,
                     "feature_semantic_version": R.FORMAL_FEATURE_SEMANTIC_VERSION, "gnn_graph_semantic_version": graph,
                     "sequence_contract": seq}
        rows.append({"artifact_id": ident["artifact_id"], "model_name": m, "version": ident["version"],
                     "artifact_path": models[m]["gcs_path"], "metadata_path": models[m]["metadata_path"],
                     "checksum": ident["checksum"], "state": "production", "offline_gate_decision": "PASS",
                     "live_gate_status": "not_started", "metadata_schema_version": "model-artifact-v2",
                     "registry_target_semantic_version": P.LABEL_SCHEMA_VERSION,
                     "registry_feature_semantic_version": R.FORMAL_FEATURE_SEMANTIC_VERSION,
                     "registry_gnn_graph_semantic_version": graph})
    return {"models": models, "shadow_models": {}, "formal_layer3_slots": {}}, rows


@pytest.fixture
def r33_day(monkeypatch):
    """A real R33 serving manifest, its dispatched request and a Modal bundle; only D1 OPS is faked."""
    ensemble = _ensemble()
    pool, rows = _pool_and_rows(ensemble)
    manifest, manifest_digest = P._build_pipeline_modal_serving_manifest(pool, registry_rows=rows,
                                                                         active8_ensemble=ensemble)
    payloads = [{"symbol": s, "stock_meta": {"market_segment": "LISTED"},
                 "prices": [{"date": DAY, "close": 100.0, "adj_close": 100.0}]} for s in SYMBOLS]
    series = [{"symbol": s, "prices": [100.0] * 600} for s in SYMBOLS]
    state = {"run_date": DAY, "producer_run_id": "r33-day-outage", "decision_universe_frozen_at": DAY + "T10:00:00Z",
             "payloads": payloads, "l3_payloads": deepcopy(payloads), "screener_run_id": "run-1", "r33_holdings": [],
             "trading_config": {"fees": {"commission": 0.001425, "tax": 0.003}},
             "pipeline_modal_serving_context": {
                 "schema_version": "pipeline-modal-serving-context-v1",
                 "serving_pool": P._pipeline_modal_runtime_pool_from_manifest(pool, manifest),
                 "serving_manifest": manifest, "serving_manifest_digest": manifest_digest,
                 "model_status": {r["model"]: r["effective_status"] for r in manifest["models"]},
                 "active_versions": {r["model"]: r["version"] for r in manifest["models"]},
                 "pool_versions_loaded": True, "expected_source_sha": "a" * 40}}
    monkeypatch.setattr(P, "build_state_space_series_from_payloads", lambda _: deepcopy(series))
    monkeypatch.setattr(P, "enrich_state_space_series_with_long_history", lambda *a, **k: (deepcopy(series), {}))
    monkeypatch.setattr(P.LEARNING_D1_CLIENT, "query", lambda *a, **k: [])
    monkeypatch.setattr(P, "_pipeline_modal_prediction_callback_url", lambda: "https://never.invalid")
    monkeypatch.setattr(P, "_pipeline_modal_prediction_callback_token", lambda: "test")
    from daily_capture_test_dependency import attach_frozen_capture_fixture
    attach_frozen_capture_fixture(state, series)
    # The R33 feature prep rides on the TimeXer capture source; reseal the packet over it.
    state["timexer_feature_source"] = {**state["timexer_feature_source"], "schema_version": "timexer-feature-source-v1",
                                       "training_dispatched": False, "source_gcs_prefix": "universal/oof_forward_prep_v2/t"}
    packet = {k: v for k, v in state["payload_source_observations"].items() if k != "source_checksum"}
    packet["single_capture_binding"]["feature_source_digest"] = digest(state["timexer_feature_source"])
    packet["source_checksum"] = digest(packet)
    state["payload_source_observations"] = packet
    frozen = {k: v for k, v in state["pipeline_sequence_observations"].items() if k != "source_checksum"}
    frozen["metadata"]["source_packet_checksum"] = packet["source_checksum"]
    frozen["source_checksum"] = digest(frozen)
    state["pipeline_sequence_observations"] = frozen
    request = asyncio.run(P._build_pipeline_modal_prediction_payload(state, state_gcs_uri="gs://isolated-test/s.json"))
    assert request["r33_feature_prep_sources"]["base"] == state["timexer_feature_source"]
    bundle = {k: deepcopy(request[k]) for k in (
        "run_date", "run_id", "state_gcs_uri", "serving_manifest_digest", "slot_artifact_identities",
        "active_artifact_identities", "active8_shadow_artifact_identities", "serving_coverage",
        "sequence_input_contract", "sequence_dataset_meta")}
    bundle.update(schema_version="pipeline-modal-prediction-bundle-v1", n_input=len(SYMBOLS), modal_source_sha="a" * 40,
                  active_artifact_versions={n: i["version"] for n, i in request["active_artifact_identities"].items()},
                  active8_sequence_shadow_raw={"schema_version": "active8-sequence-shadow-bundle-v1",
                                               "production_effect": False, "vote_weight": 0.0, "candidates": {}},
                  predict_batch_v2_results=[{"symbol": s, "rank_scores": {n: (i + 1) / 6.0 for n in
                                                                          ("LightGBM", "ExtraTrees", "TabM")}}
                                            for i, s in enumerate(SYMBOLS)],
                  gnn_graphsage_raw={"results": [{"symbol": s, "rank_score": (i + 1) / 6.0}
                                                 for i, s in enumerate(SYMBOLS)]})
    for name, field in SEQUENCE.items():
        bundle[field] = {"results": [{"symbol": r["symbol"], "forecast_pct": (i + 1) * 0.01}
                                     for i, r in enumerate(request["sequence_model_series_by_model"][name])]}
    state["modal_prediction_bundle"] = bundle

    async def no_cost(*a, **k):
        return None
    from services import cost_tracker
    monkeypatch.setattr(cost_tracker, "record_compute_profile_event", no_cost)
    logged = []

    class Ops:
        def query(self, *a, **k):
            raise AssertionError("the pool loader is faked")

        def execute(self, sql, params):
            assert "INSERT INTO system_logs" in sql
            logged.append(params)
    monkeypatch.setattr(d1_domain_client, "client_proxy_for_domain", lambda domain: Ops())
    monkeypatch.setattr(r33_rank_pool, "load_serving_pool", lambda query, **kw: (
        list(SYMBOLS), {"source": POOL_SOURCE, "signal_date": DAY, "screener_run_id": "run-1",
                        "membership_sha256": "p" * 64}))
    monkeypatch.setattr(paired_nav_collection, "baseline_model_identity", lambda manifest: {
        "schema_version": "paired-nav-formal-ml-baseline-v1",
        **{k: ensemble[k] for k in r33_rank_pool.IDENTITY_FIELDS}})
    return state, logged


def _all_rows_fail(bundle, field):
    bundle[field] = {"results": [{"symbol": r["symbol"], "error": "r33_prep_row_missing:None"}
                                 for r in bundle[field]["results"]]}


@pytest.mark.parametrize("model,field", [("GNN", "gnn_graphsage_raw"), ("PatchTST", "patchtst_raw"),
                                         ("TimeXer", "timexer_raw"), ("iTransformer", "itransformer_raw")])
def test_a_whole_day_gnn_or_sequence_outage_reaches_the_coverage_abort(r33_day, model, field):
    state, logged = r33_day
    _all_rows_fail(state["modal_prediction_bundle"], field)
    with pytest.raises(RuntimeError, match=f"^r33_model_missing_for_day:{model}$"):
        asyncio.run(P.node_ml_predict(state))
    assert len(logged) == 1 and logged[0][:2] == ["error", COVERAGE_LOG_CRON]
    assert logged[0][2].startswith(f"R33 day aborted: models missing for the whole day {model}.")


def test_a_one_name_gap_is_a_warn_line_and_the_day_goes_on(r33_day, monkeypatch):
    state, logged = r33_day
    rows = state["modal_prediction_bundle"]["gnn_graphsage_raw"]["results"]
    rows[0] = {"symbol": rows[0]["symbol"], "error": "r33_prep_row_missing:None"}
    reached = []

    def stop(*a, **k):
        reached.append(True)
        raise RuntimeError("past the coverage check")
    monkeypatch.setattr(P, "_attach_formal_ensemble", stop)
    with pytest.raises(RuntimeError, match="past the coverage check"):
        asyncio.run(P.node_ml_predict(state))
    assert reached and len(logged) == 1 and logged[0][0] == "warn"


def test_outside_r33_the_gnn_zero_usable_raise_is_unchanged(dispatched, monkeypatch):
    state, _request, bundle = dispatched
    _all_rows_fail(bundle, "gnn_graphsage_raw")
    state["modal_prediction_bundle"] = bundle
    monkeypatch.setattr(d1_domain_client, "client_proxy_for_domain",
                        lambda domain: pytest.fail("the coverage check is R33 only"))
    with pytest.raises(RuntimeError, match="GNN active model returned zero usable predictions"):
        asyncio.run(P.node_ml_predict(state))
