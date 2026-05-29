"""
FastAPI ML service entrypoint.

Current ensemble groups:
  - Time-series alpha models: DLinear / PatchTST
  - Tree models: XGBoost / CatBoost / ExtraTrees / LightGBM
  - State-space overlays: KalmanFilter / MarkovSwitching
"""
import os
import numpy as np
import polars as pl
from concurrent.futures import ThreadPoolExecutor, as_completed
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

from .features import (
    build_feature_matrix, get_features,
    get_catboost_features, get_lgbm_features,  # #6 feature input diversity
)
from .models import (
    run_kalman_filter, run_dlinear, run_markov_switching, run_patchtst, run_chronos,
    run_xgboost, run_catboost, run_extra_trees, run_lightgbm,
    run_garch_volatility,
)
from .ensemble import weighted_vote
from .linucb_bandit import linucb_select, load_bandit, build_context, compute_dynamic_alpha
from .arf_aggregator import (
    build_arf_features, load_arf, save_arf, apply_arf_correction, ARF_STATE_DIR,
    get_dynamic_min_obs,
)
from .universal_training import (
    UniversalPrepRequest as CentralUniversalPrepRequest,
    UniversalTrainRequest as CentralUniversalTrainRequest,
)
from .schemas import NightSessionData, PredictRequest

app = FastAPI(title="StockVision ML Service", version="2.0.0")


def _cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ALLOW_ORIGINS", "").strip()
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]

    worker_url = os.environ.get("STOCKVISION_WORKER_URL", "").strip().rstrip("/")
    defaults = [
        worker_url,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8787",
        "http://127.0.0.1:8787",
    ]
    return list(dict.fromkeys(origin for origin in defaults if origin))

app.add_middleware(
    CORSMiddleware,
    # #21 CORS config for requests coming from StockVision Worker / frontend.
    allow_origins=_cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)

# 2026-04-07 Phase 1: optuna routes are optional in some deployments.
try:
    from .optuna_routes import router as optuna_router
    app.include_router(optuna_router)
except Exception as _e:  # noqa: BLE001
    import logging
    logging.getLogger(__name__).warning(f"[main] optuna_routes not loaded: {_e}")

# Service token shared by Worker, Cloud Run, and other internal callers.
_SERVICE_TOKEN = os.environ.get("ML_SERVICE_SECRET", "")

async def verify_service_token(request: Request) -> None:
    """Verify `X-Service-Token` against `ML_SERVICE_SECRET`."""
    if not _SERVICE_TOKEN:
        return
    token = request.headers.get("X-Service-Token", "")
    if token != _SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid service token")


@app.get("/health")
def health():
    return {"status": "ok", "service": "stockvision-ml", "version": "2.0.0"}


@app.get("/warmup")
async def warmup(request: Request):
    """
    Preload heavy ML imports to reduce cold-start latency.

    Worker or Queue can hit this endpoint before `/predict` to avoid cold-import timeouts.
    """
    await verify_service_token(request)
    import time
    t0 = time.time()
    # Build a tiny synthetic series to touch model imports without real market data.
    dummy_prices = np.random.randn(100).cumsum() + 100
    dummy_prices = np.maximum(dummy_prices, 1.0)
    # KalmanFilter is lightweight enough for warmup and exercises key dependencies.
    try:
        from .models import run_kalman_filter
        run_kalman_filter(dummy_prices, horizon=5, stock_id=0)
    except Exception as e:
        print(f"[Warmup] KalmanFilter skipped: {e}")
    elapsed = round(time.time() - t0, 3)
    print(f"[Warmup] done in {elapsed}s")
    return {"status": "warm", "elapsed_s": elapsed}


@app.post("/breeze2/research-context")
async def breeze2_research_context_endpoint(request: Request):
    await verify_service_token(request)
    payload = await request.json()
    from .breeze2_context import build_breeze2_research_context

    return build_breeze2_research_context({
        **payload,
        "allowed_use": "research_context_only",
        "mutation_allowed": False,
    })


@app.post("/breeze2/reason-generation")
async def breeze2_reason_generation_endpoint(request: Request):
    await verify_service_token(request)
    payload = await request.json()
    from .breeze2_reason_generation import generate_breeze2_reason_generation

    return generate_breeze2_reason_generation({
        **payload,
        "allowed_use": "reason_shadow_only",
        "mutation_allowed": False,
        "real_trading_allowed": False,
    })


