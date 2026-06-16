"""
model_pool.py — ML_POOL Stage 1 GCS versioning + state machine.

2026-04-19 ML_POOL Plan A Stage 1:
  - Versioned GCS layout: universal/{model_name}/v{N}.{ext}
  - model_pool.json: single source-of-truth for which version is active /
    challenger / degraded / retired per model.
  - 4-state machine (per ML_POOL_ARCHITECTURE.md):
      challenger (shadow, vote=0)
      → active   (vote=1.0 × ic_weight × regime_mult)
      → degraded (vote=0.1)
      → retired  (vote=0)

  This module provides the data-layer primitives (read/write/transition).
  Stage 2-4 build the state-transition logic (weekly IC tracker, promote
  gate, decay detector) on top of these primitives. Stage 5 adds Discord
  alerts.

Schema (model_pool.json):
{
  "schema_version": "1.0",
  "last_updated": "<ISO timestamp UTC>",
  "models": {
    "<model_name>": {
      "status": "active" | "challenger" | "degraded" | "retired",
      "version": "v<N>",
      "gcs_path": "universal/<model_name>/v<N>.<ext>",
      "model_type": "feature" | "time_series_foundation" | "time_series_learnable",
      "promoted_at": "<ISO date>" | null,
      "shadow_since": "<ISO date>" | null,
      "degraded_since": "<ISO date>" | null,
      "retired_at": "<ISO date>" | null,
      "weekly_ic": [<float>, ...],          // append weekly cron, max 26
      "ic_4w_avg": <float> | null,
      "consecutive_negative_weeks": <int>,
      "balance_family": "feature" | "time_series" | "state_space"
    },
    ...
  }
}

9 alpha models managed by the refactored L3 family pool:
  Tree family:
    LightGBM / XGBoost / ExtraTrees
  Tabular neural / graph targets:
    TabM / GNN
  Time-series family:
    DLinear / PatchTST / iTransformer / TimesFM

Retired alpha models:
  CatBoost / FT-Transformer / Chronos / Chronos2ZeroShot / Chronos2LoRA

State-space (KalmanFilter, MarkovSwitching) handled by Stage 6.
"""
from __future__ import annotations
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

GCS_BUCKET = os.environ.get("GCS_BUCKET_NAME", "").strip()
GCS_POOL_KEY = "universal/model_pool.json"
GCS_STATE_SPACE_PREFIX = "per_stock_state_space"
_POOL_CACHE: dict | None = None
_POOL_CACHE_LOADED_AT: float = 0.0

SCHEMA_VERSION = "1.0"

ALPHA_PREDICTION_MODELS = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
    "TimesFM",
)

RETIRED_ALPHA_MODELS = (
    "CatBoost",
    "FT-Transformer",
    "FTTransformer",
    "Chronos",
    "Chronos2ZeroShot",
    "Chronos2LoRA",
)

STATE_SPACE_OVERLAY_MODELS = (
    "KalmanFilter",
    "MarkovSwitching",
)

EXPERIMENTAL_CHALLENGER_MODELS = {
    "ResidualMLP": ("tabular_neural_shadow", "experimental", "joblib"),
}

META_OPTIMIZERS = {
    "GAOptimizer": {
        "layer": "meta_optimizer",
        "status": "learning",
        "scope": "ensemble_weights,strategy_params,risk_params",
        "direct_prediction": False,
    },
}

RESEARCH_BENCHMARK_MODELS = {}

# 9 alpha prediction model slots managed by ML_POOL.
# State-space overlays and meta optimizers live in separate namespaces below.
MANAGED_MODELS = {
    # name → (model_type, balance_family, gcs_extension)
    "LightGBM":         ("tree_feature",               "tree",        "joblib"),
    "XGBoost":          ("tree_feature",               "tree",        "joblib"),
    "ExtraTrees":       ("tree_feature",               "tree",        "joblib"),
    "TabM":             ("tabular_neural",             "tabular",     "pt"),
    "GNN":              ("cross_stock_graphsage",      "graph",       "pt"),
    "DLinear":          ("time_series_learnable",      "time_series", "pt"),
    "PatchTST":         ("time_series_neuralforecast_patchtst", "time_series", "zip"),
    "iTransformer":     ("time_series_neuralforecast_itransformer", "time_series", "zip"),
    "TimesFM":          ("time_series_foundation",     "time_series", "json"),
}

# Family balance guards for active alpha predictors:
MIN_ACTIVE_PER_FAMILY = {
    "tree": 2,
    "tabular": 1,
    "graph": 1,
    "feature":     3,    # ≥3 of 5 feature models must stay active
    "time_series": 2,    # ≥2 of 3 time-series must stay active
}

