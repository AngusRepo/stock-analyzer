"""
feature_selection.py — 2.0 Feature Selection Pipeline

Flow: Silhouette Clustering → Target Permutation (Y-shuffle) → K-S auto-stop
      → IC/ICIR stability → Elbow detection (kneed) → Diversity Guard → Feature Pool

Target Permutation (2.0) replaces Grouped Powershap (V2).
Core idea: shuffle Y (not X), retrain LightGBM, compare feature importances.
  - Real importance = model trained on real Y
  - Null importance = model trained on shuffled Y (×100 max, K-S auto-stop)
  - Feature is significant if real >> null (K-S test p < 0.01)

References:
  - sklearn permutation_test_score: default 100 permutations
  - Target Permutation: https://www.mdpi.com/2079-9292/14/3/571
  - Powershap (predecessor): https://github.com/predict-idlab/powershap
"""
import time
import json
import io
import hashlib
import os
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from typing import Any, Callable, Optional
from scipy import stats
from scipy.cluster import hierarchy
from scipy.spatial.distance import squareform
from sklearn.metrics import silhouette_score

from app.model_store import _get_bucket
from app.purged_cv import dynamic_embargo_days


FEATURE_SELECTION_CACHE_SCHEMA_VERSION = "feature-selection-cache-v1"
FEATURE_SELECTION_STAGE_CHECKPOINT_SCHEMA_VERSION = "feature-selection-stage-checkpoint-v1"
FEATURE_SELECTION_STAGE_LOCK_SCHEMA_VERSION = "feature-selection-stage-lock-v1"
FEATURE_SELECTION_ALGORITHM_EVIDENCE_SCHEMA_VERSION = "feature-selection-algorithm-evidence-v1"

_CURRENT_ALGO_DEFAULTS = {
    "algorithm_profile": "current",
    "cluster_linkage": "ward",
    "k_sweep_sampler": "nsga2",
    "k_sweep_objective": "single_val_ic",
    "k_sweep_knee_policy": "kneedle_080",
    "k_sweep_bootstrap_rounds": 0,
    "embargo_mode": "dynamic",
    "label_horizon_days": 5,
}

_PROFILE_DEFAULTS = {
    "current": _CURRENT_ALGO_DEFAULTS,
    "candidate_v2": {
        **_CURRENT_ALGO_DEFAULTS,
        "algorithm_profile": "candidate_v2",
        "cluster_linkage": "average",
        "k_sweep_sampler": "motpe",
        "k_sweep_objective": "purged_rolling_ic",
        "k_sweep_knee_policy": "bootstrap_ci",
        "k_sweep_bootstrap_rounds": 50,
        "embargo_mode": "label_horizon",
    },
}

_SUPPORTED_CLUSTER_LINKAGES = {"ward", "average", "complete", "weighted", "single"}
_SUPPORTED_K_SWEEP_SAMPLERS = {"nsga2", "motpe", "tpe"}
_SUPPORTED_K_SWEEP_OBJECTIVES = {"single_val_ic", "purged_rolling_ic"}
_SUPPORTED_KNEE_POLICIES = {"kneedle_080", "bootstrap_ci"}
_SUPPORTED_EMBARGO_MODES = {"dynamic", "label_horizon"}


def _bounded_parallel_workers(value: object, *, default: int = 1, hard_cap: int = 4) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(parsed, hard_cap))


def _coerce_positive_int(value: object, default: int, *, minimum: int = 0) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(int(minimum), parsed)


def _normalized_choice(value: object, *, default: str, allowed: set[str]) -> str:
    raw = str(value or default).strip().lower().replace("-", "_")
    return raw if raw in allowed else default


def resolve_feature_selection_algorithm_config(selection_params: dict) -> dict:
    """Resolve feature-selection algorithm profile into explicit knobs.

    `candidate_v2` is the production default after Mode B replay evidence.
    `current` remains available as an explicit baseline profile.
    """

    profile = str(selection_params.get("algorithm_profile") or "candidate_v2").strip().lower()
    if profile not in _PROFILE_DEFAULTS:
        profile = "candidate_v2"

    config = dict(selection_params)
    profile_defaults = _PROFILE_DEFAULTS[profile]
    current_defaults = _CURRENT_ALGO_DEFAULTS
    config["algorithm_profile"] = profile
    for key, value in profile_defaults.items():
        if key == "algorithm_profile":
            continue
        raw = config.get(key)
        if raw is None or raw == "" or (profile != "current" and raw == current_defaults.get(key)):
            config[key] = value

    config["cluster_linkage"] = _normalized_choice(
        config.get("cluster_linkage"),
        default=profile_defaults["cluster_linkage"],
        allowed=_SUPPORTED_CLUSTER_LINKAGES,
    )
    config["k_sweep_sampler"] = _normalized_choice(
        config.get("k_sweep_sampler"),
        default=profile_defaults["k_sweep_sampler"],
        allowed=_SUPPORTED_K_SWEEP_SAMPLERS,
    )
    config["k_sweep_objective"] = _normalized_choice(
        config.get("k_sweep_objective"),
        default=profile_defaults["k_sweep_objective"],
        allowed=_SUPPORTED_K_SWEEP_OBJECTIVES,
    )
    config["k_sweep_knee_policy"] = _normalized_choice(
        config.get("k_sweep_knee_policy"),
        default=profile_defaults["k_sweep_knee_policy"],
        allowed=_SUPPORTED_KNEE_POLICIES,
    )
    config["embargo_mode"] = _normalized_choice(
        config.get("embargo_mode"),
        default=profile_defaults["embargo_mode"],
        allowed=_SUPPORTED_EMBARGO_MODES,
    )
    config["label_horizon_days"] = _coerce_positive_int(
        config.get("label_horizon_days"),
        current_defaults["label_horizon_days"],
        minimum=1,
    )
    config["k_sweep_bootstrap_rounds"] = _coerce_positive_int(
        config.get("k_sweep_bootstrap_rounds"),
        current_defaults["k_sweep_bootstrap_rounds"],
        minimum=0,
    )
    return config


def _blob_identity(blob) -> dict:
    return {
        "name": str(getattr(blob, "name", "")),
        "generation": str(getattr(blob, "generation", "") or ""),
        "size": int(getattr(blob, "size", 0) or 0),
        "crc32c": str(getattr(blob, "crc32c", "") or ""),
        "md5_hash": str(getattr(blob, "md5_hash", "") or ""),
    }


