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

Current bootstrap:
  Feature family (4):
    XGBoost / CatBoost / ExtraTrees / LightGBM
  Time-series family (2):
    DLinear / PatchTST (learnable)
  Formal Layer 3 slots pending artifact promotion:
    TabM / GNN / iTransformer / TimesFM

Chronos remains a legacy managed artifact/diagnostic runtime, but it is retired
from production alpha vote and the evening-chain batch path.

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
    "XGBoost",
    "CatBoost",
    "ExtraTrees",
    "LightGBM",
    "DLinear",
    "PatchTST",
)

STATE_SPACE_OVERLAY_MODELS = (
    "KalmanFilter",
    "MarkovSwitching",
)

EXPERIMENTAL_CHALLENGER_MODELS: dict[str, tuple[str, str, str]] = {}

META_OPTIMIZERS = {
    "GAOptimizer": {
        "layer": "meta_optimizer",
        "status": "learning",
        "scope": "ensemble_weights,strategy_params,risk_params",
        "direct_prediction": False,
    },
}

FORMAL_LAYER3_PENDING_MODELS = {
    "TabM": {
        "status": "formal_slot_pending_artifact",
        "model_type": "tabular_neural",
        "family": "tabular_neural",
        "direct_prediction": False,
        "vote_weight": 0.0,
        "promotion_state": "artifact_required",
        "evidence_required": ["artifact_manifest", "feature_policy", "walk_forward", "pbo", "cpcv", "cost_profile"],
    },
    "GNN": {
        "status": "formal_slot_pending_artifact",
        "model_type": "cross_stock_graph",
        "family": "graph",
        "direct_prediction": False,
        "vote_weight": 0.0,
        "promotion_state": "artifact_required",
        "evidence_required": ["graph_spec", "leakage_controls", "artifact_manifest", "walk_forward", "pbo", "cpcv"],
    },
    "iTransformer": {
        "status": "formal_slot_pending_artifact",
        "model_type": "time_series_transformer",
        "family": "time_series",
        "direct_prediction": False,
        "vote_weight": 0.0,
        "promotion_state": "artifact_required",
        "evidence_required": ["sequence_policy", "artifact_manifest", "walk_forward", "pbo", "cpcv", "cost_profile"],
    },
    "TimesFM": {
        "status": "formal_slot_pending_artifact",
        "model_type": "foundation_time_series",
        "family": "time_series",
        "direct_prediction": False,
        "vote_weight": 0.0,
        "promotion_state": "artifact_required",
        "evidence_required": ["forecast_validation", "artifact_manifest", "walk_forward", "pbo", "cost_profile"],
    },
}
RESEARCH_BENCHMARK_MODELS = FORMAL_LAYER3_PENDING_MODELS

# Active alpha prediction models plus legacy managed artifacts.
# State-space overlays and meta optimizers live in separate namespaces below.
MANAGED_MODELS = {
    # name → (model_type, balance_family, gcs_extension)
    "XGBoost":          ("feature",                    "feature",     "joblib"),
    "CatBoost":         ("feature",                    "feature",     "joblib"),
    "ExtraTrees":       ("feature",                    "feature",     "joblib"),
    "LightGBM":         ("feature",                    "feature",     "joblib"),
    "Chronos":          ("time_series_foundation_legacy", "time_series", "json"),
    "DLinear":          ("time_series_learnable",      "time_series", "pt"),
    "PatchTST":         ("time_series_learnable",      "time_series", "pt"),
}

# Family balance guards for active alpha predictors:
MIN_ACTIVE_PER_FAMILY = {
    "feature":     3,    # at least 3 of 4 feature models must stay active
    "time_series": 2,    # ≥2 of 3 time-series must stay active
}

# State-space default hyperparameters (used when no GCS pool entry exists).
# Stage 6.3 future: Optuna search replaces these with Pareto-optimal values.
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
        return json.loads(json.dumps(_POOL_CACHE))
    try:
        bucket = _get_bucket()
        blob = bucket.blob(GCS_POOL_KEY)
        if not blob.exists():
            return None
        _POOL_CACHE = json.loads(blob.download_as_text())
        _POOL_CACHE_LOADED_AT = time.time()
        return json.loads(json.dumps(_POOL_CACHE))
    except Exception as e:
        logger.warning(f"[ModelPool] Load failed: {e}")
        return None


def save_pool(pool: dict) -> None:
    """Write model_pool.json to GCS with updated last_updated timestamp."""
    global _POOL_CACHE, _POOL_CACHE_LOADED_AT
    pool["last_updated"] = datetime.now(timezone.utc).isoformat()
    bucket = _get_bucket()
    bucket.blob(GCS_POOL_KEY).upload_from_string(
        json.dumps(pool, indent=2, ensure_ascii=False),
        content_type="application/json",
    )
    _POOL_CACHE = json.loads(json.dumps(pool))
    _POOL_CACHE_LOADED_AT = time.time()
    logger.info(f"[ModelPool] Saved {GCS_POOL_KEY} ({len(pool.get('models', {}))} models)")


