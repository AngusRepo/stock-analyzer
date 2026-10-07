"""Read-only HMM inference. Artifact failure never triggers training or persistence."""
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException
from .regime import RegimeDetector, build_market_feature_matrix, latest_market_feature_date
from .hmm_input_contract import validate_environment, CONTRACT_HASH

def compute_regime_current(market_env, force_retrain=False):
    if force_retrain:
        raise HTTPException(status_code=409, detail="HMM_INFERENCE_CANNOT_RETRAIN")
    try:
        validate_environment(market_env)
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    sequence = build_market_feature_matrix(market_env)
    detector = RegimeDetector.load_from_gcs()
    if detector is None or not detector.compatible() or not detector.artifact_identity:
        raise HTTPException(status_code=503, detail="HMM_MODEL_UNAVAILABLE_OR_INPUT_CONTRACT_INCOMPATIBLE; explicit approved model admission required")
    trained=datetime.fromisoformat(str(detector.artifact_identity.get("trained_at", "")).replace("Z","+00:00"))
    raw_asof=market_env.get("inference_as_of") or market_env["requested_run_date"]+"T23:59:59+08:00"
    try:cutoff=datetime.fromisoformat(raw_asof.replace("Z","+00:00"))
    except (ValueError,TypeError):raise HTTPException(status_code=400,detail="HMM_AS_OF_INVALID")
    if cutoff.tzinfo is None or cutoff>datetime.now(timezone.utc):
        raise HTTPException(status_code=400,detail="HMM_AS_OF_FUTURE_OR_UNZONED")
    if trained.tzinfo is None or trained>cutoff:
        raise HTTPException(status_code=409,detail="HMM_MODEL_TRAINED_AFTER_AS_OF")
    info = detector.predict_regime(sequence)
    if not info.get("regime_surface"):
        raise HTTPException(status_code=503, detail="HMM_POSTERIOR_UNAVAILABLE")
    index = int(info["regime_index"])
    return {**info, "regime_label_en": {0:"bull_market",1:"volatile",2:"sideways",3:"bear_market"}[index],
            "label_zh": info["label"], "feature_date": latest_market_feature_date(market_env),
            "hmm_provenance": {"inference_as_of":raw_asof,"input_contract": CONTRACT_HASH, "input_checksum": market_env["hmm_input_checksum"],
                               "feature_date": latest_market_feature_date(market_env), "risk_quality_checksum":market_env["history"][market_env["requested_run_date"]].get("risk_quality_checksum"), "model": detector.artifact_identity},
            "computed_at": datetime.now(timezone(timedelta(hours=8))).isoformat()}