class FactorAuditRequest(BaseModel):
    prices: list[dict]
    indicators: list[dict] = []
    chips: list[dict] = []
    sentiment_scores: list[dict] = []
    market_env: dict | None = None


class NeuralMetaBanditRequest(BaseModel):
    policy_id: str = Field(..., pattern="^(NeuralUCB|NeuralTS)$")
    contexts: list[list[float]]
    arms: list[int]
    rewards: list[float]
    arm_names: list[str]
    business_date: str
    symbols: list[str]
    baseline_actions: list[str]
    epochs: int = Field(default=120, ge=1, le=2000)
    hidden_dim: int = Field(default=32, ge=4, le=256)
    learning_rate: float = Field(default=0.01, gt=0, le=1)
    seed: int = Field(default=42, ge=0)


@app.post("/factor-ic-audit")
async def factor_ic_audit(req: FactorAuditRequest, request: Request):
    """
    Weekly IC audit over feature columns using Spearman IC.

    Used by Worker weekly cron to evaluate feature stability and effectiveness.
    """
    await verify_service_token(request)
    from .features import build_feature_matrix, get_features, FEATURE_COLS
    from .feature_selection import ic_icir_check

    df = build_feature_matrix(req.prices, req.indicators, req.chips,
                              req.sentiment_scores, req.market_env)
    X, y, feature_names = get_features(df, target_col="target_dir")

    if len(X) < 60:
        return {"error": "樣本少於 60 筆資料", "features": []}

    # IC/ICIR per-feature (pure NumPy, no Pandas)
    # For per-stock IC audit, dates are implicit (sequential rows = sequential days)
    dates_seq = np.arange(len(X)).astype(str)  # sequential pseudo-dates
    ic_results_dict = ic_icir_check(X, y, dates_seq, feature_names, min_ic=0.0, min_icir=0.0)

    results = [
        {"feature": name, "ic": v["ic"], "icir": v["icir"],
         "effective": v["stable"], "n_dates": v["n_dates"]}
        for name, v in ic_results_dict.items()
    ]

    weak = [r["feature"] for r in results if not r["effective"]]
    strong = [r["feature"] for r in results if r["effective"]]

    print(f"[IC Audit] {len(strong)} effective / {len(weak)} weak out of {len(results)} features")
    return {
        "total": len(results),
        "effective_count": len(strong),
        "weak_count": len(weak),
        "weak_features": weak,
        "details": results,
    }


@app.post("/meta-learning/neural-shadow/train")
async def neural_meta_shadow_train_endpoint(req: NeuralMetaBanditRequest, request: Request):
    """Train NeuralUCB/NeuralTS counterfactual policy and return evidence only."""
    await verify_service_token(request)
    from .neural_meta_bandit import (
        NeuralMetaBanditConfig,
        build_shadow_decisions,
        train_neural_meta_bandit,
    )

    contexts = np.asarray(req.contexts, dtype="float32")
    arms = np.asarray(req.arms, dtype=np.int64)
    rewards = np.asarray(req.rewards, dtype="float32")
    mode = "ts" if req.policy_id == "NeuralTS" else "ucb"
    policy = train_neural_meta_bandit(
        contexts,
        arms,
        rewards,
        arm_names=req.arm_names,
        config=NeuralMetaBanditConfig(
            policy_id=req.policy_id,  # type: ignore[arg-type]
            epochs=req.epochs,
            hidden_dim=req.hidden_dim,
            learning_rate=req.learning_rate,
            seed=req.seed,
        ),
    )
    decisions = build_shadow_decisions(
        policy,
        business_date=req.business_date,
        symbols=req.symbols,
        contexts=contexts[:len(req.symbols)],
        baseline_actions=req.baseline_actions,
        mode=mode,
    )
    return {
        "success": True,
        "mode": "shadow_evidence_only",
        "policy_id": req.policy_id,
        "training_report": policy.training_report.__dict__,
        "shadow_decisions": decisions,
        "production_effect": "none",
    }


