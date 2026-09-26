"""Dependence-aware RC / SPA evidence, following Hansen (2005), section 3.

Returns must cover identical, ordered partitions; no truncation or missing-value
removal is allowed. Search coverage is a declared manifest, not inferred from
the number of candidates supplied to a pairwise replay.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np


DATA_SNOOPING_SCHEMA_VERSION = "data-snooping-evidence-v2"
IMPLEMENTATIONS = {
    "white_reality_check": "white-2000-stationary-v1",
    "hansen_spa": "hansen-2005-stationary-v1",
}

CANONICAL_METHODS = {
    "white_reality_check": "white_reality_check_stationary_bootstrap_v2",
    "hansen_spa": "hansen_spa_studentized_stationary_bootstrap_v2",
}
METHOD_FAMILIES = {value: key for key, value in CANONICAL_METHODS.items()}


def _long_run_variance(excess: np.ndarray, block_size: int) -> np.ndarray:
    """Stationary-bootstrap population variance (Hansen, section 3).

FFT autocovariances avoid a quadratic scan over long daily return histories.
"""
    n = excess.shape[0]
    centered = excess - excess.mean(axis=0)
    spectrum = np.fft.rfft(centered, n=2 * n, axis=0)
    cov = np.fft.irfft(spectrum.conj() * spectrum, n=2 * n, axis=0)[:n] / n
    lag = np.arange(1, n)
    decay = 1.0 - 1.0 / block_size
    weights = (1 - lag / n) * decay**lag + (lag / n) * decay ** (n - lag)
    return cov[0] + 2 * (weights[:, None] * cov[1:]).sum(axis=0)


def _stationary_indices(rng: np.random.Generator, n: int, reps: int, block_size: int) -> np.ndarray:
    indices = rng.integers(n, size=(reps, n))
    restart = rng.random((reps, n)) < 1.0 / block_size
    for t in range(1, n):
        indices[:, t] = np.where(restart[:, t], indices[:, t], (indices[:, t - 1] + 1) % n)
    return indices


def run_data_snooping_test(
    returns: dict[str, list[float]],
    *,
    method: str,
    benchmark: str | None = None,
    n_bootstrap: int = 1000,
    seed: int = 42,
    alpha: float = 0.20,
    block_size: int | None = None,
    search_candidate_ids: list[str] | None = None,
) -> dict[str, Any]:
    studentized = method == "hansen_spa"
    valid_ids = isinstance(returns, dict) and all(isinstance(name, str) and name for name in returns)
    ids = sorted(name for name in returns if name != benchmark) if valid_ids else []
    manifest_valid = (
        isinstance(search_candidate_ids, list)
        and all(isinstance(name, str) and name for name in search_candidate_ids)
        and len(set(search_candidate_ids)) == len(search_candidate_ids)
    )
    full_search = bool(ids) and manifest_valid and set(ids) == set(search_candidate_ids)
    common = {
        "schema_version": DATA_SNOOPING_SCHEMA_VERSION,
        "method": CANONICAL_METHODS.get(method, method) if isinstance(method, str) else None,
        "exact_formula": method in IMPLEMENTATIONS if isinstance(method, str) else False,
        "implementation_version": IMPLEMENTATIONS.get(method) if isinstance(method, str) else None,
        "bootstrap_method": "stationary_bootstrap",
        "studentized": studentized,
        "null_centering": "consistent" if studentized else "all_candidates_zero_mean",
        "benchmark": benchmark or "zero_return",
        "candidate_ids": ids,
        "candidate_count": len(ids),
        "search_candidate_ids": search_candidate_ids if manifest_valid else [],
        "search_trial_count": len(search_candidate_ids) if manifest_valid else None,
        "test_scope": "full_search" if full_search else "provided_candidates_only",
        "search_coverage_source": "caller_declared_manifest" if manifest_valid else "not_attached",
        "promotion_eligible": False,
        "seed": seed,
        "alpha": alpha,
    }

    def fail(reason: str) -> dict[str, Any]:
        return {**common, "status": "FAIL", "passed": False, "go_live_verdict": "FAIL", "reason": reason, "p_value": 1.0}

    if not isinstance(method, str) or method not in IMPLEMENTATIONS:
        return fail("unsupported_data_snooping_method")
    if not valid_ids:
        return fail("invalid_candidate_identifiers")
    if not ids or (benchmark is None and len(ids) < 2) or (benchmark is not None and benchmark not in returns):
        return fail("requires_benchmark_and_candidates_or_two_zero_benchmark_candidates")
    if not isinstance(n_bootstrap, int) or isinstance(n_bootstrap, bool) or n_bootstrap < 100:
        return fail("requires_at_least_100_bootstrap_replications")
    if isinstance(alpha, bool) or not isinstance(alpha, (int, float)) or not math.isfinite(alpha) or not 0 < alpha < 1:
        return fail("invalid_alpha")
    try:
        if any(not isinstance(values, list) for values in returns.values()):
            return fail("returns_must_be_lists")
        lengths = {len(values) for values in returns.values()}
        if len(lengths) != 1:
            return fail("partition_length_mismatch")
        n = lengths.pop()
        if n < 4:
            return fail("requires_at_least_four_partitions")
        columns = [np.asarray(returns[name], dtype=float) for name in ids]
        if any(column.shape != (n,) for column in columns):
            return fail("invalid_return_series_dimensions")
        matrix = np.column_stack(columns)
        base = np.zeros(n) if benchmark is None else np.asarray(returns[benchmark], dtype=float)
        if matrix.shape != (n, len(ids)) or base.shape != (n,):
            return fail("invalid_return_series_dimensions")
        if not np.isfinite(matrix).all() or not np.isfinite(base).all():
            return fail("non_finite_return")
    except (TypeError, ValueError, OverflowError):
        return fail("invalid_return_series")

    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0:
        return fail("invalid_bootstrap_seed")
    block = max(2, round(n ** (1 / 3))) if block_size is None else block_size
    if not isinstance(block, int) or isinstance(block, bool) or not 2 <= block < n:
        return fail("block_size_must_be_between_two_and_partition_count_minus_one")
    excess = matrix - base[:, None]
    if not np.isfinite(excess).all():
        return fail("non_finite_excess_return")
    means = excess.mean(axis=0)
    variances = _long_run_variance(excess, block)
    # Constant / numerically degenerate candidates violate SPA assumptions.
    variance_floor = 64 * np.finfo(float).eps * np.maximum(np.mean(excess**2, axis=0), np.finfo(float).tiny)
    if not np.isfinite(variances).all() or np.any(variances <= variance_floor):
        return fail("degenerate_long_run_variance")
    scale = np.sqrt(variances) if studentized else np.ones(len(ids))
    statistics = np.sqrt(n) * means / scale
    best_index = int(np.argmax(statistics))
    observed = max(0.0, float(statistics[best_index]))
    centers = means.copy()
    if studentized:
        threshold = -np.sqrt(variances / n * 2 * np.log(np.log(n)))
        centers[means < threshold] = 0.0

    rng = np.random.default_rng(seed)
    exceed = 0
    # All columns share each sampled time index to retain cross-candidate dependence.
    batch_size = max(1, min(128, 1_000_000 // (n * len(ids))))
    for start in range(0, n_bootstrap, batch_size):
        indices = _stationary_indices(rng, n, min(batch_size, n_bootstrap - start), block)
        boot_means = excess[indices].mean(axis=1)
        boot_statistics = np.maximum(0.0, (np.sqrt(n) * (boot_means - centers) / scale).max(axis=1))
        exceed += int(np.count_nonzero(boot_statistics >= observed))
    # Conservative finite-replication correction; never report p=0.
    p_value = (exceed + 1) / (n_bootstrap + 1)
    passed = observed > 0 and p_value <= alpha
    eligible = passed and full_search
    reason = "ok" if eligible else ("search_universe_not_fully_covered" if passed else "data_snooping_p_value_or_excess_return_failed")
    result = {
        **common,
        "status": "PASS" if passed else "FAIL",
        "passed": passed,
        "go_live_verdict": "PASS" if eligible else "FAIL",
        "promotion_eligible": eligible,
        "reason": reason,
        "partition_count": n,
        "alignment": "identical_ordered_partitions_required_equal_length_enforced",
        "block_size": block,
        "block_size_source": "cube_root_default" if block_size is None else "caller_supplied",
        "n_bootstrap": n_bootstrap,
        "bootstrap_exceedances": exceed,
        "p_value": p_value,
        "finite_replication_correction": "plus_one_with_ties",
        "best_candidate": ids[best_index],
        "observed_statistic": observed,
        "long_run_variances": dict(zip(ids, variances.tolist(), strict=True)),
        "null_centers": dict(zip(ids, centers.tolist(), strict=True)),
    }
    result["best_mean_excess_return" if benchmark else "best_mean_return"] = float(means[best_index])
    return result


def data_snooping_evidence_errors(
    record: dict[str, Any], *, max_p_value: float, required_trial_count: int | None = None,
) -> list[str]:
    """Shared promotion contract; old name-only receipts fail closed."""
    errors: list[str] = []
    method = METHOD_FAMILIES.get(record.get("method")) if isinstance(record.get("method"), str) else None
    if (record.get("schema_version") != DATA_SNOOPING_SCHEMA_VERSION
            or not isinstance(method, str) or method not in IMPLEMENTATIONS
            or record.get("implementation_version") != IMPLEMENTATIONS.get(method)
            or record.get("exact_formula") is not True
            or record.get("bootstrap_method") != "stationary_bootstrap"
            or record.get("studentized") is not (method == "hansen_spa")
            or record.get("null_centering") != ("consistent" if method == "hansen_spa" else "all_candidates_zero_mean")):
        errors.append("unverified_statistical_implementation")
    ids, manifest = record.get("candidate_ids"), record.get("search_candidate_ids")
    coverage = (
        isinstance(ids, list) and isinstance(manifest, list) and bool(ids)
        and all(isinstance(name, str) and name for name in [*ids, *manifest])
        and len(set(ids)) == len(ids) and len(set(manifest)) == len(manifest)
        and set(ids) == set(manifest)
        and record.get("candidate_count") == len(ids)
        and record.get("search_trial_count") == len(manifest)
        and (required_trial_count is None or len(manifest) == required_trial_count)
        and record.get("test_scope") == "full_search"
    )
    if not coverage:
        errors.append("search_universe_not_fully_covered")
    value = record.get("p_value")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= max_p_value:
        errors.append("invalid_or_excessive_p_value")
    if record.get("passed") is not True or record.get("promotion_eligible") is not True or record.get("go_live_verdict") != "PASS":
        errors.append("corrected_test_not_promotion_eligible")
    return errors
