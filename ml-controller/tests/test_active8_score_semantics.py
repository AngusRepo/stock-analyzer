from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.active_model_policy import ACTIVE_ALPHA_MODELS  # noqa: E402
from services.active8_score_semantics import (  # noqa: E402
    MODEL_SCORE_SEMANTIC_VERSION,
    MODEL_TARGET_SEMANTIC_VERSION,
    normalize_active8_cross_sectional_scores,
)


def _prediction(value: float, market: str = "TWSE") -> dict:
    return {
        "stock_meta": {"market": market},
        "rank_scores": {
            "LightGBM": value,
            "XGBoost": value,
            "ExtraTrees": value,
            "TabM": value,
            "GNN": value,
        },
        "dlinear": {"forecast_pct": value - 0.5},
        "patchtst": {"forecast_pct": value - 0.5},
        "itransformer": {"forecast_pct": value - 0.5},
    }


def test_active8_scores_are_same_market_percentiles_with_raw_sequence_preserved():
    predictions = {
        "A": _prediction(0.2),
        "B": _prediction(0.5),
        "C": _prediction(0.8),
    }
    versions = {name: f"{name}-v1" for name in ACTIVE_ALPHA_MODELS}
    target_semantics = {name: MODEL_TARGET_SEMANTIC_VERSION for name in ACTIVE_ALPHA_MODELS}

    summary = normalize_active8_cross_sectional_scores(
        predictions,
        artifact_versions=versions,
        artifact_target_semantics=target_semantics,
        run_date="2026-07-15",
    )

    assert summary["complete_symbols"] == 3
    assert predictions["A"]["rank_scores"]["DLinear"] == 0.0
    assert predictions["B"]["rank_scores"]["DLinear"] == 0.5
    assert predictions["C"]["rank_scores"]["DLinear"] == 1.0
    assert predictions["A"]["dlinear"]["forecast_pct"] == -0.3
    assert predictions["C"]["model_score_lineage"]["semantic_version"] == MODEL_SCORE_SEMANTIC_VERSION
    assert predictions["C"]["model_score_lineage"]["complete"] is True


def test_active8_scores_do_not_rank_across_market_segments():
    predictions = {
        "L1": _prediction(0.1, "TWSE"),
        "L2": _prediction(0.5, "TWSE"),
        "L3": _prediction(0.9, "TWSE"),
        "O1": _prediction(0.2, "OTC"),
        "O2": _prediction(0.4, "OTC"),
    }
    versions = {name: f"{name}-v1" for name in ACTIVE_ALPHA_MODELS}
    target_semantics = {name: MODEL_TARGET_SEMANTIC_VERSION for name in ACTIVE_ALPHA_MODELS}

    summary = normalize_active8_cross_sectional_scores(
        predictions,
        artifact_versions=versions,
        artifact_target_semantics=target_semantics,
        run_date="2026-07-15",
    )

    assert summary["complete_symbols"] == 3
    assert predictions["L3"]["rank_scores"]["XGBoost"] == 1.0
    assert predictions["O1"]["rank_scores"] == {}
    assert "rank_missing:XGBoost" in predictions["O1"]["model_score_lineage"]["blockers"]


def test_active8_lineage_masks_unproven_optional_artifact_target_semantic():
    predictions = {"A": _prediction(0.2), "B": _prediction(0.5), "C": _prediction(0.8)}
    versions = {name: f"{name}-v1" for name in ACTIVE_ALPHA_MODELS}
    target_semantics = {name: MODEL_TARGET_SEMANTIC_VERSION for name in ACTIVE_ALPHA_MODELS}
    target_semantics["PatchTST"] = ""

    summary = normalize_active8_cross_sectional_scores(
        predictions,
        artifact_versions=versions,
        artifact_target_semantics=target_semantics,
        run_date="2026-07-15",
    )

    assert summary["complete_symbols"] == 3
    lineage = predictions["A"]["model_score_lineage"]
    assert lineage["complete"] is True
    assert "PatchTST" in lineage["ineligible_artifact_models"]
    assert "PatchTST" not in lineage["available_models"]


def test_active8_lineage_rejects_when_fewer_than_three_verified_core_artifacts_exist():
    predictions = {"A": _prediction(0.2), "B": _prediction(0.5), "C": _prediction(0.8)}
    versions = {name: f"{name}-v1" for name in ACTIVE_ALPHA_MODELS}
    target_semantics = {name: MODEL_TARGET_SEMANTIC_VERSION for name in ACTIVE_ALPHA_MODELS}
    for name in ("ExtraTrees", "TabM", "GNN"):
        target_semantics[name] = ""

    summary = normalize_active8_cross_sectional_scores(
        predictions,
        artifact_versions=versions,
        artifact_target_semantics=target_semantics,
        run_date="2026-07-15",
    )

    assert summary["complete_symbols"] == 0
    assert (
        "verified_cross_sectional_model_count_below_minimum:2<3"
        in predictions["A"]["model_score_lineage"]["blockers"]
    )