def _extract_feature_importance(predictions, feature_names: list[str]) -> dict:
    importance_agg: dict[str, float] = {}
    count = 0
    for pred in predictions:
        model_obj = getattr(pred, "_model", None)
        if model_obj is None:
            continue
        try:
            if hasattr(model_obj, "feature_importances_"):
                imp = model_obj.feature_importances_
                for i, name in enumerate(feature_names):
                    importance_agg[name] = importance_agg.get(name, 0) + float(imp[i])
                count += 1
        except Exception:
            pass
    if count > 0:
        return {k: round(v / count, 4) for k, v in
                sorted(importance_agg.items(), key=lambda x: -x[1])[:15]}
    return {}


def _check_anomaly(X: np.ndarray, X_latest: np.ndarray,
                   contamination: float = 0.05) -> tuple[bool, float]:
    """Run Isolation Forest and return `(is_anomaly, score)`."""
    if len(X) < 30:
        return False, 0.0
    try:
        from sklearn.ensemble import IsolationForest
        iso = IsolationForest(n_estimators=100, contamination=contamination,
                              random_state=42, n_jobs=-1)
        iso.fit(X)
        score    = float(iso.score_samples(X_latest.reshape(1, -1))[0])
        decision = int(iso.predict(X_latest.reshape(1, -1))[0])
        return decision == -1, score
    except Exception as e:
        print(f"[IsolationForest] failed: {e}")
        return False, 0.0


def predict_stock(req: PredictRequest) -> dict:
    """Prediction core logic without auth checks."""
    from .prediction_runtime import predict_stock as _predict_stock

    return _predict_stock(req)

@app.post("/predict")
async def predict_endpoint(req: PredictRequest, request: Request):
    """Compatibility endpoint. Production prediction is v2-only."""
    await verify_service_token(request)
    return predict_stock_v2(req)


# 2.0 predict path: regression models + IC-weighted `rank_to_signal`.
# Shared logic should keep converging toward `prediction_runtime.py`.

_MODEL_NAMES_V2 = ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"]


def predict_stock_v2(req: PredictRequest) -> dict:
    """2.0 predict path using regression models from GCS and `rank_to_signal()`."""
    # Differences from predict_stock (1.0):
    # - target_col="target_rank" instead of "target_dir"
    # - loads universal regression models (stock_id=0)
    # - uses `.predict()` rank output and `rank_to_signal()`
    # - no per-stock retrain fallback
    from .prediction_runtime import predict_stock_v2 as _predict_stock_v2

    return _predict_stock_v2(req)

@app.post("/predict/v2")
async def predict_v2_endpoint(req: PredictRequest, request: Request):
    """HTTP wrapper for 2.0 predict."""
    await verify_service_token(request)
    return predict_stock_v2(req)


def retrain_stock(req: PredictRequest) -> dict:
    """Retrain core logic without auth checks."""
    if len(req.prices) < 60:
        raise ValueError("樣本少於 60 筆資料，無法進行 retrain")

    from .prediction_runtime import retrain_stock as _retrain_stock

    return _retrain_stock(req)

@app.post("/retrain")

async def retrain_endpoint(req: PredictRequest, request: Request):
    """HTTP wrapper that verifies auth then delegates to `retrain_stock()`."""
    await verify_service_token(request)
    return retrain_stock(req)


# Universal model retrain flow:
# 1. `prep_universal_batch(payloads)` writes `universal/prep/batch_{i}.npz`
# 2. `train_universal_from_gcs()` loads prep batches and trains universal models

UniversalPrepRequest = CentralUniversalPrepRequest
UniversalTrainRequest = CentralUniversalTrainRequest


def prep_universal_batch(req: UniversalPrepRequest) -> dict:
    from .universal_training import prep_universal_batch as _prep_universal_batch

    return _prep_universal_batch(req)

def train_universal_from_gcs(req: UniversalTrainRequest) -> dict:
    from .universal_training import train_universal_from_gcs as _train_universal_from_gcs

    return _train_universal_from_gcs(req)

@app.post("/retrain/universal/prep")
async def prep_universal_endpoint(req: CentralUniversalPrepRequest, request: Request):
    await verify_service_token(request)
    from .universal_training import prep_universal_batch as _prep_universal_batch

    return _prep_universal_batch(req)

@app.post("/retrain/universal/train")
async def train_universal_endpoint(req: CentralUniversalTrainRequest, request: Request):
    await verify_service_token(request)
    from .universal_training import train_universal_from_gcs as _train_universal_from_gcs

    return _train_universal_from_gcs(req)


# SHAP feature importance audit
# 2026-04-10: evaluate 5 universal models over 106 features
# TreeExplainer for active tree models.

