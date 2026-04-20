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

8 universal models managed in v1 bootstrap:
  Feature family (5):
    XGBoost / CatBoost / ExtraTrees / LightGBM / FT-Transformer
  Time-series family (3):
    Chronos (foundation, no weights — version is a config marker)
    DLinear (learnable)
    PatchTST (learnable)

State-space (KalmanFilter, MarkovSwitching) handled by Stage 6.
"""
from __future__ import annotations
import json
import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

GCS_BUCKET = "stockvision-models"
GCS_POOL_KEY = "universal/model_pool.json"

SCHEMA_VERSION = "1.0"

# 8 universal models managed by Stage 1
# Order matters: family balance guard reads this for ≥3 feature + ≥2 time-series
MANAGED_MODELS = {
    # name → (model_type, balance_family, gcs_extension)
    "XGBoost":         ("feature",                    "feature",     "joblib"),
    "CatBoost":        ("feature",                    "feature",     "joblib"),
    "ExtraTrees":      ("feature",                    "feature",     "joblib"),
    "LightGBM":        ("feature",                    "feature",     "joblib"),
    "FT-Transformer":  ("feature",                    "feature",     "joblib"),
    "Chronos":         ("time_series_foundation",     "time_series", "json"),
    "DLinear":         ("time_series_learnable",      "time_series", "pt"),
    "PatchTST":        ("time_series_learnable",      "time_series", "pt"),
}

# Family balance guards (per ML_POOL_ARCHITECTURE.md, adjusted for 5+3):
MIN_ACTIVE_PER_FAMILY = {
    "feature":     3,    # ≥3 of 5 feature models must stay active
    "time_series": 2,    # ≥2 of 3 time-series must stay active
}


# ─────────────────────────────────────────────────────────────────────────────
# GCS path helpers
# ─────────────────────────────────────────────────────────────────────────────

def gcs_path_for(model_name: str, version: str) -> str:
    """e.g. ('XGBoost', 'v1') → 'universal/xgboost/v1.joblib'"""
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
    try:
        from google.cloud import storage
        bucket = storage.Client().bucket(GCS_BUCKET)
        blob = bucket.blob(GCS_POOL_KEY)
        if not blob.exists():
            return None
        return json.loads(blob.download_as_text())
    except Exception as e:
        logger.warning(f"[ModelPool] Load failed: {e}")
        return None


def save_pool(pool: dict) -> None:
    """Write model_pool.json to GCS with updated last_updated timestamp."""
    from google.cloud import storage
    pool["last_updated"] = datetime.now(timezone.utc).isoformat()
    bucket = storage.Client().bucket(GCS_BUCKET)
    bucket.blob(GCS_POOL_KEY).upload_from_string(
        json.dumps(pool, indent=2, ensure_ascii=False),
        content_type="application/json",
    )
    logger.info(f"[ModelPool] Saved {GCS_POOL_KEY} ({len(pool.get('models', {}))} models)")


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
      challenger: 0 (shadow predict only)
      retired:    0 (excluded)

    Args:
      model_name:  for pool lookup
      ic_value:    raw IC (e.g. 0.13 from ic_tracking.json or weekly_ic avg)
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
# Stage 3 challenger helpers (shadow mode)
# ─────────────────────────────────────────────────────────────────────────────

CHALLENGER_SUFFIX = "::challenger"   # convention: model_name@D1 = "XGBoost::challenger"


def get_challenger_version(model_name: str, pool: Optional[dict] = None) -> Optional[str]:
    """If a challenger version is registered for model_name, return it. Else None."""
    pool = pool or load_pool()
    if not pool:
        return None
    entry = pool.get("models", {}).get(model_name)
    if not entry:
        return None
    ch = entry.get("challenger")
    if not ch:
        return None
    return ch.get("version")


def get_challenger_path(model_name: str, pool: Optional[dict] = None) -> Optional[str]:
    """Return GCS path for challenger version, or None if no challenger registered."""
    version = get_challenger_version(model_name, pool=pool)
    if version is None:
        return None
    pool = pool or load_pool()
    if pool:
        ch = pool.get("models", {}).get(model_name, {}).get("challenger") or {}
        if ch.get("gcs_path"):
            return ch["gcs_path"]
    # Fallback: derive from convention
    return gcs_path_for(model_name, version)


def register_challenger(
    model_name: str,
    version: str,
    pool: Optional[dict] = None,
    save: bool = True,
) -> dict:
    """Add a challenger entry to model_pool.json.

    Caller responsible for ensuring the GCS artifact at the challenger path
    actually exists. This function only writes the bookkeeping entry.

    Args:
      model_name: must be in MANAGED_MODELS
      version:    new version string (e.g., "v2"); must NOT equal active
      pool:       loaded pool (or None to fetch from GCS)
      save:       write back to GCS

    Returns the updated pool entry for model_name.
    """
    if model_name not in MANAGED_MODELS:
        raise ValueError(f"Unknown model {model_name}; managed: {list(MANAGED_MODELS)}")
    pool = pool or load_pool()
    if not pool:
        raise RuntimeError("model_pool.json not initialized; run /model_pool/init first")
    entry = pool.get("models", {}).get(model_name)
    if not entry:
        raise ValueError(f"{model_name} missing from model_pool.json (likely Stage 1 init missed)")
    if entry.get("version") == version:
        raise ValueError(
            f"{model_name} active version is already {version}; "
            f"challenger must be a different version"
        )

    today = datetime.now(timezone.utc).date().isoformat()
    entry["challenger"] = {
        "version": version,
        "gcs_path": gcs_path_for(model_name, version),
        "shadow_since": today,
        "weekly_ic": [],
        "ic_4w_avg": None,
        "consecutive_negative_weeks": 0,
    }
    if save:
        save_pool(pool)
    return entry


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


# Backward-compat shim (older callers expect the lifecycle-only multiplier)
# Will be removed after Stage 4. Default lifecycle_weight=1.0 for active so
# callers that haven't migrated still see "active = full weight".
def get_lifecycle_weight(model_name: str, pool: Optional[dict] = None) -> float:
    """DEPRECATED — use compute_weight(name, ic_value, pool, degraded_dampening).

    Returns status_filter only (no IC multiplication). Kept for callers that
    haven't migrated to the new R1+R3 weight formula. Will be removed in
    Stage 4 follow-up after grep verifies 0 active call sites.
    """
    pool = pool or load_pool()
    if not pool:
        return 1.0
    entry = pool.get("models", {}).get(model_name)
    if not entry:
        return 1.0
    return get_status_filter(entry["status"])


# ─────────────────────────────────────────────────────────────────────────────
# Migration helper (Stage 1 bootstrap)
# ─────────────────────────────────────────────────────────────────────────────

def list_legacy_artifacts() -> list[dict]:
    """Discover existing GCS artifacts that should be migrated to v{N} layout.

    Looks for the legacy flat-file pattern:
      universal/xgboost.joblib            (legacy: 5 feature models)
      universal/dlinear/v1.pt             (already versioned: Stage 0.2/0.3)
      universal/patchtst/v1.pt            (already versioned)

    Returns a list of {model, current_path, target_path, action}.
    Action is 'rename' (legacy → versioned), 'already_versioned' (no-op),
    or 'missing' (artifact not in GCS yet).
    """
    from google.cloud import storage
    bucket = storage.Client().bucket(GCS_BUCKET)
    out = []
    for name, (_mt, _bf, ext) in MANAGED_MODELS.items():
        target_path = gcs_path_for(name, "v1")
        # Already versioned?
        if bucket.blob(target_path).exists():
            out.append({
                "model": name,
                "current_path": target_path,
                "target_path": target_path,
                "action": "already_versioned",
            })
            continue
        # Legacy flat path?
        if name == "Chronos":
            # Foundation model, no GCS weights — skip
            out.append({"model": name, "current_path": None,
                        "target_path": target_path, "action": "foundation_no_artifact"})
            continue
        # FT-Transformer special-case: its joblib is the bundle dict (Stage 0.2 N1 fix)
        if name == "FT-Transformer":
            legacy_path = "universal/ft-transformer.joblib"
        else:
            legacy_path = f"universal/{name.lower()}.joblib"
        if bucket.blob(legacy_path).exists():
            out.append({
                "model": name,
                "current_path": legacy_path,
                "target_path": target_path,
                "action": "rename",
            })
        else:
            out.append({
                "model": name,
                "current_path": None,
                "target_path": target_path,
                "action": "missing",
            })
    return out


def migrate_legacy_to_versioned(dry_run: bool = True) -> dict:
    """Copy legacy flat-file artifacts to versioned layout.

    NOTE: This is a copy (not move) — original legacy paths kept for fallback
    so existing predict_stock_v2 keeps working until it migrates to read
    from model_pool.json. Stage 4 (after promote logic lands) will write a
    deprecate-and-remove follow-up.

    dry_run=True: report only, no GCS writes.
    """
    from google.cloud import storage
    bucket = storage.Client().bucket(GCS_BUCKET)

    plan = list_legacy_artifacts()
    actions_taken = []
    for item in plan:
        if item["action"] != "rename":
            actions_taken.append({**item, "executed": False, "note": item["action"]})
            continue
        if dry_run:
            actions_taken.append({**item, "executed": False, "note": "dry_run"})
            continue
        try:
            src_blob = bucket.blob(item["current_path"])
            new_blob = bucket.copy_blob(src_blob, bucket, item["target_path"])
            actions_taken.append({**item, "executed": True, "note": f"copied to {new_blob.name}"})
        except Exception as e:
            actions_taken.append({**item, "executed": False, "note": f"error: {e}"})

    # Also copy metadata_{model}.json → metadata in versioned folder for consistency
    if not dry_run:
        for item in plan:
            if item["action"] != "rename":
                continue
            name = item["model"]
            if name == "FT-Transformer":
                src_meta = "universal/metadata_ft-transformer.json"
            else:
                src_meta = f"universal/metadata_{name.lower()}.json"
            tgt_meta = gcs_metadata_path_for(name, "v1")
            try:
                src_blob = bucket.blob(src_meta)
                if src_blob.exists():
                    bucket.copy_blob(src_blob, bucket, tgt_meta)
            except Exception as e:
                logger.warning(f"[ModelPool] Metadata copy failed {src_meta}→{tgt_meta}: {e}")

    return {"dry_run": dry_run, "plan": plan, "actions": actions_taken}