def test_active8_lineage_masks_unavailable_sequence_outputs_but_requires_core_models():
    predictions = {"A": _prediction(0.2), "B": _prediction(0.5), "C": _prediction(0.8)}
    for prediction in predictions.values():
        prediction.pop("itransformer")
    versions = {name: f"{name}-v1" for name in ACTIVE_ALPHA_MODELS}
    target_semantics = {name: MODEL_TARGET_SEMANTIC_VERSION for name in ACTIVE_ALPHA_MODELS}

    summary = normalize_active8_cross_sectional_scores(
        predictions,
        artifact_versions=versions,
        artifact_target_semantics=target_semantics,
        run_date="2026-07-16",
    )

    assert summary["complete_symbols"] == 3
    lineage = predictions["A"]["model_score_lineage"]
    assert lineage["complete"] is True
    assert lineage["full_active8_coverage"] is False
    assert lineage["optional_missing_models"] == ["iTransformer"]
    assert lineage["model_availability"]["iTransformer"] is False

    for prediction in predictions.values():
        prediction["rank_scores"].pop("GNN", None)
        prediction["stock_meta"] = {"market": "TWSE"}
    blocked = normalize_active8_cross_sectional_scores(
        predictions,
        artifact_versions=versions,
        artifact_target_semantics=target_semantics,
        run_date="2026-07-16",
    )
    assert blocked["complete_symbols"] == 0
    assert "rank_missing:GNN" in predictions["A"]["model_score_lineage"]["blockers"]