def run_shap_audit(shap_samples: int = 5000) -> dict:
    from .universal_training import run_shap_audit as _run_shap_audit

    return _run_shap_audit(shap_samples=shap_samples)

@app.post("/audit/shap")
async def shap_audit_endpoint(request: Request):
    await verify_service_token(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    shap_samples = body.get("shap_samples", 5000)
    from .universal_training import run_shap_audit as _run_shap_audit

    return _run_shap_audit(shap_samples=shap_samples)


def _deprecated_run_permutation_importance(n_repeats: int = 5, max_samples: int = 50000) -> dict:
    # Deprecated: replaced by V2 grouped powershap feature selection.








    import time, io, json as _json
    from sklearn.metrics import accuracy_score
    t0 = time.time()

    from .model_store import _get_bucket
    from .artifact_runtime_versions import load_joblib_with_version_warnings
    bucket = _get_bucket()
    if bucket is None:
        return {"error": "GCS_BUCKET_NAME not configured or bucket unavailable"}

    # 1. Load test data from universal prep batches.
    prep_blobs = sorted(
        [b for b in bucket.list_blobs(prefix="universal/prep/") if b.name.endswith(".npz")],
        key=lambda b: b.name,
    )
    if not prep_blobs:
        return {"error": "No prep data in GCS. Run retrain first."}

    all_X, all_y, all_dates = [], [], []
    for blob in prep_blobs:
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        data = np.load(buf, allow_pickle=True)
        all_X.append(data["X"])
        all_y.append(data["y"])
        all_dates.append(data["dates"])
    X = np.vstack(all_X)
    y = np.concatenate(all_y)
    dates = np.concatenate(all_dates)

    fn_blob = bucket.blob("universal/prep/feature_names.json")
    feature_names = _json.loads(fn_blob.download_as_text())
    n_features = len(feature_names)

    # Time-based split (same as training)
    sorted_dates = np.sort(np.unique(dates))
    cutoff_idx = int(len(sorted_dates) * 0.8)
    cutoff_date = sorted_dates[cutoff_idx]
    test_mask = dates > cutoff_date
    X_test = X[test_mask]
    y_test = y[test_mask]

    # Subsample if too large (permutation is O(n_features ? n_repeats ? n_samples))
    if len(X_test) > max_samples:
        rng = np.random.RandomState(42)
        idx = rng.choice(len(X_test), max_samples, replace=False)
        idx.sort()
        X_test = X_test[idx]
        y_test = y_test[idx]

    print(f"[PermImp] {len(X_test)} test samples, {n_features} features, {n_repeats} repeats")

    # 2. Load trained models from GCS.
    model_names = ["xgboost", "catboost", "extratrees", "lightgbm"]
    models = {}
    for name in model_names:
        try:
            blob = bucket.blob(f"universal/{name}.joblib")
            buf = io.BytesIO()
            blob.download_to_file(buf)
            buf.seek(0)
            models[name] = load_joblib_with_version_warnings(buf, artifact_name=f"universal/{name}.joblib")
        except Exception as e:
            print(f"[PermImp] {name} load failed: {e}")

    if not models:
        return {"error": "No models loaded"}

    # 3. Compute permutation importance per model.
    rng = np.random.RandomState(42)
    model_results = {}  # model_name -> {feature_name: accuracy_drop}

    for model_name, model in models.items():
        try:
            # Replace inf/nan for prediction safety
            X_clean = np.nan_to_num(X_test, nan=0.0, posinf=0.0, neginf=0.0)
            base_pred = model.predict(X_clean)
            base_acc = accuracy_score(y_test, base_pred)
            print(f"[PermImp] {model_name} baseline acc={base_acc:.4f}")

            drops_mean = np.zeros(n_features)
            drops_std = np.zeros(n_features)
            for fi in range(n_features):
                fi_drops = []
                for _ in range(n_repeats):
                    X_perm = X_clean.copy()
                    X_perm[:, fi] = rng.permutation(X_perm[:, fi])
                    perm_pred = model.predict(X_perm)
                    perm_acc = accuracy_score(y_test, perm_pred)
                    fi_drops.append(base_acc - perm_acc)
                drops_mean[fi] = np.mean(fi_drops)
                drops_std[fi] = np.std(fi_drops)

            model_results[model_name] = {
                "baseline_acc": base_acc,
                "drops": drops_mean,
                "drops_std": drops_std,
            }
            top_fi = feature_names[np.argmax(drops_mean)]
            print(f"[PermImp] {model_name} done, top feature: {top_fi} (drop={drops_mean.max():.4f})")
        except Exception as e:
            print(f"[PermImp] {model_name} failed: {e}")

    if not model_results:
        return {"error": "All models failed permutation importance"}
    # 4. Average across models and classify using sklearn-style thresholds.
    # 4. Average across models and classify using sklearn-style thresholds.
    # sklearn: keep if mean - 2*std > 0 (95% CI lower bound > 0)
    all_drops = np.stack([r["drops"] for r in model_results.values()])
    all_stds = np.stack([r["drops_std"] for r in model_results.values()])
    avg_drops = np.mean(all_drops, axis=0)
    # Pooled std: combine across models via root-mean-square of per-model stds
    pooled_std = np.sqrt(np.mean(all_stds ** 2, axis=0))

    features_result = []
    for fi in range(n_features):
        per_model = {}
        for mname, mresult in model_results.items():
            per_model[mname] = round(float(mresult["drops"][fi]), 6)

        avg_drop = float(avg_drops[fi])
        std = float(pooled_std[fi])
        ci_lower = avg_drop - 2 * std  # 95% CI lower bound

        # sklearn convention: Active if CI lower bound > 0, Cut if CI upper bound < 0
        if ci_lower > 0:
            category = "active"
        elif avg_drop + 2 * std < 0:
            category = "cut"
        else:
            category = "reserve"

        features_result.append({
            "feature": feature_names[fi],
            "avg_accuracy_drop": round(avg_drop, 6),
            "std": round(std, 6),
            "ci_lower": round(ci_lower, 6),
            "category": category,
            "per_model": per_model,
        })

    # Sort by accuracy drop (most important first)
    features_result.sort(key=lambda x: x["avg_accuracy_drop"], reverse=True)
    for i, f in enumerate(features_result):
        f["rank"] = i + 1

    n_active = sum(1 for f in features_result if f["category"] == "active")
    n_reserve = sum(1 for f in features_result if f["category"] == "reserve")
    n_cut = sum(1 for f in features_result if f["category"] == "cut")
    elapsed = round(time.time() - t0, 1)

    result = {
        "total_features": n_features,
        "test_samples": len(X_test),
        "n_repeats": n_repeats,
        "models_used": list(model_results.keys()),
        "baseline_acc": {k: round(v["baseline_acc"], 4) for k, v in model_results.items()},
        "active_count": n_active,
        "reserve_count": n_reserve,
        "cut_count": n_cut,
        "elapsed_s": elapsed,
        "features": features_result,
    }

    # Save to GCS
    try:
        result_json = _json.dumps(result, ensure_ascii=False, indent=2)
        bucket.blob("universal/permutation_importance.json").upload_from_string(
            result_json, content_type="application/json"
        )
        print(f"[PermImp] Saved to GCS universal/permutation_importance.json")
    except Exception as e:
        print(f"[PermImp] Failed to save to GCS: {e}")

    print(f"\n[PermImp] === RESULTS ({elapsed}s) ===")
    print(f"[PermImp] Active: {n_active}, Reserve: {n_reserve}, Cut: {n_cut}")
    print(f"\n[PermImp] Top 20 (most impactful):")
    for f in features_result[:20]:
        print(f"  #{f['rank']:3d} {f['feature']:30s} drop={f['avg_accuracy_drop']:.4f} [{f['category']}]")
    print(f"\n[PermImp] Bottom 20 (candidates to cut):")
    for f in features_result[-20:]:
        print(f"  #{f['rank']:3d} {f['feature']:30s} drop={f['avg_accuracy_drop']:.4f} [{f['category']}]")

    return result


@app.post("/audit/feature-selection")
async def feature_selection_endpoint(request: Request):
    # V2 Feature Selection: silhouette, grouped powershap, and feature pool update.
    await verify_service_token(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    from .feature_selection import run_feature_selection_pipeline
    return run_feature_selection_pipeline(
        max_rounds=body.get("max_rounds", 100),
        alpha=body.get("alpha", 0.01),
        required_power=body.get("required_power", 0.99),
    )


# ARF reward update payload consumed by cron / controller callbacks.

class ARFUpdateRequest(BaseModel):
    arf_features: list[float]     # Features returned from `/predict`.
    actual_up: bool               # True if the realized move after 5 days is up.
    # LinUCB reward context
    model_name: Optional[str] = None   # Selected model / LinUCB arm
    hmm_regime: Optional[str] = None
    garch_vol: Optional[float] = None
    current_price: float = 1.0
    market_risk_score: float = 0.5
    # #14 LinUCB reward enrichment
    actual_return: float = 0.0    # Realized return over the evaluation horizon
    forecast_pct: float = 0.0     # Forecasted return used at decision time
    # FT online update metadata
    stock_id: int = 0
    symbol: str = ""

# Friction cost baseline: 0.1425% fee + 0.1425% tax + 0.3% slippage = 0.585%
# Reward logic subtracts friction before evaluating whether the signal added value.
FRICTION_COST_PCT = 0.00585

from .prediction_runtime import ARFUpdateRequest as CentralARFUpdateRequest

ARFUpdateRequest = CentralARFUpdateRequest


def update_arf(req: ARFUpdateRequest) -> dict:
    # Core ARF/LinUCB update logic delegated to prediction_runtime.
    from .prediction_runtime import update_arf as _update_arf

    return _update_arf(req)



@app.post("/arf/update")
async def arf_update_endpoint(req: ARFUpdateRequest, request: Request):
    # HTTP endpoint wrapper for update_arf().
    await verify_service_token(request)
    return update_arf(req)


@app.get("/bandit/stats")
async def bandit_stats(request: Request):
    # Return LinUCB and ARF status summary.
    await verify_service_token(request)
    out: dict = {}
    try:
        _bandit = load_bandit("/tmp/linucb_bandit")
        out["linucb"] = _bandit.stats_summary()
    except Exception as e:
        out["linucb"] = {"error": str(e)}
    try:
        _arf = load_arf(ARF_STATE_DIR)
        out["arf"] = _arf.stats_summary()
    except Exception as e:
        out["arf"] = {"error": str(e)}
    return out


# Regime pipeline (Sprint 4-2 revisit, 2026-04-17 #30).
# Adds `/regime/current` so ml-controller can fetch the latest HMM regime.
# English labels for KV consumption (Worker marketScreener / paper.ts consume
# these via string .includes('bull'/'bear'/'sideways'/'volatile')).
_REGIME_INDEX_TO_EN = {
    0: "bull_market",   # bullish
    1: "volatile",      # high-volatility regime
    2: "sideways",      # neutral / sideways
    3: "bear_market",   # bearish
}


class RegimeRequest(BaseModel):
    market_env: dict | None = None  # same structure used by /predict /predict/v2
    force_retrain: bool = False     # if True, retrain HMM from history


@app.post("/regime/current")
async def regime_current(req: RegimeRequest, request: Request):
    # Return the current HMM market regime.
    await verify_service_token(request)
    from datetime import datetime, timezone, timedelta
    from .regime import (
        RegimeDetector,
        build_market_feature_matrix,
        get_current_market_features,
    )

    TW_TZ = timezone(timedelta(hours=8))

    detector = None if req.force_retrain else RegimeDetector.load_from_gcs()
    if detector is None:
        feat_mat = build_market_feature_matrix(req.market_env)
        if feat_mat is None or len(feat_mat) < 20:
            raise HTTPException(
                status_code=400,
                detail="insufficient market_env.history to train HMM (need >=20 days)",
            )
        detector = RegimeDetector().fit(feat_mat)
        if detector._trained:
            detector.save_to_gcs()

    cur_feat = get_current_market_features(req.market_env)
    if cur_feat is None:
        raise HTTPException(status_code=400, detail="market_env missing current features")

    info = detector.predict_regime(cur_feat)
    reg_idx = int(info.get("regime_index", 1))
    label_en = _REGIME_INDEX_TO_EN.get(reg_idx, "sideways")

    return {
        "regime_label_en":     label_en,
        "regime_index":        reg_idx,
        "hmm_state":           info.get("hmm_state", -1),
        "label_zh":            info.get("label", "盤整"),
        "weight_multipliers":  info.get("weight_multipliers", {}),
        "consensus_threshold": info.get("consensus_threshold", 0.60),
        "computed_at":         datetime.now(TW_TZ).isoformat(),
    }


# Walk-forward endpoints (Sprint 6b / 2026-04-18 #32)

class WalkForwardHMMTrainRequest(BaseModel):
    # Train HMM on historical window for walk-forward replay.
    window_id: int
    train_end: str                       # HMM sees history up to & including this date
    market_env: dict                     # already-filtered history (caller ensures no future leak)
    gcs_prefix: str                      # e.g. "walk_forward/w3"


@app.post("/regime/train_window")
async def regime_train_window(req: WalkForwardHMMTrainRequest, request: Request):
    # Train HMM on a historical window and save snapshot.
    await verify_service_token(request)
    from .regime import RegimeDetector, build_market_feature_matrix

    feat_mat = build_market_feature_matrix(req.market_env)
    if feat_mat is None or len(feat_mat) < 30:
        raise HTTPException(
            status_code=400,
            detail=f"insufficient market_env.history (got {len(feat_mat) if feat_mat is not None else 0} days, need >=30)",
        )

    detector = RegimeDetector().fit(feat_mat)
    if not detector._trained:
        raise HTTPException(status_code=500, detail="HMM fit did not converge")

    saved = detector.save_to_gcs(
        gcs_prefix=req.gcs_prefix,
        extra_metadata={
            "window_id": req.window_id,
            "train_end": req.train_end,
            "history_days": len(feat_mat),
        },
    )
    return {
        "window_id": req.window_id,
        "gcs_prefix": req.gcs_prefix.rstrip("/"),
        "n_components": detector.n_components,
        "regime_map": {str(k): v for k, v in detector.regime_map.items()},
        "history_days": len(feat_mat),
        "saved": saved,
    }


class WalkForwardReplayRequest(BaseModel):
    # Replay HMM prediction for a historical date using a per-window snapshot.
    window_id: int                       # which window's HMM joblib to load
    market_env: dict                      # filtered history + 'current' date's features


@app.post("/regime/replay_at_date")
async def regime_replay_at_date(req: WalkForwardReplayRequest, request: Request):
    # Predict regime at a historical date using the windowed HMM snapshot.
    await verify_service_token(request)
    from .regime import RegimeDetector, get_current_market_features

    gcs_prefix = f"walk_forward/w{req.window_id}"
    detector = RegimeDetector.load_from_gcs(
        gcs_prefix=gcs_prefix,
        skip_freshness_check=True,   # historical snapshots are never "fresh"
    )
    if detector is None:
        raise HTTPException(
            status_code=404,
            detail=f"No HMM snapshot at {gcs_prefix}. Run /regime/train_window first.",
        )

    cur_feat = get_current_market_features(req.market_env)
    if cur_feat is None:
        raise HTTPException(status_code=400, detail="market_env missing current features")

    info = detector.predict_regime(cur_feat)
    reg_idx = int(info.get("regime_index", 1))
    return {
        "window_id":       req.window_id,
        "regime_label_en": _REGIME_INDEX_TO_EN.get(reg_idx, "sideways"),
        "regime_index":    reg_idx,
        "hmm_state":       info.get("hmm_state", -1),
        "label_zh":        info.get("label", "盤整"),
    }


class WalkForwardTrainRequest(BaseModel):
    # Retrain ML models on a walk-forward train range.
    window_id: int
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    models: list[str] | None = None      # None = all 5
    batch_count: int = 5                  # re-uses existing prep npz
    skip_feature_pool: bool = False


@app.post("/retrain/walk_forward")
async def retrain_walk_forward_endpoint(req: WalkForwardTrainRequest, request: Request):
    # Train all specified models on a walk-forward window.
    await verify_service_token(request)
    gcs_prefix = f"walk_forward/w{req.window_id}"

    # Delegate to existing train with walk-forward params
    from .universal_training import UniversalTrainRequest as _UniversalTrainRequest
    from .universal_training import train_universal_from_gcs as _train_universal_from_gcs

    inner_req = _UniversalTrainRequest(
        batch_count=req.batch_count,
        models_filter=req.models,
        skip_feature_pool=req.skip_feature_pool,
        train_start=req.train_start,
        train_end=req.train_end,
        test_start=req.test_start,
        test_end=req.test_end,
        gcs_prefix=gcs_prefix,
        window_id=req.window_id,
        skip_weekly_backup=True,   # windowed paths are themselves versioned
    )
    result = _train_universal_from_gcs(inner_req)
    result["window_id"] = req.window_id
    result["gcs_prefix"] = gcs_prefix
    return result
