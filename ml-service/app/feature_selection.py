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
import numpy as np
from typing import Optional
from scipy import stats
from scipy.cluster import hierarchy
from scipy.spatial.distance import squareform
from sklearn.metrics import silhouette_score


# ══════════════════════════════════════════════════════════════════════════════
# Step 1: Silhouette Clustering (保留 V2，不動)
# ══════════════════════════════════════════════════════════════════════════════

def cluster_features(X: np.ndarray, feature_names: list[str],
                     k_range: tuple[int, int] = (5, 40)) -> dict:
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
            "elapsed_s": 0,
        }

    # Spearman rank-order correlation
    corr_matrix, _ = stats.spearmanr(X_valid)
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
    linkage_matrix = hierarchy.ward(condensed)

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
        "elapsed_s": elapsed,
    }


# ══════════════════════════════════════════════════════════════════════════════
# Step 2: Target Permutation (2.0 — replaces Grouped Powershap)
# ══════════════════════════════════════════════════════════════════════════════

def _train_lgbm_regression(X_train: np.ndarray, y_train: np.ndarray,
                           X_val: np.ndarray, y_val: np.ndarray,
                           seed: int = 42) -> "lightgbm.Booster":
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
        "n_jobs": -1,
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


def target_permutation(
    X_train: np.ndarray, y_train: np.ndarray,
    X_val: np.ndarray, y_val: np.ndarray,
    feature_names: list[str],
    max_permutations: int = 100,
    ks_alpha: float = 0.05,
    ks_check_interval: int = 10,
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

    for perm_i in range(max_permutations):
        y_shuffled = rng.permutation(y_train)
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
# Step 5: Diversity Guard (P4 — interface defined here, full logic in P4)
# ══════════════════════════════════════════════════════════════════════════════

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
) -> dict:
    """Build feature_pool.json structure."""
    from datetime import datetime

    dropped = cluster_result.get("dropped_features", [])
    reserve = sorted(set(reserve + dropped))

    pool = {
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "method": "target_permutation_2.0",
        "active": sorted(active),
        "reserve": reserve,
        "candidate": [],
        "cluster_info": {
            "n_groups": cluster_result["n_groups"],
            "best_k": cluster_result["best_k"],
            "silhouette": cluster_result["best_silhouette"],
        },
        "target_permutation": {
            "n_permutations": tp_stats.get("n_permutations", 0),
            "elapsed_s": tp_stats.get("elapsed_s", 0),
        },
        "ic_icir": {
            "stable_count": sum(1 for v in (ic_results or {}).values() if v.get("stable")),
            "total": len(ic_results or {}),
        },
    }
    return pool


def save_feature_pool(pool: dict) -> None:
    """Save feature_pool.json to GCS."""
    from google.cloud import storage
    bucket = storage.Client().bucket("stockvision-models")

    pool_json = json.dumps(pool, ensure_ascii=False, indent=2)
    bucket.blob("universal/feature_pool.json").upload_from_string(
        pool_json, content_type="application/json"
    )

    month = pool["updated_at"][:7]
    bucket.blob(f"universal/powershap_history/{month}.json").upload_from_string(
        pool_json, content_type="application/json"
    )
    print(f"[FeatureSelection] Saved feature_pool.json + history/{month}.json to GCS")


def load_feature_pool() -> Optional[dict]:
    """Load feature_pool.json from GCS."""
    from google.cloud import storage
    bucket = storage.Client().bucket("stockvision-models")
    try:
        blob = bucket.blob("universal/feature_pool.json")
        return json.loads(blob.download_as_text())
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════════════════════
# Full Pipeline (2.0)
# ══════════════════════════════════════════════════════════════════════════════