# State-space hyperparameter schema/template. Serving must load the concrete
# versioned hyperparams artifact from GCS; these values are not a runtime fallback.
DEFAULT_STATE_SPACE_HYPERPARAMS = {
    "KalmanFilter": {
        "process_noise":      0.01,    # Q matrix scalar (state evolution variance)
        "observation_noise":  1.0,     # R matrix scalar (measurement variance)
        "init_cov_scale":     1.0,     # P0 initial uncertainty scale
        "smoothing":          False,    # forward-only (online), no Kalman smoother
    },
    "MarkovSwitching": {
        "n_regimes":          2,        # bull / bear (or trending / mean-reverting)
        "transition_prior":   0.95,     # diagonal prior (regime persistence)
        "switching_vol":      True,     # volatility differs per regime (vs only mean)
        "ar_order":           2,        # AR(2) within each regime
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# GCS path helpers
# ─────────────────────────────────────────────────────────────────────────────

def gcs_path_for(model_name: str, version: str) -> str:
    """e.g. ('XGBoost', 'v1') → 'universal/xgboost/v1.joblib'"""
    if model_name in DEFAULT_STATE_SPACE_HYPERPARAMS:
        folder = "kalman" if model_name == "KalmanFilter" else "markov_switching"
        return f"{GCS_STATE_SPACE_PREFIX}/{folder}/hyperparams_{version}.json"
    if model_name in EXPERIMENTAL_CHALLENGER_MODELS:
        _model_type, _family, ext = EXPERIMENTAL_CHALLENGER_MODELS[model_name]
        folder = model_name.lower().replace("-", "_")
        return f"experimental_shadow/{folder}/{version}.{ext}"
    if model_name not in MANAGED_MODELS:
        raise ValueError(f"Unknown model {model_name}; managed: {list(MANAGED_MODELS)}")
    _, _, ext = MANAGED_MODELS[model_name]
    folder = model_name.lower().replace("-", "_")
    return f"universal/{folder}/{version}.{ext}"


def gcs_metadata_path_for(model_name: str, version: str) -> str:
    """Metadata sidecar path. e.g. 'universal/xgboost/metadata_v1.json'"""
    folder = model_name.lower().replace("-", "_")
    return f"universal/{folder}/metadata_{version}.json"


# ─────────────────────────────────────────────────────────────────────────────
# Pool I/O
# ─────────────────────────────────────────────────────────────────────────────

def load_pool() -> Optional[dict]:
    """Load current model_pool.json from GCS. None if missing."""
    global _POOL_CACHE, _POOL_CACHE_LOADED_AT
    ttl = int(os.environ.get("MODEL_POOL_CACHE_TTL_SECONDS", "300") or "300")
    if _POOL_CACHE is not None and time.time() - _POOL_CACHE_LOADED_AT < max(0, ttl):
        return sanitize_pool_active9(json.loads(json.dumps(_POOL_CACHE)))
    try:
        bucket = _get_bucket()
        blob = bucket.blob(GCS_POOL_KEY)
        if not blob.exists():
            return None
        _POOL_CACHE = json.loads(blob.download_as_text().lstrip("\ufeff"))
        _POOL_CACHE_LOADED_AT = time.time()
        return sanitize_pool_active9(json.loads(json.dumps(_POOL_CACHE)))
    except Exception as e:
        logger.warning(f"[ModelPool] Load failed: {e}")
        return None


def save_pool(pool: dict) -> None:
    """Write model_pool.json to GCS with updated last_updated timestamp."""
    global _POOL_CACHE, _POOL_CACHE_LOADED_AT
    pool = sanitize_pool_active9(pool)
    pool["last_updated"] = datetime.now(timezone.utc).isoformat()
    bucket = _get_bucket()
    bucket.blob(GCS_POOL_KEY).upload_from_string(
        json.dumps(pool, indent=2, ensure_ascii=False),
        content_type="application/json",
    )
    _POOL_CACHE = json.loads(json.dumps(pool))
    _POOL_CACHE_LOADED_AT = time.time()
    logger.info(f"[ModelPool] Saved {GCS_POOL_KEY} ({len(pool.get('models', {}))} models)")


def sanitize_pool_active9(pool: dict | None) -> dict:
    """Drop retired alpha-model residue from model_pool models.

    State overlays, shadow models, meta optimizers, and research benchmarks are
    separate namespaces; only direct alpha prediction models are constrained to
    active-9.
    """

    if not isinstance(pool, dict):
        return {}
    cloned = json.loads(json.dumps(pool))
    models = cloned.get("models")
    if not isinstance(models, dict):
        cloned["models"] = {}
        return cloned
    cloned["models"] = {
        name: models[name]
        for name in ALPHA_PREDICTION_MODELS
        if name in models and name not in RETIRED_ALPHA_MODELS
    }
    return cloned


def init_default_pool() -> dict:
    """Build a fresh model_pool.json where every managed model is 'active' v1.

    Used by /model_pool/init endpoint when bootstrapping. Subsequent retrain
    calls add new versions as challengers (Stage 3). Stage 1 itself doesn't
    set up any challenger — only declares "we have a versioned baseline".
    """
    today = datetime.now(timezone.utc).date().isoformat()
    pool = {
        "schema_version": SCHEMA_VERSION,
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "models": {},
        "shadow_models": {},
        "state_overlays": {},
        "meta_optimizers": {},
        "research_benchmarks": {},
    }
    for name, (model_type, balance_family, _ext) in MANAGED_MODELS.items():
        pool["models"][name] = {
            "status": "active",
            "version": "v1",
            "gcs_path": gcs_path_for(name, "v1"),
            "model_type": model_type,
            "balance_family": balance_family,
            "promoted_at": today,
            "shadow_since": None,
            "degraded_since": None,
            "retired_at": None,
            "weekly_ic": [],
            "ic_4w_avg": None,
            "consecutive_negative_weeks": 0,
        }
    for name, (model_type, balance_family, _ext) in EXPERIMENTAL_CHALLENGER_MODELS.items():
        pool["shadow_models"][name] = {
            "status": "challenger",
            "version": "v1",
            "gcs_path": gcs_path_for(name, "v1"),
            "model_type": model_type,
            "balance_family": balance_family,
            "shadow_since": today,
            "weekly_ic": [],
            "ic_4w_avg": None,
            "consecutive_negative_weeks": 0,
            "vote_weight": 0.0,
        }
    for name in STATE_SPACE_OVERLAY_MODELS:
        pool["state_overlays"][name] = {
            "status": "active",
            "version": "v1",
            "gcs_path": gcs_path_for(name, "v1"),
            "model_type": "state_space_overlay",
            "role": "regime_risk_overlay",
            "promoted_at": today,
        }
    for name, meta in META_OPTIMIZERS.items():
        pool["meta_optimizers"][name] = {
            **meta,
            "version": "v1",
            "created_at": today,
            "promotion_gate": "walk_forward+pbo+transaction_cost_sensitivity",
        }
    for name, meta in RESEARCH_BENCHMARK_MODELS.items():
        pool["research_benchmarks"][name] = {
            **meta,
            "created_at": today,
            "approval_gate": "research_review_packet_required",
            "note": "Benchmark-only candidate; not a model_pool challenger and never votes until promoted by a separate reviewed lifecycle path.",
        }
    return pool


# ─────────────────────────────────────────────────────────────────────────────
# Per-model accessors
# ─────────────────────────────────────────────────────────────────────────────

def get_active_version(model_name: str, pool: Optional[dict] = None) -> Optional[str]:
    """Return active version string ('v3') or None if model retired/absent."""
    pool = pool or load_pool()
    if not pool:
        return None
    entry = pool.get("models", {}).get(model_name)
    if not entry:
        return None
    return entry["version"] if entry["status"] in ("active", "degraded") else None


def get_active_path(model_name: str, pool: Optional[dict] = None) -> Optional[str]:
    """Return GCS path for currently-active version, or None."""
    pool = pool or load_pool()
    if not pool:
        return None
    entry = pool.get("models", {}).get(model_name)
    if not entry or entry.get("status") not in ("active", "degraded"):
        return None
    path = entry.get("gcs_path")
    if path:
        return str(path)
    version = entry.get("version")
    return gcs_path_for(model_name, str(version)) if version else None


def get_status_filter(status: str) -> float:
    """Pure status → on/off filter. NOT a final weight (use compute_weight).

    Returns 1.0 for active/degraded (model still inferring), 0.0 for
    challenger/retired (shadow or stopped).
    """
    return {
        "active":     1.0,
        "degraded":   1.0,    # still in ensemble, may be IC-dampened by caller
        "challenger": 0.0,    # shadow predict, vote=0
        "retired":    0.0,    # not in ensemble
    }.get(status, 0.0)


def compute_weight(
    model_name: str,
    ic_value: float,
    pool: Optional[dict] = None,
    degraded_dampening: float = 0.1,
) -> float:
    """ML_POOL ensemble weight = max(0, ic) × status_filter × dampening.

    2026-04-19 R1+R3 hybrid (replaces hardcoded 0.0/0.1/1.0 lifecycle multipliers):
      - **R3 (continuous IC-based)**: IC drives weight directly; IC<0 → 0.
        Industry standard for cases with clear ground truth (IC).
      - **R1 (KV-driven dampening)**: degraded_dampening defaults to 0.1
        so degraded models remain diagnostic but no longer behave as active.
        Caller may override from
        `trading:config.mlPool.degradedDampening` for production override.
        Future Optuna search (after #31 backtest Mode B) can tune this.

    Status semantics:
      active:     pure IC weight
      degraded:   IC × degraded_dampening (default 0.1)
      challenger: 0 (shadow predict only)
      retired:    0 (excluded)

    Args:
      model_name:  for pool lookup
      ic_value:    raw IC (e.g. 0.13 from model_pool weekly_ic/rolling_ic)
      pool:        loaded model_pool dict (or None to fetch from GCS)
      degraded_dampening: extra multiplier applied only if status == degraded.
                          Default 0.1 = diagnostic low-weight contribution.
                          Future: Optuna-searchable post #31 Mode B.

    Returns:
      Effective ensemble weight (≥ 0).
    """
    pool = pool or load_pool()
    if not pool:
        # No pool → backward-compat: pure IC weight
        return max(0.0, ic_value)
    entry = pool.get("models", {}).get(model_name)
    if not entry:
        return max(0.0, ic_value)  # unknown model → assume active

    status = entry.get("status", "active")
    status_filter = get_status_filter(status)
    if status_filter == 0.0:
        return 0.0
    base = max(0.0, ic_value)
    if status == "degraded":
        base *= float(degraded_dampening)
    return base


# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 challenger helpers (shadow mode)
# ─────────────────────────────────────────────────────────────────────────────

def get_shadow_challenger_path(model_name: str, pool: Optional[dict] = None) -> Optional[str]:
    """Return the registered ResidualMLP experimental shadow path."""
    pool = pool or load_pool()
    if not pool:
        return None
    entry = pool.get("shadow_models", {}).get(model_name)
    if not entry or entry.get("status") not in ("challenger", "shadow"):
        return None
    return entry.get("gcs_path") or gcs_path_for(model_name, entry.get("version", "v1"))


def register_challenger(
    model_name: str,
    version: str,
    pool: Optional[dict] = None,
    save: bool = True,
    model_cpcv: dict | None = None,
) -> dict:
    """Retired legacy challenger writer.

    Active-9 artifacts are versioned candidates owned by artifact_registry and
    promotion_controller. Experimental predictors must use
    register_shadow_challenger() instead.
    """
    raise ValueError(
        "legacy model_pool challenger registration is disabled for active-9; "
        "use artifact_registry monthly_release/weekly_drift candidates and "
        "promotion_controller. For experimental shadow predictors use "
        "register_shadow_challenger()."
    )


def register_shadow_challenger(
    model_name: str,
    version: str,
    pool: Optional[dict] = None,
    save: bool = True,
) -> dict:
    """Register an experimental predictor that must not vote until promoted.

    This is only for ResidualMLP. GAOptimizer is deliberately excluded because
    it belongs to the meta_optimizer layer and does not emit stock forecasts.
    """
    if model_name not in EXPERIMENTAL_CHALLENGER_MODELS:
        raise ValueError(f"{model_name} is not an experimental shadow predictor")
    pool = pool or load_pool()
    if not pool:
        raise RuntimeError("model_pool.json not initialized; run /model_pool/init first")
    shadow_models = pool.setdefault("shadow_models", {})
    model_type, balance_family, _ext = EXPERIMENTAL_CHALLENGER_MODELS[model_name]
    today = datetime.now(timezone.utc).date().isoformat()
    shadow_models[model_name] = {
        "status": "challenger",
        "version": version,
        "gcs_path": gcs_path_for(model_name, version),
        "model_type": model_type,
        "balance_family": balance_family,
        "shadow_since": today,
        "weekly_ic": [],
        "ic_4w_avg": None,
        "consecutive_negative_weeks": 0,
        "vote_weight": 0.0,
    }
    if save:
        save_pool(pool)
    return shadow_models[model_name]


def discard_challenger(model_name: str, pool: Optional[dict] = None, save: bool = True) -> dict:
    """Remove challenger entry (used when Stage 4 retire-not-promote, or
    manual rollback). Returns updated entry."""
    pool = pool or load_pool()
    if not pool:
        raise RuntimeError("model_pool.json not initialized")
    entry = pool.get("models", {}).get(model_name)
    if not entry:
        raise ValueError(f"{model_name} not in pool")
    entry.pop("challenger", None)
    if save:
        save_pool(pool)
    return entry


# ─────────────────────────────────────────────────────────────────────────────
# Stage 6 state-space helpers (per-stock state, shared hyperparams)
# ─────────────────────────────────────────────────────────────────────────────

def state_space_hyperparams_path(model_name: str, version: str = "v1") -> str:
    """e.g. ('KalmanFilter', 'v1') → 'per_stock_state_space/kalman/hyperparams_v1.json'

    State-space models follow the per_stock_state_space/ folder convention to
    distinguish them from universal/ (where alpha-model pooled artifacts live).
    Hyperparams are SHARED across all stocks; per-stock state is computed
    online at inference and not persisted.
    """
    if model_name not in DEFAULT_STATE_SPACE_HYPERPARAMS:
        raise ValueError(f"{model_name} is not a state-space overlay")
    folder = "kalman" if model_name == "KalmanFilter" else "markov_switching"
    return f"{GCS_STATE_SPACE_PREFIX}/{folder}/hyperparams_{version}.json"


def load_state_space_hyperparams(model_name: str, version: str = "v1") -> dict:
    """Load shared serving hyperparams from GCS.

    Inference path (run_kalman_filter / run_markov_switching) calls this once
    per request; the returned dict drives state-space construction.
    """
    if model_name not in DEFAULT_STATE_SPACE_HYPERPARAMS:
        raise ValueError(f"{model_name} is not a state-space model")
    bucket = _get_bucket()
    path = state_space_hyperparams_path(model_name, version)
    blob = bucket.blob(path)
    if not blob.exists():
        raise FileNotFoundError(f"state-space hyperparams missing: gs://{_get_configured_gcs_bucket()}/{path}")
    payload = json.loads(blob.download_as_text().lstrip("\ufeff"))
    if not isinstance(payload, dict):
        raise ValueError(f"state-space hyperparams payload must be object: {path}")
    return payload


def save_state_space_hyperparams(model_name: str, hyperparams: dict, version: str = "v1") -> str:
    """Persist hyperparams to GCS. Returns saved path.

    Validates hyperparam keys against DEFAULT_STATE_SPACE_HYPERPARAMS to catch
    typos. Future Stage 6.3 Optuna can use this as the search-result writer.
    """
    if model_name not in DEFAULT_STATE_SPACE_HYPERPARAMS:
        raise ValueError(f"{model_name} is not a state-space model")
    expected_keys = set(DEFAULT_STATE_SPACE_HYPERPARAMS[model_name].keys())
    missing = expected_keys - set(hyperparams.keys())
    extra = set(hyperparams.keys()) - expected_keys
    if missing:
        raise ValueError(f"Missing hyperparam keys for {model_name}: {missing}")
    if extra:
        # Allow extras but warn — accommodates future schema migration
        logger.warning(f"[ModelPool] Unexpected hyperparam keys for {model_name}: {extra}")

    bucket = _get_bucket()
    path = state_space_hyperparams_path(model_name, version)
    payload = dict(hyperparams)
    payload["_meta"] = {
        "model": model_name,
        "version": version,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "schema_version": SCHEMA_VERSION,
    }
    bucket.blob(path).upload_from_string(
        json.dumps(payload, indent=2, ensure_ascii=False),
        content_type="application/json",
    )
    logger.info(f"[ModelPool] Saved state-space hyperparams: {path}")
    return path


# ─────────────────────────────────────────────────────────────────────────────
# Migration helper (Stage 1 bootstrap)
# ─────────────────────────────────────────────────────────────────────────────

def list_legacy_artifacts() -> list[dict]:
    """Legacy artifact migration is intentionally disabled."""
    raise RuntimeError("legacy artifact migration is disabled; model_pool.json is canonical")


def migrate_legacy_to_versioned(dry_run: bool = True) -> dict:
    """Legacy artifact migration is intentionally disabled."""
    raise RuntimeError("legacy artifact migration is disabled; model_pool.json is canonical")


def _get_configured_gcs_bucket() -> str:
    return os.environ.get("GCS_BUCKET_NAME", "").strip() or GCS_BUCKET


def _get_bucket():
    bucket_name = _get_configured_gcs_bucket()
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME not configured")
    from google.cloud import storage
    return storage.Client().bucket(bucket_name)