def build_feature_selection_cache_key(
    *,
    prep_blobs: list,
    feature_blob,
    feature_names: list[str],
    selection_params: dict,
    train_end_date: str | None,
    gcs_prefix: str | None,
) -> str:
    """Exact-cache key for monthly feature selection evidence."""

    payload = {
        "schema_version": FEATURE_SELECTION_CACHE_SCHEMA_VERSION,
        "prep_blobs": [_blob_identity(blob) for blob in prep_blobs],
        "feature_blob": _blob_identity(feature_blob),
        "feature_names_sha256": hashlib.sha256(
            json.dumps(list(feature_names), ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest(),
        "selection_params": selection_params,
        "train_end_date": train_end_date,
        "gcs_prefix": gcs_prefix or "universal",
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _feature_selection_cache_path(cache_key: str) -> str:
    return f"universal/feature_selection_cache/{cache_key}.json"


def _feature_selection_stage_checkpoint_path(cache_key: str, stage: str) -> str:
    safe_stage = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in stage)
    return f"universal/feature_selection_checkpoints/{cache_key}/{safe_stage}.json"


def _feature_selection_stage_lock_path(cache_key: str, stage: str) -> str:
    safe_stage = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in stage)
    return f"universal/feature_selection_checkpoints/{cache_key}/locks/{safe_stage}.json"


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _json_default(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (set, tuple)):
        return list(value)
    return str(value)


def _json_dumps(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=_json_default)


def load_feature_selection_cache(bucket, cache_key: str) -> dict | None:
    try:
        blob = bucket.blob(_feature_selection_cache_path(cache_key))
        if not blob.exists():
            return None
        payload = json.loads(blob.download_as_text())
        if payload.get("schema_version") != FEATURE_SELECTION_CACHE_SCHEMA_VERSION:
            return None
        if payload.get("cache_key") != cache_key:
            return None
        result = payload.get("result")
        return result if isinstance(result, dict) else None
    except Exception as exc:
        print(f"[FeatureSelection] Evidence cache read skipped: {exc}")
        return None


def save_feature_selection_cache(bucket, cache_key: str, result: dict) -> None:
    payload = {
        "schema_version": FEATURE_SELECTION_CACHE_SCHEMA_VERSION,
        "cache_key": cache_key,
        "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "result": result,
    }
    bucket.blob(_feature_selection_cache_path(cache_key)).upload_from_string(
        _json_dumps(payload),
        content_type="application/json",
    )


def load_feature_selection_stage_checkpoint(bucket, cache_key: str, stage: str) -> dict | None:
    try:
        blob = bucket.blob(_feature_selection_stage_checkpoint_path(cache_key, stage))
        if not blob.exists():
            return None
        payload = json.loads(blob.download_as_text())
        if payload.get("schema_version") != FEATURE_SELECTION_STAGE_CHECKPOINT_SCHEMA_VERSION:
            return None
        if payload.get("cache_key") != cache_key or payload.get("stage") != stage:
            return None
        result = payload.get("result")
        return result if isinstance(result, dict) else None
    except Exception as exc:
        print(f"[FeatureSelection] Stage checkpoint read skipped stage={stage}: {exc}")
        return None


def save_feature_selection_stage_checkpoint(bucket, cache_key: str, stage: str, result: dict) -> None:
    payload = {
        "schema_version": FEATURE_SELECTION_STAGE_CHECKPOINT_SCHEMA_VERSION,
        "cache_key": cache_key,
        "stage": stage,
        "saved_at": _utc_now(),
        "result": result,
    }
    bucket.blob(_feature_selection_stage_checkpoint_path(cache_key, stage)).upload_from_string(
        _json_dumps(payload),
        content_type="application/json",
    )


def acquire_feature_selection_stage_lock(
    bucket,
    cache_key: str,
    stage: str,
    *,
    owner: str,
    ttl_seconds: int = 900,
) -> dict:
    """Acquire an advisory GCS lock for one stage.

    The lock is intentionally advisory and fail-open; checkpoints are the
    durable cost saver, while the lock only reduces accidental concurrent work.
    """

    now = time.time()
    expires_at = now + max(60, int(ttl_seconds))
    path = _feature_selection_stage_lock_path(cache_key, stage)
    blob = bucket.blob(path)
    payload = {
        "schema_version": FEATURE_SELECTION_STAGE_LOCK_SCHEMA_VERSION,
        "cache_key": cache_key,
        "stage": stage,
        "owner": owner,
        "acquired_at": _utc_now(),
        "expires_at_epoch": expires_at,
    }
    try:
        blob.upload_from_string(_json_dumps(payload), content_type="application/json", if_generation_match=0)
        return {"acquired": True, "path": path, "owner": owner, "stale_replaced": False}
    except TypeError:
        if not blob.exists():
            blob.upload_from_string(_json_dumps(payload), content_type="application/json")
            return {"acquired": True, "path": path, "owner": owner, "stale_replaced": False}
    except Exception:
        pass

    try:
        if not blob.exists():
            blob.upload_from_string(_json_dumps(payload), content_type="application/json")
            return {"acquired": True, "path": path, "owner": owner, "stale_replaced": False}
        existing = json.loads(blob.download_as_text())
        existing_expires = float(existing.get("expires_at_epoch") or 0.0)
        if existing_expires <= now:
            generation = getattr(blob, "generation", None)
            try:
                if generation:
                    blob.upload_from_string(
                        _json_dumps(payload),
                        content_type="application/json",
                        if_generation_match=int(generation),
                    )
                else:
                    blob.upload_from_string(_json_dumps(payload), content_type="application/json")
                return {"acquired": True, "path": path, "owner": owner, "stale_replaced": True}
            except TypeError:
                blob.upload_from_string(_json_dumps(payload), content_type="application/json")
                return {"acquired": True, "path": path, "owner": owner, "stale_replaced": True}
        return {
            "acquired": False,
            "path": path,
            "owner": owner,
            "existing_owner": existing.get("owner"),
            "expires_at_epoch": existing_expires,
        }
    except Exception as exc:
        print(f"[FeatureSelection] Stage lock acquire skipped stage={stage}: {exc}")
        return {"acquired": False, "path": path, "owner": owner, "error": str(exc)}


def release_feature_selection_stage_lock(bucket, cache_key: str, stage: str, *, owner: str) -> None:
    try:
        blob = bucket.blob(_feature_selection_stage_lock_path(cache_key, stage))
        if not blob.exists():
            return
        payload = json.loads(blob.download_as_text())
        if payload.get("owner") == owner:
            blob.delete()
    except Exception as exc:
        print(f"[FeatureSelection] Stage lock release skipped stage={stage}: {exc}")


def _checkpointing_enabled(*, dry_run: bool) -> bool:
    if dry_run:
        return False
    raw = os.environ.get("FEATURE_SELECTION_STAGE_CHECKPOINTS", "1").strip().lower()
    return raw not in {"0", "false", "no", "off", "disabled"}


def run_feature_selection_stage(
    bucket,
    cache_key: str,
    stage: str,
    *,
    dry_run: bool,
    checkpoint_stats: dict[str, dict],
    compute: Callable[[], dict],
) -> dict:
    if not _checkpointing_enabled(dry_run=dry_run):
        checkpoint_stats[stage] = {"status": "disabled"}
        return compute()

    checkpoint_path = _feature_selection_stage_checkpoint_path(cache_key, stage)
    cached = load_feature_selection_stage_checkpoint(bucket, cache_key, stage)
    if cached is not None:
        print(f"[FeatureSelection] Stage checkpoint HIT stage={stage} key={cache_key[:12]}")
        checkpoint_stats[stage] = {"status": "hit", "path": checkpoint_path}
        return cached

    owner = f"pid-{os.getpid()}-{int(time.time() * 1000)}"
    lock = acquire_feature_selection_stage_lock(
        bucket,
        cache_key,
        stage,
        owner=owner,
        ttl_seconds=int(os.environ.get("FEATURE_SELECTION_STAGE_LOCK_TTL_SECONDS", "900") or 900),
    )
    lock_acquired = bool(lock.get("acquired"))
    try:
        if not lock_acquired:
            wait_seconds = int(os.environ.get("FEATURE_SELECTION_STAGE_LOCK_WAIT_SECONDS", "30") or 30)
            deadline = time.time() + max(0, wait_seconds)
            while time.time() < deadline:
                time.sleep(5)
                cached = load_feature_selection_stage_checkpoint(bucket, cache_key, stage)
                if cached is not None:
                    print(f"[FeatureSelection] Stage checkpoint HIT after wait stage={stage} key={cache_key[:12]}")
                    checkpoint_stats[stage] = {
                        "status": "hit_after_wait",
                        "path": checkpoint_path,
                        "lock": lock,
                    }
                    return cached
            print(f"[FeatureSelection] Stage lock conflict fail-open stage={stage} key={cache_key[:12]}")
            checkpoint_stats[stage] = {
                "status": "lock_conflict_fail_open",
                "path": checkpoint_path,
                "lock": lock,
            }
            result = compute()
        else:
            checkpoint_stats[stage] = {
                "status": "miss",
                "path": checkpoint_path,
                "lock": lock,
            }
            result = compute()

        if isinstance(result, dict) and "error" not in result:
            try:
                save_feature_selection_stage_checkpoint(bucket, cache_key, stage, result)
                checkpoint_stats[stage]["saved"] = True
            except Exception as exc:
                checkpoint_stats[stage]["save_error"] = str(exc)
                print(f"[FeatureSelection] Stage checkpoint save skipped stage={stage}: {exc}")
        return result
    finally:
        if lock_acquired:
            release_feature_selection_stage_lock(bucket, cache_key, stage, owner=owner)


# ══════════════════════════════════════════════════════════════════════════════
# Step 1: Silhouette Clustering (保留 V2，不動)
# ══════════════════════════════════════════════════════════════════════════════

def cluster_features(
    X: np.ndarray,
    feature_names: list[str],
    k_range: tuple[int, int] = (5, 40),
    linkage_method: str = "ward",
) -> dict:
    """Cluster correlated features using Spearman correlation + Ward linkage.

    Auto-selects optimal k via Silhouette score (data-driven).

    Returns:
        {
            "n_groups": int,
            "best_k": int,
            "best_silhouette": float,
            "groups": {group_id: [feature_name, ...]},
            "feature_to_group": {feature_name: group_id},
            "dropped_features": [...],
        }
    """
    t0 = time.time()
    linkage_method = _normalized_choice(
        linkage_method,
        default="ward",
        allowed=_SUPPORTED_CLUSTER_LINKAGES,
    )
    n_features = X.shape[1]

    # Filter zero-variance features
    variances = np.var(X, axis=0)
    valid_mask = variances > 1e-10
    valid_indices = np.where(valid_mask)[0]
    dropped_features = [feature_names[i] for i in range(n_features) if not valid_mask[i]]
    if dropped_features:
        print(f"[FeatureSelection] Dropped {len(dropped_features)} zero-variance: "
              f"{dropped_features[:10]}{'...' if len(dropped_features) > 10 else ''}")

    X_valid = X[:, valid_indices]
    valid_names = [feature_names[i] for i in valid_indices]

    if len(valid_names) < 3:
        return {
            "n_groups": 1, "best_k": 1, "best_silhouette": 0,
            "groups": {"1": valid_names},
            "feature_to_group": {f: 1 for f in valid_names},
            "dropped_features": dropped_features,
            "linkage_method": linkage_method,
            "distance_metric": "1_abs_spearman",
            "elapsed_s": 0,
        }

    # Spearman rank-order correlation
    # Guard: drop rows with any NaN before computing (otherwise spearmanr
    # silently drops different rows per column → incomparable correlations)
    nan_row_mask = ~np.isnan(X_valid).any(axis=1)
    X_clean = X_valid[nan_row_mask] if nan_row_mask.sum() >= 20 else X_valid
    corr_matrix, _ = stats.spearmanr(X_clean)
    if corr_matrix.ndim == 0:
        corr_matrix = np.array([[1.0]])

    corr_matrix = (corr_matrix + corr_matrix.T) / 2
    np.fill_diagonal(corr_matrix, 1.0)
    corr_matrix = np.nan_to_num(corr_matrix, nan=0.0)

    distance_matrix = 1 - np.abs(corr_matrix)
    np.fill_diagonal(distance_matrix, 0)
    distance_matrix = np.clip(distance_matrix, 0, None)
    distance_matrix = np.nan_to_num(distance_matrix, nan=1.0, posinf=1.0, neginf=0.0)

    condensed = squareform(distance_matrix, checks=False)
    linkage_matrix = (
        hierarchy.ward(condensed)
        if linkage_method == "ward"
        else hierarchy.linkage(condensed, method=linkage_method)
    )

    n_valid = len(valid_names)
    best_k, best_score = k_range[0], -1
    for k in range(k_range[0], min(k_range[1] + 1, n_valid)):
        labels = hierarchy.fcluster(linkage_matrix, k, criterion='maxclust')
        if len(set(labels)) < 2:
            continue
        score = silhouette_score(distance_matrix, labels, metric='precomputed')
        if score > best_score:
            best_k, best_score = k, score

    cluster_labels = hierarchy.fcluster(linkage_matrix, best_k, criterion='maxclust')

    groups: dict[int, list[str]] = {}
    feature_to_group: dict[str, int] = {}
    for i, label in enumerate(cluster_labels):
        gid = int(label)
        groups.setdefault(gid, []).append(valid_names[i])
        feature_to_group[valid_names[i]] = gid

    elapsed = round(time.time() - t0, 1)
    print(f"[FeatureSelection] Silhouette: {n_features} features → {len(groups)} groups "
          f"({n_valid} valid, best_k={best_k}, silhouette={best_score:.3f}, {elapsed}s)")

    return {
        "n_groups": len(groups),
        "best_k": best_k,
        "best_silhouette": round(best_score, 4),
        "groups": {str(k): v for k, v in groups.items()},
        "feature_to_group": feature_to_group,
        "dropped_features": dropped_features,
        "linkage_method": linkage_method,
        "distance_metric": "1_abs_spearman",
        "linkage_caveat": "ward_on_precomputed_correlation_distance" if linkage_method == "ward" else None,
        "elapsed_s": elapsed,
    }


# ══════════════════════════════════════════════════════════════════════════════
# Step 2: Target Permutation (2.0 — replaces Grouped Powershap)
# ══════════════════════════════════════════════════════════════════════════════

def _train_lgbm_regression(X_train: np.ndarray, y_train: np.ndarray,
                           X_val: np.ndarray, y_val: np.ndarray,
                           seed: int = 42,
                           lightgbm_n_jobs: int = -1) -> "lightgbm.Booster":
    """Train a LightGBM regressor (GPU if available) and return Booster."""
    import lightgbm as lgb

    params = {
        "objective": "regression",
        "metric": "rmse",
        "learning_rate": 0.05,
        "num_leaves": 63,
        "min_child_samples": 50,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "seed": seed,
        "verbose": -1,
        "n_jobs": int(lightgbm_n_jobs),
    }
    # LightGBM: CPU mode (GPU needs source rebuild with USE_CUDA=ON, deferred)
    # See memory/feedback_lightgbm_gpu_modal.md

    dtrain = lgb.Dataset(X_train, label=y_train)
    dval = lgb.Dataset(X_val, label=y_val, reference=dtrain)

    booster = lgb.train(
        params, dtrain,
        num_boost_round=500,
        valid_sets=[dval],
        callbacks=[lgb.early_stopping(30, verbose=False)],
    )
    return booster


def _permuted_target(
    y: np.ndarray,
    *,
    rng: np.random.RandomState,
    dates: np.ndarray | None = None,
    sectors: np.ndarray | None = None,
    mode: str = "within_date",
) -> np.ndarray:
    """Permute cross-sectional rank targets without destroying date structure."""

    y_arr = np.asarray(y).copy()
    mode_norm = str(mode or "within_date").strip().lower()
    if mode_norm == "global":
        return rng.permutation(y_arr)

    out = y_arr.copy()
    if dates is None or len(dates) != len(y_arr):
        return rng.permutation(y_arr)

    date_arr = np.asarray(dates).astype(str)
    sector_arr = None
    if sectors is not None and len(sectors) == len(y_arr):
        sector_arr = np.asarray(sectors).astype(str)

    if mode_norm in {"within_date_sector", "within_sector_date"} and sector_arr is not None:
        group_keys = np.asarray([f"{d}::{s}" for d, s in zip(date_arr, sector_arr)], dtype=str)
    else:
        group_keys = date_arr

    for key in np.unique(group_keys):
        idx = np.where(group_keys == key)[0]
        if len(idx) > 1:
            out[idx] = rng.permutation(out[idx])
    return out


def target_permutation(
    X_train: np.ndarray, y_train: np.ndarray,
    X_val: np.ndarray, y_val: np.ndarray,
    feature_names: list[str],
    max_permutations: int = 100,
    ks_alpha: float = 0.05,
    ks_check_interval: int = 10,
    dates_train: np.ndarray | None = None,
    sectors_train: np.ndarray | None = None,
    permutation_mode: str = "within_date",
    max_parallel_workers: int = 1,
) -> dict:
    """Target Permutation feature selection.

    1. Train LightGBM on real Y → real_importance (per feature)
    2. For each permutation:
       - Shuffle Y (cross-sectional rank → random rank)
       - Train LightGBM on shuffled Y → null_importance
    3. K-S test auto-stop: every ks_check_interval rounds, check if null distribution
       has converged (K-S test between first half and second half of null samples)
    4. Per-feature: compare real_importance vs null_importance distribution

    Args:
        max_permutations: ceiling (sklearn default 100), K-S may stop earlier
        ks_alpha: significance for K-S convergence test (0.05 = 95% converged)
        ks_check_interval: check convergence every N rounds

    Returns:
        {
            "real_importance": np.array (n_features,),
            "null_importances": np.array (n_permutations, n_features),
            "n_permutations": int (actual rounds run),
            "per_feature": {name: {"real": float, "null_mean": float, "null_std": float,
                                    "p_value": float, "score": float}},
        }
    """
    t0 = time.time()
    n_features = len(feature_names)
    max_workers = _bounded_parallel_workers(max_parallel_workers, default=1, hard_cap=4)
    rng = np.random.RandomState(42)

    # ── Real model ───────────────────────────────────────────────────────────
    print(f"[TargetPerm] Training real model ({len(X_train)} train, {len(X_val)} val)...")
    real_model = _train_lgbm_regression(X_train, y_train, X_val, y_val, seed=42)
    real_importance = real_model.feature_importance(importance_type="gain").astype(np.float64)

    # Normalize to sum=1 for comparability across rounds
    real_sum = real_importance.sum()
    if real_sum > 0:
        real_importance_norm = real_importance / real_sum
    else:
        real_importance_norm = np.ones(n_features) / n_features

    # ── Null distribution (Y-shuffle) ────────────────────────────────────────
    null_importances = []
    actual_rounds = 0

    if max_workers > 1:
        def _run_parallel_round(perm_i: int) -> tuple[int, np.ndarray]:
            local_rng = np.random.RandomState(42 + perm_i + 1)
            y_shuffled = _permuted_target(
                y_train,
                rng=local_rng,
                dates=dates_train,
                sectors=sectors_train,
                mode=permutation_mode,
            )
            cpu_count = os.cpu_count() or max_workers
            per_model_jobs = max(1, cpu_count // max_workers)
            null_model = _train_lgbm_regression(
                X_train,
                y_shuffled,
                X_val,
                y_val,
                seed=42 + perm_i + 1,
                lightgbm_n_jobs=per_model_jobs,
            )
            null_imp = null_model.feature_importance(importance_type="gain").astype(np.float64)
            null_sum = null_imp.sum()
            if null_sum > 0:
                null_imp = null_imp / null_sum
            else:
                null_imp = np.ones(n_features) / n_features
            return perm_i, null_imp

        perm_i = 0
        while perm_i < max_permutations:
            chunk_end = min(max_permutations, perm_i + max(ks_check_interval, max_workers))
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                chunk = list(executor.map(_run_parallel_round, range(perm_i, chunk_end)))
            null_importances.extend(imp for _, imp in sorted(chunk, key=lambda row: row[0]))
            actual_rounds = chunk_end
            perm_i = chunk_end

            if actual_rounds >= 50 and actual_rounds % ks_check_interval == 0:
                null_arr = np.array(null_importances)
                half = actual_rounds // 2
                first_means = null_arr[:half].mean(axis=0)
                second_means = null_arr[half:].mean(axis=0)
                ks_stat, ks_p = stats.ks_2samp(first_means, second_means)
                if ks_p > ks_alpha:
                    print(f"[TargetPerm] K-S converged at round {actual_rounds}: "
                          f"stat={ks_stat:.4f}, p={ks_p:.4f} > {ks_alpha}")
                    break
            if actual_rounds % 20 == 0:
                elapsed = round(time.time() - t0, 1)
                print(f"[TargetPerm] Round {actual_rounds}/{max_permutations} ({elapsed}s)")

    for perm_i in range(max_permutations if max_workers <= 1 else 0):
        y_shuffled = _permuted_target(
            y_train,
            rng=rng,
            dates=dates_train,
            sectors=sectors_train,
            mode=permutation_mode,
        )
        null_model = _train_lgbm_regression(X_train, y_shuffled, X_val, y_val,
                                             seed=42 + perm_i + 1)
        null_imp = null_model.feature_importance(importance_type="gain").astype(np.float64)
        null_sum = null_imp.sum()
        if null_sum > 0:
            null_imp = null_imp / null_sum
        else:
            null_imp = np.ones(n_features) / n_features
        null_importances.append(null_imp)
        actual_rounds = perm_i + 1

        # ── K-S auto-stop check ──────────────────────────────────────────────
        if actual_rounds >= 50 and actual_rounds % ks_check_interval == 0:
            null_arr = np.array(null_importances)  # (rounds, n_features)
            half = actual_rounds // 2
            first_half = null_arr[:half]
            second_half = null_arr[half:]

            # Check convergence: K-S test on mean importance distribution
            first_means = first_half.mean(axis=0)
            second_means = second_half.mean(axis=0)
            ks_stat, ks_p = stats.ks_2samp(first_means, second_means)

            if ks_p > ks_alpha:
                # Null distribution has converged (p > 0.05 = no significant difference)
                print(f"[TargetPerm] K-S converged at round {actual_rounds}: "
                      f"stat={ks_stat:.4f}, p={ks_p:.4f} > {ks_alpha}")
                break

        if actual_rounds % 20 == 0:
            elapsed = round(time.time() - t0, 1)
            print(f"[TargetPerm] Round {actual_rounds}/{max_permutations} ({elapsed}s)")

    null_arr = np.array(null_importances)  # (actual_rounds, n_features)
    elapsed = round(time.time() - t0, 1)
    print(f"[TargetPerm] Done: {actual_rounds} permutations in {elapsed}s")

    # ── Per-feature statistics ───────────────────────────────────────────────
    per_feature = {}
    for i, name in enumerate(feature_names):
        real_val = real_importance_norm[i]
        null_vals = null_arr[:, i]
        null_mean = float(null_vals.mean())
        null_std = float(null_vals.std())

        # Score: how many std above null mean (like z-score)
        score = (real_val - null_mean) / max(null_std, 1e-10)

        # P-value: fraction of null >= real (empirical)
        p_value = float((null_vals >= real_val).sum() / len(null_vals))

        per_feature[name] = {
            "real": round(float(real_val), 8),
            "null_mean": round(null_mean, 8),
            "null_std": round(null_std, 8),
            "score": round(float(score), 4),
            "p_value": round(p_value, 6),
        }

    return {
        "real_importance": real_importance_norm,
        "null_importances": null_arr,
        "n_permutations": actual_rounds,
        "per_feature": per_feature,
        "elapsed_s": elapsed,
        "permutation_mode": permutation_mode,
        "max_parallel_workers": max_workers,
        "sector_aware": bool(
            str(permutation_mode).lower() in {"within_date_sector", "within_sector_date"}
            and sectors_train is not None
            and len(sectors_train) == len(y_train)
        ),
    }


# ══════════════════════════════════════════════════════════════════════════════
# Step 2b: Signal Sanity Gate (new in 2.0)
# ══════════════════════════════════════════════════════════════════════════════

def signal_sanity_gate(
    X_train: np.ndarray, y_train: np.ndarray,
    X_val: np.ndarray, y_val: np.ndarray,
    n_permutations: int = 30,
    alpha: float = 0.05,
    dates_train: np.ndarray | None = None,
    sectors_train: np.ndarray | None = None,
    permutation_mode: str = "within_date",
    max_parallel_workers: int = 1,
) -> dict:
    """Signal sanity gate: 30 Y-shuffle permutations on validation IC.

    Empirical p-value < alpha (0.05) → signal is detectable → PASS.
    If FAIL, feature selection should not proceed (no real signal in data).

    Returns:
        {"passed": bool, "p_value": float, "real_ic": float, "null_ic_mean": float, ...}
    """
    from scipy.stats import spearmanr
    t0 = time.time()
    max_workers = _bounded_parallel_workers(max_parallel_workers, default=1, hard_cap=4)

    # Real model IC on validation
    real_model = _train_lgbm_regression(X_train, y_train, X_val, y_val, seed=42)
    real_preds = real_model.predict(X_val)
    if len(real_preds) < 10 or np.std(real_preds) < 1e-10 or np.std(y_val) < 1e-10:
        real_ic = 0.0
    else:
        rho, _ = spearmanr(real_preds, y_val)
        real_ic = float(rho) if not np.isnan(rho) else 0.0

    # Null distribution: shuffle Y, retrain, compute IC
    rng = np.random.RandomState(99)
    shuffled_targets = [
        _permuted_target(
            y_train,
            rng=rng,
            dates=dates_train,
            sectors=sectors_train,
            mode=permutation_mode,
        )
        for _ in range(n_permutations)
    ]

    def _run_null_round(task: tuple[int, np.ndarray]) -> tuple[int, float]:
        i, y_shuf = task
        per_model_jobs = max(1, (os.cpu_count() or max_workers) // max_workers)
        null_model = _train_lgbm_regression(
            X_train,
            y_shuf,
            X_val,
            y_val,
            seed=100 + i,
            lightgbm_n_jobs=per_model_jobs,
        )
        null_preds = null_model.predict(X_val)
        if np.std(null_preds) < 1e-10:
            return i, 0.0
        rho, _ = spearmanr(null_preds, y_val)
        return i, float(rho) if not np.isnan(rho) else 0.0

    tasks = list(enumerate(shuffled_targets))
    if max_workers > 1 and len(tasks) > 1:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            null_results = list(executor.map(_run_null_round, tasks))
    else:
        null_results = [_run_null_round(task) for task in tasks]
    null_ics = [ic for _, ic in sorted(null_results, key=lambda row: row[0])]

    null_arr = np.array(null_ics)
    # Empirical p-value: fraction of null ICs >= real IC
    p_value = float((null_arr >= real_ic).sum() / len(null_arr))
    passed = p_value < alpha

    elapsed = round(time.time() - t0, 1)
    print(f"[SanityGate] real_IC={real_ic:.4f}, null_mean={null_arr.mean():.4f}, "
          f"p_value={p_value:.4f} → {'PASS ✅' if passed else 'FAIL ❌'} ({elapsed}s)")

    return {
        "passed": passed,
        "p_value": round(p_value, 6),
        "real_ic": round(real_ic, 6),
        "null_ic_mean": round(float(null_arr.mean()), 6),
        "null_ic_std": round(float(null_arr.std()), 6),
        "n_permutations": n_permutations,
        "elapsed_s": elapsed,
        "permutation_mode": permutation_mode,
        "max_parallel_workers": max_workers,
        "sector_aware": bool(
            str(permutation_mode).lower() in {"within_date_sector", "within_sector_date"}
            and sectors_train is not None
            and len(sectors_train) == len(y_train)
        ),
    }


# ══════════════════════════════════════════════════════════════════════════════
# Step 3: IC/ICIR Stability Check
# ══════════════════════════════════════════════════════════════════════════════

def ic_icir_check(
    X: np.ndarray, y: np.ndarray, dates: np.ndarray,
    feature_names: list[str],
    min_ic: float = 0.0,
    min_icir: float = 0.3,
) -> dict:
    """Per-feature Spearman IC and IC Information Ratio (ICIR).

    IC = Spearman rank correlation(feature, target) per date → mean
    ICIR = IC_mean / IC_std (higher = more stable signal)

    Returns:
        {name: {"ic": float, "icir": float, "stable": bool}}
    """
    unique_dates = np.unique(dates)
    results = {}

    for i, name in enumerate(feature_names):
        feature_vals = X[:, i]
        ics_per_date = []

        for d in unique_dates:
            mask = dates == d
            f_d = feature_vals[mask]
            y_d = y[mask]
            if len(f_d) < 10:
                continue
            # Spearman rank correlation
            if np.std(f_d) < 1e-10 or np.std(y_d) < 1e-10:
                continue
            rho, _ = stats.spearmanr(f_d, y_d)
            if not np.isnan(rho):
                ics_per_date.append(rho)

        if len(ics_per_date) < 5:
            results[name] = {"ic": 0.0, "icir": 0.0, "stable": False, "n_dates": len(ics_per_date)}
            continue

        ic_mean = float(np.mean(ics_per_date))
        ic_std = float(np.std(ics_per_date))
        icir = ic_mean / max(ic_std, 1e-10)

        results[name] = {
            "ic": round(ic_mean, 6),
            "icir": round(icir, 4),
            "stable": ic_mean > min_ic and icir > min_icir,
            "n_dates": len(ics_per_date),
        }

    stable_count = sum(1 for v in results.values() if v["stable"])
    print(f"[IC/ICIR] {stable_count}/{len(feature_names)} features pass "
          f"(IC>{min_ic}, ICIR>{min_icir})")

    return results


# ══════════════════════════════════════════════════════════════════════════════
# Step 4: Elbow Detection (kneed)
# ══════════════════════════════════════════════════════════════════════════════

def mutual_information_evidence(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
    *,
    random_state: int = 42,
) -> dict:
    """Nonlinear feature evidence using sklearn mutual information."""

    t0 = time.time()
    try:
        from sklearn.feature_selection import mutual_info_regression

        raw = mutual_info_regression(
            np.asarray(X, dtype=float),
            np.asarray(y, dtype=float),
            random_state=random_state,
        )
    except Exception as exc:
        return {"status": "error", "error": str(exc), "per_feature": {}, "elapsed_s": 0.0}

    raw = np.nan_to_num(np.asarray(raw, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
    max_val = float(raw.max()) if raw.size else 0.0
    norm = raw / max(max_val, 1e-12)
    per_feature = {
        name: {"mi": round(float(raw[i]), 8), "score": round(float(norm[i]), 6)}
        for i, name in enumerate(feature_names)
    }
    top = sorted(per_feature, key=lambda n: per_feature[n]["score"], reverse=True)[:20]
    elapsed = round(time.time() - t0, 1)
    print(f"[MutualInfo] Computed MI evidence for {len(feature_names)} features ({elapsed}s)")
    return {"status": "ok", "elapsed_s": elapsed, "top_features": top, "per_feature": per_feature}


def stability_selection_evidence(
    X: np.ndarray,
    y: np.ndarray,
    dates: np.ndarray,
    feature_names: list[str],
    *,
    n_blocks: int = 5,
) -> dict:
    """Block/date-aware stability evidence for feature signals."""

    t0 = time.time()
    date_arr = np.asarray(dates).astype(str)
    unique_dates = np.sort(np.unique(date_arr))
    if len(unique_dates) < 3:
        return {"status": "insufficient_dates", "blocks": 0, "per_feature": {}, "elapsed_s": 0.0}

    blocks = [b for b in np.array_split(unique_dates, min(n_blocks, len(unique_dates))) if len(b)]
    per_feature: dict[str, dict] = {}
    for i, name in enumerate(feature_names):
        block_ics: list[float] = []
        vals = X[:, i]
        for block_dates in blocks:
            mask = np.isin(date_arr, block_dates)
            if int(mask.sum()) < 10:
                continue
            f_b = vals[mask]
            y_b = y[mask]
            if np.std(f_b) < 1e-10 or np.std(y_b) < 1e-10:
                continue
            rho, _ = stats.spearmanr(f_b, y_b)
            if not np.isnan(rho):
                block_ics.append(float(rho))

        if not block_ics:
            per_feature[name] = {"score": 0.0, "positive_ratio": 0.0, "mean_ic": 0.0, "blocks": 0}
            continue

        positive_ratio = float(np.mean([ic > 0 for ic in block_ics]))
        mean_ic = float(np.mean(block_ics))
        ic_std = float(np.std(block_ics))
        stability = positive_ratio * max(mean_ic, 0.0) / max(ic_std, 0.05)
        per_feature[name] = {
            "score": round(float(np.clip(stability, 0.0, 1.0)), 6),
            "positive_ratio": round(positive_ratio, 4),
            "mean_ic": round(mean_ic, 6),
            "blocks": len(block_ics),
        }

    top = sorted(per_feature, key=lambda n: per_feature[n]["score"], reverse=True)[:20]
    elapsed = round(time.time() - t0, 1)
    print(f"[StabilitySelection] Computed block stability for {len(feature_names)} features ({elapsed}s)")
    return {
        "status": "ok",
        "elapsed_s": elapsed,
        "blocks": len(blocks),
        "top_features": top,
        "per_feature": per_feature,
    }


def cur_representative_evidence(
    X: np.ndarray,
    feature_names: list[str],
    cluster_result: dict,
    *,
    max_components: int = 12,
    max_rows: int = 5000,
) -> dict:
    """CUR-style column leverage evidence for representative feature selection."""

    t0 = time.time()
    if X.size == 0 or not feature_names:
        return {"status": "empty", "per_feature": {}, "elapsed_s": 0.0}

    X_arr = np.asarray(X, dtype=float)
    if len(X_arr) > max_rows:
        idx = np.linspace(0, len(X_arr) - 1, max_rows).astype(int)
        X_arr = X_arr[idx]
    X_arr = np.nan_to_num(X_arr, nan=0.0, posinf=0.0, neginf=0.0)
    X_arr = X_arr - X_arr.mean(axis=0, keepdims=True)
    X_arr = X_arr / np.maximum(X_arr.std(axis=0, keepdims=True), 1e-9)

    try:
        _, _, vt = np.linalg.svd(X_arr, full_matrices=False)
    except Exception as exc:
        return {"status": "error", "error": str(exc), "per_feature": {}, "elapsed_s": 0.0}

    k = min(max_components, vt.shape[0])
    leverage = np.sum(vt[:k, :] ** 2, axis=0)
    max_val = float(leverage.max()) if leverage.size else 0.0
    norm = leverage / max(max_val, 1e-12)
    per_feature = {
        name: {
            "leverage": round(float(leverage[i]), 8),
            "score": round(float(norm[i]), 6),
            "cluster": cluster_result.get("feature_to_group", {}).get(name),
        }
        for i, name in enumerate(feature_names)
    }
    top = sorted(per_feature, key=lambda n: per_feature[n]["score"], reverse=True)[:20]
    elapsed = round(time.time() - t0, 1)
    print(f"[CUR] Computed column leverage evidence for {len(feature_names)} features ({elapsed}s)")
    return {
        "status": "ok",
        "elapsed_s": elapsed,
        "components": k,
        "top_features": top,
        "per_feature": per_feature,
    }


def elbow_detection(per_feature: dict[str, dict], score_key: str = "score") -> dict:
    """Data-driven threshold via kneed Elbow detection.

    Sorts features by score descending, finds the "knee" (diminishing returns point).
    Features above the knee = active, below = reserve.

    Returns:
        {
            "threshold": float,
            "knee_index": int,
            "active": [name, ...],
            "reserve": [name, ...],
        }
    """
    from kneed import KneeLocator

    # Sort by score descending
    sorted_features = sorted(per_feature.items(), key=lambda x: -x[1][score_key])
    scores = [v[score_key] for _, v in sorted_features]
    names = [n for n, _ in sorted_features]

    if len(scores) < 5:
        return {"threshold": 0, "knee_index": len(scores), "active": names, "reserve": []}

    # Kneed: find elbow in descending curve
    x = list(range(len(scores)))
    kneedle = KneeLocator(x, scores, curve="convex", direction="decreasing", S=1.0)

    knee_idx = kneedle.knee if kneedle.knee is not None else len(scores)
    # Include the knee point itself in active
    knee_idx = min(knee_idx + 1, len(scores))
    threshold = scores[knee_idx - 1] if knee_idx > 0 else 0

    active = names[:knee_idx]
    reserve = names[knee_idx:]

    print(f"[Elbow] Knee at index {knee_idx}: threshold={threshold:.4f}, "
          f"active={len(active)}, reserve={len(reserve)}")

    return {
        "threshold": round(threshold, 6),
        "knee_index": knee_idx,
        "active": active,
        "reserve": reserve,
    }


# ══════════════════════════════════════════════════════════════════════════════
# Step 4b: Optuna K Sweep (replaces elbow_detection in 2.0 pipeline)
# ══════════════════════════════════════════════════════════════════════════════

def _spearman_ic(preds: np.ndarray, y: np.ndarray) -> float:
    if np.std(preds) < 1e-10 or np.std(y) < 1e-10:
        return 0.0
    rho, _ = stats.spearmanr(preds, y)
    return float(rho) if not np.isnan(rho) else 0.0


def _make_optuna_sampler(optuna_module, sampler_name: str):
    sampler_name = _normalized_choice(
        sampler_name,
        default="nsga2",
        allowed=_SUPPORTED_K_SWEEP_SAMPLERS,
    )
    if sampler_name in {"motpe", "tpe"}:
        return optuna_module.samplers.TPESampler(
            seed=42,
            multivariate=True,
            group=True,
            constant_liar=True,
        )
    return optuna_module.samplers.NSGAIISampler(seed=42)


def _single_validation_k_ic(
    indices: list[int],
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    *,
    optuna_n_jobs: int,
) -> float:
    per_trial_jobs = max(1, (os.cpu_count() or 1) // max(1, optuna_n_jobs))
    booster = _train_lgbm_regression(
        X_train[:, indices],
        y_train,
        X_val[:, indices],
        y_val,
        seed=42,
        lightgbm_n_jobs=per_trial_jobs,
    )
    return _spearman_ic(np.asarray(booster.predict(X_val[:, indices]), dtype=float), y_val)


def _purged_rolling_k_ic(
    indices: list[int],
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    *,
    dates_train: np.ndarray | None,
    dates_val: np.ndarray | None,
    embargo_days: int,
    optuna_n_jobs: int,
    max_folds: int = 3,
) -> tuple[float, dict]:
    if dates_train is None or dates_val is None:
        return (
            _single_validation_k_ic(indices, X_train, y_train, X_val, y_val, optuna_n_jobs=optuna_n_jobs),
            {"status": "fallback_single_val", "reason": "missing_dates"},
        )

    X_all = np.vstack([X_train, X_val])
    y_all = np.concatenate([y_train, y_val])
    dates_all = np.concatenate([dates_train, dates_val])
    unique_dates = np.sort(np.unique(dates_all))
    if len(unique_dates) < 40:
        return (
            _single_validation_k_ic(indices, X_train, y_train, X_val, y_val, optuna_n_jobs=optuna_n_jobs),
            {"status": "fallback_single_val", "reason": "insufficient_dates"},
        )

    min_train_dates = max(int(len(unique_dates) * 0.5), 20)
    available = len(unique_dates) - min_train_dates - max(0, int(embargo_days))
    fold_size = max(5, available // max(1, int(max_folds)))
    ics: list[float] = []
    per_trial_jobs = max(1, (os.cpu_count() or 1) // max(1, optuna_n_jobs))

    for fold_idx in range(max(1, int(max_folds))):
        val_start = min_train_dates + fold_idx * fold_size
        val_end = min(val_start + fold_size, len(unique_dates))
        train_end = max(0, val_start - max(0, int(embargo_days)))
        if val_end <= val_start or train_end < 20:
            continue
        train_dates = set(str(d) for d in unique_dates[:train_end])
        val_dates = set(str(d) for d in unique_dates[val_start:val_end])
        train_mask = np.array([str(d) in train_dates for d in dates_all])
        val_mask = np.array([str(d) in val_dates for d in dates_all])
        if train_mask.sum() < 100 or val_mask.sum() < 30:
            continue
        try:
            booster = _train_lgbm_regression(
                X_all[train_mask][:, indices],
                y_all[train_mask],
                X_all[val_mask][:, indices],
                y_all[val_mask],
                seed=42 + fold_idx,
                lightgbm_n_jobs=per_trial_jobs,
            )
            ics.append(
                _spearman_ic(
                    np.asarray(booster.predict(X_all[val_mask][:, indices]), dtype=float),
                    y_all[val_mask],
                )
            )
        except Exception:
            continue

    if not ics:
        return (
            _single_validation_k_ic(indices, X_train, y_train, X_val, y_val, optuna_n_jobs=optuna_n_jobs),
            {"status": "fallback_single_val", "reason": "no_valid_rolling_folds"},
        )

    median_ic = float(np.median(ics))
    std_ic = float(np.std(ics))
    robust_ic = median_ic - 0.25 * std_ic
    return robust_ic, {
        "status": "ok",
        "folds": len(ics),
        "median_ic": round(median_ic, 6),
        "std_ic": round(std_ic, 6),
        "penalty": 0.25,
    }


def _detect_pareto_knee(pareto_pts: list[tuple[int, float]]) -> int | None:
    if len(pareto_pts) < 3:
        return None
    try:
        from kneed import KneeLocator

        kl = KneeLocator(
            [p[0] for p in pareto_pts],
            [p[1] for p in pareto_pts],
            curve="concave",
            direction="increasing",
        )
        return int(kl.knee) if kl.knee is not None else None
    except Exception as exc:
        print(f"[OptunaKSweep] Kneedle failed: {exc}")
        return None


def _select_k_from_pareto(
    pareto_pts: list[tuple[int, float]],
    *,
    min_k: int,
    n_max: int,
    knee_policy: str,
    bootstrap_rounds: int,
) -> tuple[int, float, str, dict]:
    if not pareto_pts:
        return n_max, 0.0, "fallback_empty", {}

    pareto_pts = sorted(pareto_pts, key=lambda x: x[0])
    max_ic = max(ic for _k, ic in pareto_pts)
    knee_method = "fallback"
    knee_meta: dict[str, Any] = {}
    knee_k = _detect_pareto_knee(pareto_pts)
    if knee_k is not None:
        knee_method = "kneedle"

    if knee_policy == "bootstrap_ci" and len(pareto_pts) >= 5 and bootstrap_rounds > 0:
        rng = np.random.RandomState(42)
        sampled_knees: list[int] = []
        for _ in range(int(bootstrap_rounds)):
            sample_idx = rng.choice(len(pareto_pts), size=len(pareto_pts), replace=True)
            sample = sorted({pareto_pts[int(i)] for i in sample_idx}, key=lambda x: x[0])
            sample_knee = _detect_pareto_knee(sample)
            if sample_knee is not None:
                sampled_knees.append(int(sample_knee))
        if sampled_knees:
            lo, hi = np.percentile(sampled_knees, [10, 90])
            median_k = int(np.median(sampled_knees))
            knee_meta = {
                "policy": "bootstrap_ci",
                "rounds": int(bootstrap_rounds),
                "valid_knees": len(sampled_knees),
                "p10": int(lo),
                "p50": median_k,
                "p90": int(hi),
            }
            if (hi - lo) <= max(5, 0.2 * n_max):
                knee_k = median_k
                knee_method = "bootstrap_kneedle"

    if knee_k is None:
        threshold = 0.9 * max_ic if knee_policy == "bootstrap_ci" else 0.8 * max_ic
        knee_k = next((k for k, ic in pareto_pts if ic >= threshold), pareto_pts[-1][0])
        knee_method = "0.9_threshold" if knee_policy == "bootstrap_ci" else "0.8_threshold"

    best_k = min(max(int(knee_k), int(min_k)), int(n_max))
    best_ic = next((ic for k, ic in pareto_pts if k == best_k), 0.0)
    if best_ic == 0.0:
        best_ic = next((ic for k, ic in pareto_pts if k >= best_k), max_ic)
    return best_k, float(best_ic), knee_method, knee_meta


def optuna_k_sweep(
    per_feature: dict[str, dict],
    X_train: np.ndarray, y_train: np.ndarray,
    X_val: np.ndarray, y_val: np.ndarray,
    feature_names: list[str],
    n_trials: int = 150,        # 2026-04-17: 50→150 (NSGAII 2-objective Pareto 建議 150-200)
    score_key: str = "score",
    n_jobs: int = 1,
    min_k: int = 20,            # 2026-04-17: MIN_K guard（共線性保護，少於 20 稀釋 ensemble diversity）
    sampler_name: str = "nsga2",
    objective_mode: str = "single_val_ic",
    knee_policy: str = "kneedle_080",
    bootstrap_rounds: int = 0,
    dates_train: np.ndarray | None = None,
    dates_val: np.ndarray | None = None,
    embargo_days: int = 10,
) -> dict:
    """Optuna K sweep: multi-objective Pareto (maximize IC, minimize K).

    Replaces single-objective maximize IC with Pareto front to avoid overfitting K.

    Selection rule (Plan B, 2026-04-17):
      1. Optuna NSGAII explores (K, IC) Pareto front
      2. Kneedle knee detection ONLY on Pareto front — finds marginal IC gain 趨緩 的拐點
      3. MIN_K=20 guard 避免共線性下被壓到個位數 K

    Why Kneedle on Pareto front (not full sweep): V1 Permutation Importance 的教訓是
    Kneedle 直接用在 feature importance 曲線會 correlation dilution；這裡 Kneedle 只作用
    在 Pareto 已 dominated-filter 的 (K, IC) 點，是二階事後選取，不走回頭路。
    見 memory/project_feature_selection_locked_plan.md。

    Returns same format as elbow_detection for backward compat:
        {"active": [...], "reserve": [...], "threshold": float, "knee_index": int,
         "best_k": int, "best_ic": float, "sweep_results": [(k, ic), ...]}
    """
    import optuna
    from threading import Lock
    optuna.logging.set_verbosity(optuna.logging.WARNING)

    t0 = time.time()
    sampler_name = _normalized_choice(sampler_name, default="nsga2", allowed=_SUPPORTED_K_SWEEP_SAMPLERS)
    objective_mode = _normalized_choice(
        objective_mode,
        default="single_val_ic",
        allowed=_SUPPORTED_K_SWEEP_OBJECTIVES,
    )
    knee_policy = _normalized_choice(
        knee_policy,
        default="kneedle_080",
        allowed=_SUPPORTED_KNEE_POLICIES,
    )
    optuna_n_jobs = _bounded_parallel_workers(n_jobs, default=1, hard_cap=4)

    # Sort features by score descending
    sorted_features = sorted(per_feature.items(), key=lambda x: -x[1].get(score_key, 0))
    sorted_names = [n for n, _ in sorted_features]
    name_to_idx = {n: i for i, n in enumerate(feature_names)}
    n_max = len(sorted_names)
    objective_cache: dict[int, tuple[float, int]] = {}
    objective_cache_lock = Lock()
    objective_cache_hits = 0

    if n_max < 5:
        return {
            "threshold": 0, "knee_index": n_max,
            "active": sorted_names, "reserve": [],
            "best_k": n_max, "best_ic": 0.0,
            "sweep_results": [],
        }

    def objective(trial):
        nonlocal objective_cache_hits
        k = trial.suggest_int("k", 5, n_max)
        with objective_cache_lock:
            cached = objective_cache.get(k)
            if cached is not None:
                objective_cache_hits += 1
                return cached
        top_k = sorted_names[:k]
        indices = [name_to_idx[n] for n in top_k if n in name_to_idx]
        if len(indices) < 5:
            result = (0.0, k)
            with objective_cache_lock:
                objective_cache.setdefault(k, result)
            return result
        try:
            if objective_mode == "purged_rolling_ic":
                ic, _meta = _purged_rolling_k_ic(
                    indices,
                    X_train,
                    y_train,
                    X_val,
                    y_val,
                    dates_train=dates_train,
                    dates_val=dates_val,
                    embargo_days=embargo_days,
                    optuna_n_jobs=optuna_n_jobs,
                )
            else:
                ic = _single_validation_k_ic(
                    indices,
                    X_train,
                    y_train,
                    X_val,
                    y_val,
                    optuna_n_jobs=optuna_n_jobs,
                )
        except Exception:
            ic = 0.0
        result = (ic, k)
        with objective_cache_lock:
            objective_cache.setdefault(k, result)
        return result

    # Multi-objective study: maximize IC, minimize K.
    # Keep NSGA-II as the deterministic production baseline; Optuna 4.x
    # TPESampler also supports multi-objective and should be benchmarked before
    # changing sampler behavior.
    study = optuna.create_study(
        directions=["maximize", "minimize"],
        sampler=_make_optuna_sampler(optuna, sampler_name),
    )
    study.optimize(objective, n_trials=n_trials, n_jobs=optuna_n_jobs, show_progress_bar=False)

    # Collect all (k, ic) pairs from all trials
    sweep_results = []
    for trial in study.trials:
        if trial.values is not None and len(trial.values) == 2:
            ic_val, k_val = trial.values
            sweep_results.append({"k": int(trial.params["k"]), "ic": round(float(ic_val), 6)})

    # Select best K from Pareto front using Kneedle knee detection (Plan B, 2026-04-17)
    pareto_trials = study.best_trials  # Pareto-optimal trials
    if not pareto_trials:
        # Fallback: use all trials
        pareto_trials = [t for t in study.trials if t.values is not None]

    # Build (K, IC) points from Pareto front, sorted by K ascending
    pareto_pts = sorted(
        [
            (int(t.params["k"]), float(t.values[0]))
            for t in pareto_trials
            if t.values is not None and "k" in t.params
        ],
        key=lambda x: x[0],
    )

    best_k = n_max
    best_ic = 0.0
    knee_method = "fallback"
    knee_meta: dict[str, Any] = {}

    if pareto_pts:
        ks = [p[0] for p in pareto_pts]
        ics = [p[1] for p in pareto_pts]
        max_ic = max(ics)

        # Kneedle knee on Pareto front — needs >= 3 points to detect curvature
        knee_k: int | None = None
        if len(pareto_pts) >= 3:
            try:
                from kneed import KneeLocator
                kl = KneeLocator(ks, ics, curve="concave", direction="increasing")
                if kl.knee is not None:
                    knee_k = int(kl.knee)
                    knee_method = "kneedle"
            except Exception as _kne:
                print(f"[OptunaKSweep] Kneedle failed: {_kne}, falling back to 0.8 × max_IC rule")

        # Fallback 1: min-K with IC ≥ 0.8 × max_IC (less aggressive than 0.95)
        if knee_k is None:
            fallback_k = next((k for k, ic in pareto_pts if ic >= 0.8 * max_ic), pareto_pts[-1][0])
            knee_k = fallback_k
            knee_method = "0.8_threshold"

        # MIN_K guard: 共線性保護
        best_k = max(int(knee_k), min_k)
        # Find actual IC at best_k (or closest Pareto point)
        best_ic = next((ic for k, ic in pareto_pts if k == best_k), 0.0)
        if best_ic == 0.0:
            # best_k was promoted by MIN_K guard — use IC of first Pareto point with k >= best_k
            best_ic = next((ic for k, ic in pareto_pts if k >= best_k), max_ic)

    if knee_policy != "kneedle_080":
        best_k, best_ic, knee_method, knee_meta = _select_k_from_pareto(
            pareto_pts,
            min_k=min_k,
            n_max=n_max,
            knee_policy=knee_policy,
            bootstrap_rounds=bootstrap_rounds,
        )

    # Clamp best_k to available feature count
    best_k = min(best_k, n_max)

    active = sorted_names[:best_k]
    reserve = sorted_names[best_k:]
    threshold = per_feature.get(sorted_names[best_k - 1], {}).get(score_key, 0) if best_k > 0 else 0

    elapsed = round(time.time() - t0, 1)
    print(f"[OptunaKSweep] Pareto+Kneedle best K={best_k}/{n_max} (IC={best_ic:.4f}, "
          f"method={knee_method}, min_k_guard={min_k}), "
          f"active={len(active)}, reserve={len(reserve)}, {elapsed}s")

    pareto_front = [
        {"k": int(t.params["k"]), "ic": round(float(t.values[0]), 6)}
        for t in pareto_trials
        if t.values
    ]

    return {
        "threshold": round(float(threshold), 6),
        "knee_index": best_k,
        "active": active,
        "reserve": reserve,
        "best_k": best_k,
        "best_ic": round(float(best_ic), 6),
        "sampler": sampler_name,
        "objective_mode": objective_mode,
        "knee_policy": knee_policy,
        "knee_method": knee_method,
        "knee_meta": knee_meta,
        "embargo_days": int(embargo_days),
        "n_jobs": optuna_n_jobs,
        "n_trials": int(n_trials),
        "actual_trials": len(study.trials),
        "unique_k_evaluated": len(objective_cache),
        "objective_cache_hits": int(objective_cache_hits),
        "sweep_results": sweep_results,   # all trial (k, ic) pairs sorted by k
        "pareto_front": pareto_front,     # Pareto-optimal trials only
    }


# ══════════════════════════════════════════════════════════════════════════════
# Step 5: Diversity Guard (P4 — interface defined here, full logic in P4)
# ══════════════════════════════════════════════════════════════════════════════

def _k_sweep_summary(k_sweep_result: dict) -> dict:
    """Keep compact K-sweep scope fields for orchestration telemetry."""
    keys = (
        "best_k",
        "best_ic",
        "n_trials",
        "actual_trials",
        "unique_k_evaluated",
        "objective_cache_hits",
        "sampler",
        "objective_mode",
        "knee_policy",
        "knee_method",
    )
    return {
        key: k_sweep_result.get(key)
        for key in keys
        if k_sweep_result.get(key) is not None
    }


def diversity_guard(
    active: list[str],
    reserve: list[str],
    feature_groups: dict[str, list[str]],
    feature_to_group: dict[str, int],
) -> tuple[list[str], list[str]]:
    """Ensure no factor family is completely eliminated.

    If ALL features in a cluster group are in reserve, rescue the best one back to active.
    "Best" = the one with highest score in per_feature (caller passes sorted order).

    Returns: (updated_active, updated_reserve)
    """
    active_set = set(active)
    rescued = []

    for gid, members in feature_groups.items():
        # Check if any member is in active
        has_active = any(m in active_set for m in members)
        if not has_active and members:
            # Rescue first member (caller sorted by score, so first = best)
            best = members[0]
            rescued.append(best)

    if rescued:
        print(f"[DiversityGuard] Rescued {len(rescued)} features from extinct groups: {rescued}")
        active = active + rescued
        reserve = [r for r in reserve if r not in set(rescued)]

    return active, reserve


# ══════════════════════════════════════════════════════════════════════════════
# Feature Pool Management (保留 V2)
# ══════════════════════════════════════════════════════════════════════════════

def update_feature_pool(
    active: list[str],
    reserve: list[str],
    cluster_result: dict,
    tp_stats: dict,
    ic_results: dict | None = None,
    all_feature_names: list[str] | None = None,
    k_sweep_result: dict | None = None,           # P0-2: Pareto K sweep result
    gate_result: dict | None = None,              # P0-9: Signal Sanity Gate result
    extra_evidence: dict | None = None,
) -> dict:
    """Build feature_pool.json structure for governed active training.

    tree_active: filtered features for tree models (LightGBM/XGBoost/ExtraTrees)
    active:      backward-compat alias for tree_active
    """
    from datetime import UTC, datetime
    from .training_policy import FEATURE_SELECTION_GOVERNANCE, MODEL_FEATURE_POLICIES

    dropped = cluster_result.get("dropped_features", [])
    reserve = sorted(set(reserve + dropped))
    tree_active = sorted(active)
    model_policies = {
        name: policy.to_dict()
        for name, policy in MODEL_FEATURE_POLICIES.items()
    }

    pool = {
        "updated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "method": "target_permutation_2.0",
        "active": tree_active,           # backward compat
        "tree_active": tree_active,      # explicit: tree models use this
        "reserve": reserve,
        "candidate": [],
        "feature_policy_schema_version": "feature-pool-policy-v1",
        "selection_governance": FEATURE_SELECTION_GOVERNANCE,
        "model_feature_policies": model_policies,
        "selection_evidence": {
            "tree": {
                "feature_source": "feature_pool.tree_active",
                "feature_count": len(tree_active),
                "selection_required": True,
                "methods": ["signal_sanity_gate", "target_permutation", "correlation_clustering", "ic_icir", "optuna_k_sweep", "diversity_guard"],
            },
            "governance": extra_evidence or {},
        },
        "cluster_info": {
            "n_groups": cluster_result["n_groups"],
            "best_k": cluster_result["best_k"],
            "silhouette": cluster_result["best_silhouette"],
        },
        "target_permutation": {
            "n_permutations": tp_stats.get("n_permutations", 0),
            "elapsed_s": tp_stats.get("elapsed_s", 0),
            "permutation_mode": tp_stats.get("permutation_mode"),
            "sector_aware": bool(tp_stats.get("sector_aware")),
        },
        "ic_icir": {
            "stable_count": sum(1 for v in (ic_results or {}).values() if v.get("stable")),
            "total": len(ic_results or {}),
        },
        "k_sweep": {
            "best_k": (k_sweep_result or {}).get("best_k"),
            "best_ic": (k_sweep_result or {}).get("best_ic"),
            "sweep_results": (k_sweep_result or {}).get("sweep_results", []),
            "pareto_front": (k_sweep_result or {}).get("pareto_front", []),
        } if k_sweep_result else {},
        "signal_gate": gate_result if gate_result else {},  # P0-9: Signal Sanity Gate metadata
    }
    return pool


def save_feature_pool(pool: dict, gcs_prefix: str | None = None) -> None:
    """Save feature_pool.json to GCS.

    gcs_prefix=None → production: writes universal/feature_pool.json + universal/powershap_history/YYYY-MM.json
    gcs_prefix=str  → walk-forward: writes {gcs_prefix}/feature_pool.json ONLY (no monthly snapshot)
    """
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS_BUCKET_NAME not configured or bucket unavailable")

    pool_json = json.dumps(pool, ensure_ascii=False, indent=2)

    if gcs_prefix:
        # Walk-forward per-window write (no monthly snapshot)
        path = f"{gcs_prefix.rstrip('/')}/feature_pool.json"
        bucket.blob(path).upload_from_string(pool_json, content_type="application/json")
        print(f"[FeatureSelection] Saved {path} to GCS (wf scope)")
    else:
        # Production canonical write.
        bucket.blob("universal/feature_pool.json").upload_from_string(
            pool_json, content_type="application/json"
        )
        month = pool["updated_at"][:7]
        bucket.blob(f"universal/powershap_history/{month}.json").upload_from_string(
            pool_json, content_type="application/json"
        )
        print(f"[FeatureSelection] Saved feature_pool.json + history/{month}.json to GCS")


def save_feature_selection_algorithm_evidence(evidence: dict, gcs_prefix: str | None = None) -> None:
    """Save feature-selection algorithm evidence packet next to feature_pool."""
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS_BUCKET_NAME not configured or bucket unavailable")
    evidence_json = _json_dumps(evidence)
    if gcs_prefix:
        path = f"{gcs_prefix.rstrip('/')}/feature_selection_algorithm_evidence.json"
    else:
        path = "universal/feature_selection_algorithm_evidence.json"
    bucket.blob(path).upload_from_string(evidence_json, content_type="application/json")
    print(f"[FeatureSelection] Saved {path}")


def load_feature_pool() -> Optional[dict]:
    """Load feature_pool.json from GCS."""
    bucket = _get_bucket()
    if bucket is None:
        return None
    try:
        blob = bucket.blob("universal/feature_pool.json")
        return json.loads(blob.download_as_text())
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════════════════════
# Full Pipeline (2.0)
# ══════════════════════════════════════════════════════════════════════════════

def _run_governance_evidence_stage(
    X_train: np.ndarray,
    y_train: np.ndarray,
    dates_train: np.ndarray,
    feature_names: list[str],
    *,
    cluster_linkage: str = "ward",
) -> dict:
    cluster_result = cluster_features(X_train, feature_names, linkage_method=cluster_linkage)
    return {
        "cluster_result": cluster_result,
        "mi_result": mutual_information_evidence(X_train, y_train, feature_names),
        "stability_result": stability_selection_evidence(X_train, y_train, dates_train, feature_names),
        "cur_result": cur_representative_evidence(X_train, feature_names, cluster_result),
    }


def _run_k_sweep_stage(
    combined_scores: dict,
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    feature_names: list[str],
    k_sweep_n_jobs: int | None = None,
    n_jobs: int | None = None,
    sampler_name: str = "nsga2",
    objective_mode: str = "single_val_ic",
    knee_policy: str = "kneedle_080",
    bootstrap_rounds: int = 0,
    dates_train: np.ndarray | None = None,
    dates_val: np.ndarray | None = None,
    embargo_days: int = 10,
) -> dict:
    jobs = int(k_sweep_n_jobs if k_sweep_n_jobs is not None else n_jobs if n_jobs is not None else 1)
    try:
        result = optuna_k_sweep(
            combined_scores, X_train, y_train, X_val, y_val,
            feature_names=feature_names,
            n_jobs=jobs,
            sampler_name=sampler_name,
            objective_mode=objective_mode,
            knee_policy=knee_policy,
            bootstrap_rounds=bootstrap_rounds,
            dates_train=dates_train,
            dates_val=dates_val,
            embargo_days=embargo_days,
        )
        result["selection_method"] = result.get("selection_method", "optuna_k_sweep")
        return result
    except Exception as e:
        print(f"[FeatureSelection] Optuna K sweep failed ({e}), falling back to elbow_detection")
        result = elbow_detection(combined_scores)
        result["selection_method"] = "elbow_fallback_after_optuna_error"
        result["fallback_error"] = str(e)
        return result


def resolve_feature_selection_embargo_days(
    n_dates: int,
    *,
    embargo_mode: str,
    label_horizon_days: int,
    base_days: int = 10,
    embargo_pct: float = 0.015,
    max_days: int = 20,
) -> tuple[int, dict]:
    dynamic_days = dynamic_embargo_days(
        n_dates,
        base_days=base_days,
        embargo_pct=embargo_pct,
        max_days=max_days,
    )
    mode = _normalized_choice(
        embargo_mode,
        default="dynamic",
        allowed=_SUPPORTED_EMBARGO_MODES,
    )
    label_horizon_days = _coerce_positive_int(label_horizon_days, 5, minimum=1)
    if mode == "label_horizon":
        resolved = max(dynamic_days, label_horizon_days)
        source = "max(dynamic_embargo,label_horizon_days)"
    else:
        resolved = dynamic_days
        source = "dynamic_embargo"
    return int(resolved), {
        "mode": mode,
        "source": source,
        "base_days": int(base_days),
        "embargo_pct": float(embargo_pct),
        "max_days": int(max_days),
        "dynamic_days": int(dynamic_days),
        "label_horizon_days": int(label_horizon_days),
        "resolved_days": int(resolved),
    }


def build_feature_selection_algorithm_evidence(
    *,
    algorithm_config: dict,
    split_evidence: dict,
    cluster_result: dict,
    k_sweep_result: dict,
    checkpoint_stats: dict,
    elapsed_s: float,
) -> dict:
    return {
        "schema_version": FEATURE_SELECTION_ALGORITHM_EVIDENCE_SCHEMA_VERSION,
        "algorithm_profile": algorithm_config.get("algorithm_profile"),
        "cluster": {
            "linkage_method": cluster_result.get("linkage_method"),
            "distance_metric": cluster_result.get("distance_metric"),
            "best_k": cluster_result.get("best_k"),
            "best_silhouette": cluster_result.get("best_silhouette"),
            "n_groups": cluster_result.get("n_groups"),
            "linkage_caveat": cluster_result.get("linkage_caveat"),
        },
        "k_sweep": {
            "sampler": k_sweep_result.get("sampler"),
            "objective_mode": k_sweep_result.get("objective_mode"),
            "knee_policy": k_sweep_result.get("knee_policy"),
            "knee_method": k_sweep_result.get("knee_method"),
            "best_k": k_sweep_result.get("best_k"),
            "best_ic": k_sweep_result.get("best_ic"),
            "n_trials": k_sweep_result.get("n_trials"),
            "actual_trials": k_sweep_result.get("actual_trials"),
            "unique_k_evaluated": k_sweep_result.get("unique_k_evaluated"),
            "objective_cache_hits": k_sweep_result.get("objective_cache_hits"),
        },
        "split": split_evidence,
        "stage_checkpoints": checkpoint_stats,
        "elapsed_s": elapsed_s,
    }


def run_feature_selection_pipeline(
    max_rounds: int | None = None,
    alpha: float | None = None,
    dry_run: bool = False,
    icir_weight: float | None = None,
    train_end_date: str | None = None,  # 2026-04-19 N2: walk-forward — filter dates ≤ this (no future leak)
    gcs_prefix: str | None = None,       # 2026-04-19 N2: walk-forward — write to {prefix}/feature_pool.json
    **_kwargs,  # absorb deprecated params kept in old scheduler payloads
) -> dict:
    """Full 2.0 pipeline:
    Load prep data → Signal Sanity Gate → Silhouette → Target Permutation →
    IC/ICIR → Optuna K sweep (Pareto) → Diversity Guard → Save dual pool.

    Reads training data from GCS prep npz (same format as retrain).

    Walk-forward mode (train_end_date + gcs_prefix set):
      - Filter prep data to dates ≤ train_end_date BEFORE any computation
        → no look-ahead bias for that window
      - Write per-window pool to {gcs_prefix}/feature_pool.json (no monthly snapshot)
    """
    t0 = time.time()
    from .training_policy import FeatureSelectionPolicy

    selection_params = FeatureSelectionPolicy.from_env().to_selection_params(
        {
            **_kwargs,
            "max_rounds": max_rounds,
            "alpha": alpha,
            "icir_weight": icir_weight,
        }
    )
    selection_params = resolve_feature_selection_algorithm_config(selection_params)
    max_rounds = int(selection_params["max_rounds"])
    alpha = float(selection_params["alpha"])
    icir_weight = float(selection_params["icir_weight"])
    permutation_mode = str(selection_params["permutation_mode"])
    algorithm_profile = str(selection_params["algorithm_profile"])
    cluster_linkage = str(selection_params["cluster_linkage"])
    k_sweep_sampler = str(selection_params["k_sweep_sampler"])
    k_sweep_objective = str(selection_params["k_sweep_objective"])
    k_sweep_knee_policy = str(selection_params["k_sweep_knee_policy"])
    k_sweep_bootstrap_rounds = int(selection_params["k_sweep_bootstrap_rounds"])
    embargo_mode = str(selection_params["embargo_mode"])
    label_horizon_days = int(selection_params["label_horizon_days"])
    target_perm_workers = _bounded_parallel_workers(
        selection_params.get("target_permutation_max_workers"),
        default=2,
        hard_cap=4,
    )
    signal_sanity_workers = _bounded_parallel_workers(
        selection_params.get("signal_sanity_max_workers"),
        default=2,
        hard_cap=4,
    )
    k_sweep_n_jobs = _bounded_parallel_workers(
        selection_params.get("k_sweep_n_jobs"),
        default=2,
        hard_cap=4,
    )

    bucket = _get_bucket()
    if bucket is None:
        return {"error": "GCS_BUCKET_NAME not configured or bucket unavailable"}

    # ── 1. Load prep data ────────────────────────────────────────────────────
    prep_blobs = sorted(
        [b for b in bucket.list_blobs(prefix="universal/prep/") if b.name.endswith(".npz")],
        key=lambda b: b.name,
    )
    if not prep_blobs:
        return {"error": "No prep data in GCS. Run retrain first."}

    # Feature names + exact evidence cache. A cache hit means the GCS prep
    # objects, feature schema, and selection policy are byte-for-byte the same.
    fn_blob = bucket.blob("universal/prep/feature_names.json")
    feature_names = json.loads(fn_blob.download_as_text())
    cache_key = build_feature_selection_cache_key(
        prep_blobs=prep_blobs,
        feature_blob=fn_blob,
        feature_names=feature_names,
        selection_params=selection_params,
        train_end_date=train_end_date,
        gcs_prefix=gcs_prefix,
    )
    cached = load_feature_selection_cache(bucket, cache_key)
    if cached is not None:
        print(f"[FeatureSelection] Evidence cache HIT key={cache_key[:12]}")
        pool = cached.get("feature_pool")
        if isinstance(pool, dict) and not dry_run:
            save_feature_pool(pool, gcs_prefix=gcs_prefix)
        cached = dict(cached)
        cached["cache"] = {
            "hit": True,
            "key": cache_key,
            "path": _feature_selection_cache_path(cache_key),
            "source_elapsed_s": cached.get("elapsed_s"),
        }
        cached["elapsed_s"] = round(time.time() - t0, 1)
        return cached
    checkpoint_stats: dict[str, dict] = {}

    all_X, all_y, all_dates, all_sectors = [], [], [], []
    sector_blob_count = 0
    for blob in prep_blobs:
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        data = np.load(buf, allow_pickle=True)
        all_X.append(data["X"])
        all_y.append(data["y"])
        all_dates.append(data["dates"])
        if "sectors" in data.files:
            all_sectors.append(data["sectors"])
            sector_blob_count += 1
    X = np.vstack(all_X)
    y = np.concatenate(all_y)
    dates = np.concatenate(all_dates)
    sectors = np.concatenate(all_sectors) if sector_blob_count == len(prep_blobs) else None

    print(f"[FeatureSelection] Loaded {len(X)} samples, {len(feature_names)} features")

    # ── 1b. Walk-forward date-range filter (zero look-ahead) ─────────────────
    # Apply BEFORE nan_to_num + cluster + signal gate so all downstream stages
    # only see data ≤ train_end_date. target_rank in prep is per-date cross-
    # sectional (compute_cross_sectional_rank, features/__init__.py:93) so
    # post-hoc date filtering preserves rank validity for retained dates.
    if train_end_date is not None:
        dates_str = np.array([str(d) for d in dates])
        wf_mask = dates_str <= train_end_date
        kept = int(wf_mask.sum())
        if kept == 0:
            return {"error": f"walk_forward_filter: no samples ≤ {train_end_date}"}
        print(f"[FeatureSelection] WF filter: dates ≤ {train_end_date} → "
              f"{kept}/{len(X)} samples retained")
        X = X[wf_mask]
        y = y[wf_mask]
        dates = dates[wf_mask]
        if sectors is not None:
            sectors = sectors[wf_mask]

    X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)

    # ── 2. Purged time-based split: 70 / embargo / 10(val) / embargo / 20(test) ──
    sorted_dates = np.sort(np.unique(dates))
    n_dates = len(sorted_dates)
    embargo_days, split_evidence = resolve_feature_selection_embargo_days(
        n_dates,
        embargo_mode=embargo_mode,
        label_horizon_days=label_horizon_days,
        base_days=10,
        embargo_pct=0.015,
        max_days=20,
    )

    cut70_idx = int(n_dates * 0.7)
    cut80_idx = int(n_dates * 0.8)
    emb1_end = min(cut70_idx + embargo_days, cut80_idx)  # embargo after train
    emb2_end = min(cut80_idx + embargo_days, n_dates)     # embargo after val

    train_dates = set(str(d) for d in sorted_dates[:cut70_idx])
    val_dates = set(str(d) for d in sorted_dates[emb1_end:cut80_idx])
    test_dates = set(str(d) for d in sorted_dates[emb2_end:])

    train_mask = np.array([str(d) in train_dates for d in dates])
    val_mask = np.array([str(d) in val_dates for d in dates])
    test_mask = np.array([str(d) in test_dates for d in dates])

    X_train, y_train = X[train_mask], y[train_mask]
    X_val, y_val = X[val_mask], y[val_mask]
    X_test, y_test = X[test_mask], y[test_mask]
    dates_train = dates[train_mask]
    dates_val = dates[val_mask]
    sectors_train = sectors[train_mask] if sectors is not None else None

    split_evidence.update({
        "train_samples": int(len(X_train)),
        "val_samples": int(len(X_val)),
        "test_samples": int(len(X_test)),
        "n_dates": int(n_dates),
    })
    print(f"[FeatureSelection] Purged split: train={len(X_train)}, val={len(X_val)}, "
          f"test={len(X_test)}, embargo={embargo_days}d, profile={algorithm_profile}")

    # ── 2b. Signal Sanity Gate (P0-6) ───────────────────────────────────────
    print(f"[FeatureSelection] Running signal sanity gate (30 permutations)...")
    gate_result = run_feature_selection_stage(
        bucket,
        cache_key,
        "signal_gate",
        dry_run=dry_run,
        checkpoint_stats=checkpoint_stats,
        compute=lambda: signal_sanity_gate(
            X_train,
            y_train,
            X_val,
            y_val,
            n_permutations=30,
            alpha=alpha,
            dates_train=dates_train,
            sectors_train=sectors_train,
            permutation_mode=permutation_mode,
            max_parallel_workers=signal_sanity_workers,
        ),
    )
    if not gate_result.get("passed", False):
        print(f"[FeatureSelection] ❌ Signal gate FAILED (p={gate_result.get('p_value')}) — "
              f"no learnable signal in data. Aborting (keeping previous pool).")
        return {
            "error": "signal_gate_failed",
            "gate": gate_result,
            "algorithm_profile": algorithm_profile,
            "algorithm_config": selection_params,
            "split": split_evidence,
            "stage_checkpoints": checkpoint_stats,
        }
    print(f"[FeatureSelection] ✅ Signal sanity gate passed (p={gate_result.get('p_value')})")

    # ── 3. Silhouette clustering ─────────────────────────────────────────────
    governance_result = run_feature_selection_stage(
        bucket,
        cache_key,
        "governance_evidence",
        dry_run=dry_run,
        checkpoint_stats=checkpoint_stats,
        compute=lambda: _run_governance_evidence_stage(
            X_train,
            y_train,
            dates_train,
            feature_names,
            cluster_linkage=cluster_linkage,
        ),
    )
    cluster_result = governance_result["cluster_result"]
    mi_result = governance_result["mi_result"]
    stability_result = governance_result["stability_result"]
    cur_result = governance_result["cur_result"]

    # ── 4. Target Permutation ────────────────────────────────────────────────
    tp_result = run_feature_selection_stage(
        bucket,
        cache_key,
        "target_permutation",
        dry_run=dry_run,
        checkpoint_stats=checkpoint_stats,
        compute=lambda: target_permutation(
            X_train, y_train, X_val, y_val,
            feature_names=feature_names,
            max_permutations=max_rounds,
            ks_alpha=0.05,
            ks_check_interval=10,
            dates_train=dates_train,
            sectors_train=sectors_train,
            permutation_mode=permutation_mode,
            max_parallel_workers=target_perm_workers,
        ),
    )

    if "error" in tp_result:
        return {**tp_result, "stage_checkpoints": checkpoint_stats}

    # ── 5. IC/ICIR selection on validation; keep test as final audit only ───
    ic_stage = run_feature_selection_stage(
        bucket,
        cache_key,
        "ic_icir",
        dry_run=dry_run,
        checkpoint_stats=checkpoint_stats,
        compute=lambda: {
            "ic_results": ic_icir_check(X_val, y_val, dates_val, feature_names),
            "final_oos_audit": ic_icir_check(X_test, y_test, dates[test_mask], feature_names),
        },
    )
    ic_results = ic_stage["ic_results"]
    final_oos_audit = ic_stage["final_oos_audit"]

    # ── 6. Combine TP score + IC stability into final score ─────────────────
    combined_scores = {}
    for name in feature_names:
        tp_score = tp_result["per_feature"].get(name, {}).get("score", 0)
        ic_info = ic_results.get(name, {})
        ic_stable = 1.0 if ic_info.get("stable", False) else 0.0
        icir = ic_info.get("icir", 0)
        mi_score = (mi_result.get("per_feature") or {}).get(name, {}).get("score", 0)
        stability_score = (stability_result.get("per_feature") or {}).get(name, {}).get("score", 0)
        cur_score = (cur_result.get("per_feature") or {}).get(name, {}).get("score", 0)
        governance_bonus = 0.05 * mi_score + 0.08 * stability_score + 0.03 * cur_score
        combined_scores[name] = {
            "score": round(tp_score + icir * icir_weight + governance_bonus, 4),
            "tp_score": tp_score,
            "icir": icir,
            "ic_stable": bool(ic_stable),
            "mi_score": round(float(mi_score), 6),
            "stability_score": round(float(stability_score), 6),
            "cur_score": round(float(cur_score), 6),
            "governance_bonus": round(float(governance_bonus), 6),
        }

    # ── 7. K selection: Optuna Pareto sweep + Kneedle (Plan B, 2026-04-17) ───
    k_sweep_result = run_feature_selection_stage(
        bucket,
        cache_key,
        "k_sweep",
        dry_run=dry_run,
        checkpoint_stats=checkpoint_stats,
        compute=lambda: _run_k_sweep_stage(
            combined_scores, X_train, y_train, X_val, y_val,
            feature_names=feature_names,  # n_trials/min_k 走 function 預設 (150/20)
            n_jobs=k_sweep_n_jobs,
            sampler_name=k_sweep_sampler,
            objective_mode=k_sweep_objective,
            knee_policy=k_sweep_knee_policy,
            bootstrap_rounds=k_sweep_bootstrap_rounds,
            dates_train=dates_train,
            dates_val=dates_val,
            embargo_days=embargo_days,
        ),
    )
    print(f"[FeatureSelection] Optuna K sweep: best_k={k_sweep_result.get('best_k')}, "
          f"best_ic={k_sweep_result.get('best_ic')}")

    # ── 8. Diversity Guard ───────────────────────────────────────────────────
    active_sorted = sorted(
        k_sweep_result["active"],
        key=lambda n: combined_scores.get(n, {}).get("score", 0),
        reverse=True,
    )
    reserve_sorted = k_sweep_result["reserve"]

    active_final, reserve_final = diversity_guard(
        active_sorted, reserve_sorted,
        cluster_result["groups"],
        cluster_result["feature_to_group"],
    )

    # ── 9. Build and save governed active tree feature pool ──
    pool = update_feature_pool(
        active_final, reserve_final,
        all_feature_names=feature_names,
        cluster_result=cluster_result,
        tp_stats={
            "n_permutations": tp_result["n_permutations"],
            "elapsed_s": tp_result["elapsed_s"],
            "permutation_mode": tp_result.get("permutation_mode"),
            "sector_aware": tp_result.get("sector_aware"),
            "max_parallel_workers": tp_result.get("max_parallel_workers"),
        },
        ic_results=ic_results,
        gate_result=gate_result,
        k_sweep_result=k_sweep_result,
        extra_evidence={
            "mutual_information": {k: v for k, v in mi_result.items() if k != "per_feature"},
            "stability_selection": {k: v for k, v in stability_result.items() if k != "per_feature"},
            "cur": {k: v for k, v in cur_result.items() if k != "per_feature"},
        },
    )

    if not dry_run:
        save_feature_pool(pool, gcs_prefix=gcs_prefix)
    else:
        print("[FeatureSelection] DRY RUN — skipping GCS save")

    # ── 10. SHAP baseline comparison (if shap_audit.json exists) ─────────────
    # WF mode: skip — universal/shap_audit.json reflects post-train_end data
    # so the comparison would inject look-ahead context.
    shap_overlap = None
    if train_end_date is not None:
        print("[FeatureSelection] SHAP comparison skipped in walk-forward mode")
    else:
        try:
            shap_blob = bucket.blob("universal/shap_audit.json")
            if shap_blob.exists():
                shap_data = json.loads(shap_blob.download_as_text())
                shap_keep = set(shap_data.get("keep", []))
                tp_active = set(active_final)
                overlap = shap_keep & tp_active
                only_shap = shap_keep - tp_active
                only_tp = tp_active - shap_keep
                shap_overlap = {
                    "overlap": len(overlap),
                    "shap_total": len(shap_keep),
                    "tp_total": len(tp_active),
                    "overlap_ratio": round(len(overlap) / max(len(shap_keep), 1), 3),
                    "only_in_shap": sorted(only_shap)[:20],
                    "only_in_tp": sorted(only_tp)[:20],
                }
                print(f"[FeatureSelection] SHAP baseline comparison: "
                      f"{len(overlap)}/{len(shap_keep)} overlap ({shap_overlap['overlap_ratio']:.0%})")
        except Exception as e:
            print(f"[FeatureSelection] SHAP comparison skipped: {e}")

    elapsed = round(time.time() - t0, 1)
    print(f"\n[FeatureSelection] === PIPELINE COMPLETE ({elapsed}s) ===")
    print(f"[FeatureSelection] Active: {len(active_final)}, Reserve: {len(reserve_final)}")
    algorithm_evidence = build_feature_selection_algorithm_evidence(
        algorithm_config=selection_params,
        split_evidence=split_evidence,
        cluster_result=cluster_result,
        k_sweep_result=k_sweep_result,
        checkpoint_stats=checkpoint_stats,
        elapsed_s=elapsed,
    )

    final_result = {
        "feature_pool": pool,
        "algorithm_profile": algorithm_profile,
        "algorithm_evidence": algorithm_evidence,
        "cluster": {k: v for k, v in cluster_result.items() if k != "groups"},
        "target_permutation": {
            "n_permutations": tp_result["n_permutations"],
            "elapsed_s": tp_result["elapsed_s"],
            "permutation_mode": tp_result.get("permutation_mode"),
            "sector_aware": tp_result.get("sector_aware"),
            "per_feature_sample": {k: v for k, v in list(tp_result["per_feature"].items())[:10]},
        },
        "ic_icir": {
            "stable_count": sum(1 for v in ic_results.values() if v["stable"]),
            "total": len(ic_results),
            "selection_split": "validation",
        },
        "final_oos_audit": {
            "stable_count": sum(1 for v in final_oos_audit.values() if v["stable"]),
            "total": len(final_oos_audit),
            "used_for_selection": False,
        },
        "signal_gate": gate_result,
        "k_sweep": _k_sweep_summary(k_sweep_result),
        "feature_governance": {
            "mutual_information": {k: v for k, v in mi_result.items() if k != "per_feature"},
            "stability_selection": {k: v for k, v in stability_result.items() if k != "per_feature"},
            "cur": {k: v for k, v in cur_result.items() if k != "per_feature"},
        },
        "shap_comparison": shap_overlap,
        "cache": {
            "hit": False,
            "key": cache_key,
            "path": _feature_selection_cache_path(cache_key),
        },
        "stage_checkpoints": checkpoint_stats,
        "elapsed_s": elapsed,
    }
    if not dry_run:
        try:
            save_feature_selection_algorithm_evidence(algorithm_evidence, gcs_prefix=gcs_prefix)
            save_feature_selection_cache(bucket, cache_key, final_result)
            print(f"[FeatureSelection] Evidence cache saved key={cache_key[:12]}")
        except Exception as exc:
            print(f"[FeatureSelection] Evidence cache save skipped: {exc}")
    return final_result
