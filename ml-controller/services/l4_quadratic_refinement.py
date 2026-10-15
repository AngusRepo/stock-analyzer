"""Continuous QP refinement on a MILP-selected support; no subset search.

The caller must still certify the full mixed-integer problem. This helper only
supplies a better feasible incumbent and a valid quadratic tangent.
"""
import time
import numpy as np
from scipy.optimize import Bounds, LinearConstraint, minimize


def refine(candidate, *, q, objective, current, matrix, lhs, rhs, bounds, deadline):
    n = len(candidate)
    active = np.flatnonzero(candidate > 1e-7)
    if not len(active) or time.monotonic() >= deadline:
        return candidate
    # Freeze membership from the MILP, and account for every inactive sell.
    fixed = np.zeros(4*n+1)
    fixed[n+active] = 1.
    inactive = np.ones(n, bool)
    inactive[active] = False
    fixed[3*n:4*n][inactive] = current[inactive]
    columns = np.r_[active, 2*n+active, 3*n+active]
    design = matrix[:, columns].toarray()
    lo, hi = lhs-matrix@fixed, rhs-matrix@fixed
    relevant = np.any(design != 0, axis=1)
    if np.any((lo[~relevant] > 1e-9) | (hi[~relevant] < -1e-9)):
        return candidate
    design, lo, hi = design[relevant], lo[relevant], hi[relevant]
    equal = np.isfinite(lo) & (lo == hi)
    constraints = [LinearConstraint(design[mask],lo[mask],hi[mask])
                   for mask in (equal, ~equal) if mask.any()]
    k = len(active)
    quadratic = q[np.ix_(active, active)]
    linear = objective[columns]
    initial = np.r_[candidate[active], np.maximum(candidate[active]-current[active],0),
                    np.maximum(current[active]-candidate[active],0)]
    def fun(x):
        if time.monotonic() >= deadline:
            raise TimeoutError('refinement_budget')
        return float(x[:k]@quadratic@x[:k]+linear@x)
    def jac(x):
        return np.r_[2*quadratic@x[:k],np.zeros(2*k)]+linear
    try:
        solved = minimize(fun,initial,jac=jac,method='SLSQP',
            bounds=Bounds(bounds.lb[columns],bounds.ub[columns]),constraints=constraints,
            options={'ftol':1e-13,'maxiter':80})
    except TimeoutError:
        return candidate
    if not np.isfinite(solved.x).all():
        return candidate
    actual = design@solved.x
    if (np.any(actual < lo-1e-9) or np.any(actual > hi+1e-9)
            or np.any(solved.x < bounds.lb[columns]-1e-9)
            or np.any(solved.x > bounds.ub[columns]+1e-9)):
        return candidate
    initial_value=float(initial[:k]@quadratic@initial[:k]+linear@initial)
    refined_value=float(solved.x[:k]@quadratic@solved.x[:k]+linear@solved.x)
    if refined_value > initial_value:
        return candidate
    result=np.zeros(n)
    result[active]=solved.x[:k]
    return result