def _challenger_candidate(model_name: str) -> dict:
    return {
        "model": model_name,
        "status": "challenger",
        "effective_status": "challenger",
        "version": "vCandidate",
        "artifact_id": f"{model_name}:vCandidate:monthly_release",
        "checksum": "sha256:" + "c" * 64,
        "candidate_type": "monthly_release",
        "production_effect": False,
        "vote_weight": 0.0,
        "schema": {"target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION},
    }


def test_challenger_normalization_uses_average_ties_and_exact_identity_lineage():
    from services.active8_score_semantics import normalize_active8_challenger_scores

    predictions = {
        "A": {"stock_meta": {"market": "TWSE"}, "challenger_rank_scores": {"XGBoost": 0.4}},
        "B": {"stock_meta": {"market": "TWSE"}, "challenger_rank_scores": {"XGBoost": 0.4}},
        "C": {"stock_meta": {"market": "TWSE"}, "challenger_rank_scores": {"XGBoost": 0.9}},
    }
    summary = normalize_active8_challenger_scores(
        predictions,
        candidate_rows={"XGBoost": _challenger_candidate("XGBoost")},
        run_date="2026-08-25",
        min_cross_section=2,
    )

    assert summary["complete_symbols"] == 3
    assert predictions["A"]["challenger_rank_scores"]["XGBoost"] == 0.25
    assert predictions["B"]["challenger_rank_scores"]["XGBoost"] == 0.25
    assert predictions["C"]["challenger_rank_scores"]["XGBoost"] == 1.0
    lineage = predictions["A"]["challenger_model_score_lineage"]
    assert lineage["artifact_ids"]["XGBoost"] == "XGBoost:vCandidate:monthly_release"
    assert lineage["artifact_checksums"]["XGBoost"] == "sha256:" + "c" * 64
    assert lineage["production_effect"] is False
    assert lineage["vote_weight"] == 0.0


def test_feature_challenger_partial_cross_section_is_rejected_all_or_none():
    from services.active8_score_semantics import normalize_active8_challenger_scores

    predictions = {
        "A": {"stock_meta": {"market": "TWSE"}, "challenger_rank_scores": {"XGBoost": 0.4}},
        "B": {"stock_meta": {"market": "TWSE"}, "challenger_rank_scores": {"XGBoost": 0.7}},
        "C": {"stock_meta": {"market": "TWSE"}, "challenger_rank_scores": {}},
    }
    summary = normalize_active8_challenger_scores(
        predictions,
        candidate_rows={"XGBoost": _challenger_candidate("XGBoost")},
        run_date="2026-08-25",
        min_cross_section=2,
    )

    assert summary["complete_symbols"] == 0
    assert all(row["challenger_rank_scores"] == {} for row in predictions.values())
    assert any(
        key.startswith("candidate_feature_cross_section_incomplete:XGBoost:LISTED")
        for key in summary["blockers"]
    )


def test_full_l4_information_survives_l3_weight_selection(monkeypatch):
    import json
    from copy import deepcopy
    from services import ensemble_v2
    from services.l4_distribution_runtime import native_features
    artifact=json.loads((Path(__file__).parent/'fixtures/active8_ensemble_20260909.json').read_text(encoding='utf-8-sig'))
    artifact['selected_models']=['ExtraTrees']
    coefficients=[0.]*16;coefficients[list(ACTIVE_ALPHA_MODELS).index('ExtraTrees')]=.04
    artifact['fit']['coefficients']=coefficients
    monkeypatch.setattr(ensemble_v2,'validate_active8_ensemble_artifact',lambda *args,**kwargs:None)
    predictions={s:_prediction(v) for s,v in [('A',.2),('B',.5),('C',.8)]}
    normalize_active8_cross_sectional_scores(predictions,artifact_versions={n:n+'-v1' for n in ACTIVE_ALPHA_MODELS},artifact_target_semantics={n:MODEL_TARGET_SEMANTIC_VERSION for n in ACTIVE_ALPHA_MODELS},run_date='2026-09-01',active8_ensemble=artifact)
    pred=predictions['C'];assert set(pred['rank_scores'])==set(ACTIVE_ALPHA_MODELS)
    restricted=deepcopy(pred);restricted['rank_scores']={'ExtraTrees':pred['rank_scores']['ExtraTrees']}
    full=ensemble_v2._evaluate_validated_ensemble(pred,artifact,{'complete':True})
    selected=ensemble_v2._evaluate_validated_ensemble(restricted,artifact,{'complete':True})
    assert full['ml_expected_net_return']==selected['ml_expected_net_return']
    assert full['probability_positive_net_return']==selected['probability_positive_net_return']
    pred['ensemble_v2']=full
    data=native_features({'score_components':{'components':{'mlEdge':12.5}}},pred)
    assert sum(data[n+'_available'] for n in ACTIVE_ALPHA_MODELS)==8
    assert data['TabM_raw']==.8 and data['TabM_rank']==1.


def test_unselected_information_cannot_bypass_no_selected_model_evidence(monkeypatch):
    from services import ensemble_v2
    monkeypatch.setattr(ensemble_v2,'validate_active8_ensemble_artifact',lambda *args,**kwargs:None)
    predictions={s:_prediction(v) for s,v in [('A',.2),('B',.5),('C',.8)]}
    for pred in predictions.values():pred.pop('dlinear')
    normalize_active8_cross_sectional_scores(predictions,artifact_versions={n:n+'-v1' for n in ACTIVE_ALPHA_MODELS},artifact_target_semantics={n:MODEL_TARGET_SEMANTIC_VERSION for n in ACTIVE_ALPHA_MODELS},run_date='2026-09-01',active8_ensemble={'model_order':list(ACTIVE_ALPHA_MODELS),'selected_models':['DLinear'],'payload_checksum':'a'*64})
    for pred in predictions.values():
        assert pred['rank_scores']['ExtraTrees'] is not None
        assert not pred['model_score_lineage']['complete']
        assert 'selected_model_evidence_missing' in pred['model_score_lineage']['blockers']


def test_challenger_sequence_gaps_keep_explicit_mask_without_inventing_scores():
    from services.active8_score_semantics import normalize_active8_challenger_scores
    predictions = {s: {'stock_meta': {'market': 'TWSE'},
        'challenger_rank_scores': {'XGBoost': value},
        'challenger_model_signals': {'TimeXer': {'forecast_pct': value}}}
        for s, value in [('A', .1), ('B', .2), ('C', .3), ('D', .4)]}
    predictions['D']['challenger_model_signals'] = {}
    normalize_active8_challenger_scores(predictions,
        candidate_rows={name: _challenger_candidate(name) for name in ('XGBoost', 'TimeXer')},
        run_date='2026-09-21')
    for symbol in ('A', 'B', 'C'):
        assert predictions[symbol]['challenger_model_score_lineage']['optional_missing_models'] == []
    missing = predictions['D']
    assert missing['challenger_model_score_lineage']['optional_missing_models'] == ['TimeXer']
    assert 'TimeXer' not in missing['challenger_rank_scores']
    assert 'TimeXer' not in missing['challenger_raw_model_scores']
    assert missing['challenger_model_score_lineage']['complete'] is True
    assert missing['challenger_rank_scores']['XGBoost'] == 1.