def run_feature_selection_pipeline(
    max_rounds: int = 100,
    alpha: float = 0.01,
    dry_run: bool = False,
    **_kwargs,  # absorb legacy params (required_power etc.)
) -> dict:
    """Full 2.0 pipeline:
    Load prep data → Silhouette → Target Permutation → IC/ICIR → Elbow → Diversity Guard → Save.

    Reads training data from GCS prep npz (same format as retrain).
    """
    t0 = time.time()

    from google.cloud import storage
    bucket = storage.Client().bucket("stockvision-models")

    # ── 1. Load prep data ────────────────────────────────────────────────────
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

    # Feature names
    fn_blob = bucket.blob("universal/prep/feature_names.json")
    feature_names = json.loads(fn_blob.download_as_text())
    print(f"[FeatureSelection] Loaded {len(X)} samples, {len(feature_names)} features")

    X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)

    # ── 2. Purged time-based split: 70 / embargo / 10(val) / embargo / 20(test) ──
    embargo_days = 10  # ~1.3%T per De Prado AFML Ch.7 (aligned with main.py)
    sorted_dates = np.sort(np.unique(dates))
    n_dates = len(sorted_dates)

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

    print(f"[FeatureSelection] Purged split: train={len(X_train)}, val={len(X_val)}, "
          f"test={len(X_test)}, embargo={embargo_days}d")

    # ── 3. Silhouette clustering ─────────────────────────────────────────────
    cluster_result = cluster_features(X, feature_names)

    # ── 4. Target Permutation ────────────────────────────────────────────────
    tp_result = target_permutation(
        X_train, y_train, X_val, y_val,
        feature_names=feature_names,
        max_permutations=max_rounds,
        ks_alpha=0.05,
        ks_check_interval=10,
    )

    if "error" in tp_result:
        return tp_result

    # ── 5. IC/ICIR stability check (on test set) ────────────────────────────
    dates_test = dates[test_mask]
    ic_results = ic_icir_check(X_test, y_test, dates_test, feature_names)

    # ── 6. Elbow detection ───────────────────────────────────────────────────
    # Combine TP score + IC stability into final score
    combined_scores = {}
    for name in feature_names:
        tp_score = tp_result["per_feature"].get(name, {}).get("score", 0)
        ic_info = ic_results.get(name, {})
        ic_stable = 1.0 if ic_info.get("stable", False) else 0.0
        icir = ic_info.get("icir", 0)

        # Final score: TP score (importance) + IC bonus (stability)
        # TP score is dominant, IC/ICIR is a tiebreaker/filter
        combined_scores[name] = {
            "score": round(tp_score + icir * 0.1, 4),
            "tp_score": tp_score,
            "icir": icir,
            "ic_stable": bool(ic_stable),
        }

    elbow_result = elbow_detection(combined_scores)

    # ── 7. Diversity Guard ───────────────────────────────────────────────────
    # Sort active by score so diversity_guard rescues the "best" from each extinct group
    active_sorted = sorted(
        elbow_result["active"],
        key=lambda n: combined_scores.get(n, {}).get("score", 0),
        reverse=True,
    )
    reserve_sorted = elbow_result["reserve"]

    active_final, reserve_final = diversity_guard(
        active_sorted, reserve_sorted,
        cluster_result["groups"],
        cluster_result["feature_to_group"],
    )

    # ── 8. Build and save feature pool ───────────────────────────────────────
    pool = update_feature_pool(
        active_final, reserve_final, cluster_result,
        tp_stats={
            "n_permutations": tp_result["n_permutations"],
            "elapsed_s": tp_result["elapsed_s"],
        },
        ic_results=ic_results,
    )

    if not dry_run:
        save_feature_pool(pool)
    else:
        print("[FeatureSelection] DRY RUN — skipping GCS save")

    # ── 9. SHAP baseline comparison (if shap_audit.json exists) ──────────────
    shap_overlap = None
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

    return {
        "feature_pool": pool,
        "cluster": {k: v for k, v in cluster_result.items() if k != "groups"},
        "target_permutation": {
            "n_permutations": tp_result["n_permutations"],
            "elapsed_s": tp_result["elapsed_s"],
            "per_feature_sample": {k: v for k, v in list(tp_result["per_feature"].items())[:10]},
        },
        "ic_icir": {
            "stable_count": sum(1 for v in ic_results.values() if v["stable"]),
            "total": len(ic_results),
        },
        "elbow": {
            "threshold": elbow_result["threshold"],
            "knee_index": elbow_result["knee_index"],
        },
        "shap_comparison": shap_overlap,
        "elapsed_s": elapsed,
    }