def init_default_pool() -> dict:
    """Build a fresh model_pool.json where every managed model is 'active' v1.

    Used by /model_pool/init endpoint when bootstrapping. Subsequent retrain
    calls add new versions as model_artifact_registry candidates. Stage 1
    itself only declares "we have a versioned baseline".
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
        "formal_layer3_slots": {},
    }
    for name, (model_type, balance_family, _ext) in MANAGED_MODELS.items():
        is_active_alpha = name in ALPHA_PREDICTION_MODELS
        pool["models"][name] = {
            "status": "active" if is_active_alpha else "retired",
            "version": "v1",
            "gcs_path": gcs_path_for(name, "v1"),
            "model_type": model_type,
            "balance_family": balance_family,
            "promoted_at": today if is_active_alpha else None,
            "shadow_since": None,
            "degraded_since": None,
            "retired_at": None if is_active_alpha else today,
            "weekly_ic": [],
            "ic_4w_avg": None,
            "consecutive_negative_weeks": 0,
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
        pool["formal_layer3_slots"][name] = {
            **meta,
            "created_at": today,
            "approval_gate": "artifact_review_packet_required",
            "note": "Formal Layer 3 slot; no production prediction or vote until artifact promotion is approved.",
        }
    pool["research_benchmarks"] = dict(pool["formal_layer3_slots"])
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
    version = get_active_version(model_name, pool=pool)
    if version is None:
        return None
    return gcs_path_for(model_name, version)


def get_status_filter(status: str) -> float:
    """Pure status → on/off filter. NOT a final weight (use compute_weight).

    Returns 1.0 for active/degraded (model still inferring), 0.0 for
    retired or historical side-slot rows.
    """
    return {
        "active":     1.0,
        "degraded":   1.0,    # still in ensemble, may be IC-dampened by caller
        "challenger": 0.0,    # historical side-slot rows do not vote
        "retired":    0.0,    # not in ensemble
    }.get(status, 0.0)


def compute_weight(
    model_name: str,
    ic_value: float,
    pool: Optional[dict] = None,
    degraded_dampening: float = 1.0,
) -> float:
    """ML_POOL ensemble weight = max(0, ic) × status_filter × dampening.

    2026-04-19 R1+R3 hybrid (replaces hardcoded 0.0/0.1/1.0 lifecycle multipliers):
      - **R3 (continuous IC-based)**: IC drives weight directly; IC<0 → 0.
        Industry standard for cases with clear ground truth (IC).
      - **R1 (KV-driven dampening)**: degraded_dampening defaults to 1.0
        (pure IC, no extra dampening). Caller passes from
        `trading:config.mlPool.degradedDampening` for production override.
        Future Optuna search (after #31 backtest Mode B) can tune this.

    Status semantics:
      active:     pure IC weight
      degraded:   IC × degraded_dampening (default 1.0 = no extra dampening)
      challenger: 0 (historical side-slot rows only)
      retired:    0 (excluded)

    Args:
      model_name:  for pool lookup
      ic_value:    raw IC (e.g. 0.13 from model_pool weekly_ic/rolling_ic)
      pool:        loaded model_pool dict (or None to fetch from GCS)
      degraded_dampening: extra multiplier applied only if status == degraded.
                          Default 1.0 = no dampening = pure R3 (industry std).
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
# Historical side-slot helpers removed
# ─────────────────────────────────────────────────────────────────────────────

# New retrain artifacts enter model_artifact_registry candidates, not side slots.


# ─────────────────────────────────────────────────────────────────────────────
# Stage 6 state-space helpers (per-stock state, shared hyperparams)
# ─────────────────────────────────────────────────────────────────────────────

def state_space_hyperparams_path(model_name: str, version: str = "v1") -> str:
    """e.g. ('KalmanFilter', 'v1') → 'per_stock_state_space/kalman/hyperparams_v1.json'

    State-space models follow the per_stock_state_space/ folder convention to
    distinguish them from universal/ (where 8-model pooled artifacts live).
    Hyperparams are SHARED across all stocks; per-stock state is computed
    online at inference and not persisted.
    """
    if model_name not in DEFAULT_STATE_SPACE_HYPERPARAMS:
        raise ValueError(f"{model_name} is not a state-space overlay")
    folder = "kalman" if model_name == "KalmanFilter" else "markov_switching"
    return f"{GCS_STATE_SPACE_PREFIX}/{folder}/hyperparams_{version}.json"


def load_state_space_hyperparams(model_name: str, version: str = "v1") -> dict:
    """Load shared hyperparams from GCS, fall back to DEFAULT_STATE_SPACE_HYPERPARAMS.

    Inference path (run_kalman_filter / run_markov_switching) calls this once
    per request; the returned dict drives state-space construction.
    """
    if model_name not in DEFAULT_STATE_SPACE_HYPERPARAMS:
        raise ValueError(f"{model_name} is not a state-space model")
    try:
        bucket = _get_bucket()
        path = state_space_hyperparams_path(model_name, version)
        blob = bucket.blob(path)
        if blob.exists():
            return json.loads(blob.download_as_text())
    except Exception as e:
        logger.warning(f"[ModelPool] state-space hyperparams load failed for {model_name}/{version}: {e}")
    return dict(DEFAULT_STATE_SPACE_HYPERPARAMS[model_name])


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


def _get_bucket():
    if not GCS_BUCKET:
        raise RuntimeError("GCS_BUCKET_NAME not configured")
    from google.cloud import storage
    return storage.Client().bucket(GCS_BUCKET)
