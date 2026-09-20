"""Signed full-pool mean/variance allocation with explicit discrete limits.

MILP outer approximation certifies the convex quadratic objective globally.
No ranking preselection. A timeout or unproven solution cannot authorize trades.
"""
from __future__ import annotations

import math
import time
import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import csc_matrix, eye, hstack, vstack


def allocate(*, symbols, expected_gross, covariance, current_weights,
             exposure_cap, name_cap, min_weight, max_positions,
             buy_cost, sell_cost, locked_symbols=(), forbidden_buys=(),
             capital_available=1., risk_aversion=2., name_caps=None, exposure_groups=None,
             alpha_strength=1., turnover_penalty=0., turnover_pressure=None, l2_penalty=0.,
             tolerance=1e-8, time_limit=30.):
    n = len(symbols)
    if n == 0 or len(set(symbols)) != n:
        raise ValueError('l4_portfolio_symbols_invalid')
    gross = np.asarray(expected_gross, float)
    pressure = np.zeros(n) if turnover_pressure is None else np.asarray(turnover_pressure, float)
    if (pressure.shape != (n,) or not np.isfinite(pressure).all() or (pressure < 0).any()
            or any(not math.isfinite(v) or v < 0 for v in (alpha_strength,turnover_penalty,l2_penalty))):
        raise ValueError('l4_portfolio_utility_parameters_invalid')
    mu = gross * alpha_strength - turnover_penalty * pressure
    risk_matrix = np.asarray(covariance, float) * float(risk_aversion)
    q = risk_matrix + l2_penalty * np.eye(n)
    current = np.asarray(current_weights, float)
    if (mu.shape != (n,) or current.shape != (n,) or q.shape != (n, n)
            or not np.isfinite(mu).all() or not np.isfinite(q).all()
            or not np.isfinite(current).all() or (current < 0).any()
            or np.max(abs(q - q.T)) > 1e-10):
        raise ValueError('l4_portfolio_numeric_contract_invalid')
    eigen_floor=float(np.linalg.eigvalsh(q)[0])
    if eigen_floor < -1e-10:
        raise ValueError('l4_portfolio_covariance_not_psd')
    if (not 0 <= exposure_cap <= 1 or not 0 <= name_cap <= 1
            or not 0 <= min_weight <= 1 or not 0 <= capital_available <= 1
            or risk_aversion < 0 or not 0 <= buy_cost < 1 or not 0 <= sell_cost < 1):
        raise ValueError('l4_portfolio_limits_invalid')
    if max_positions is not None and (type(max_positions) is not int or max_positions < 1):
        raise ValueError('l4_portfolio_position_cap_invalid')
    if not math.isfinite(tolerance) or not math.isfinite(time_limit) or not 0 < tolerance <= 1e-8 or time_limit <= 0:
        raise ValueError('l4_portfolio_solver_budget_invalid')
    count_cap = n if max_positions is None else min(n, max_positions)
    locked, forbidden = set(locked_symbols), set(forbidden_buys)
    if (locked | forbidden) - set(symbols):
        raise ValueError('l4_portfolio_constraint_symbol_missing')
    caps = name_caps or {}
    if set(caps)-set(symbols) or any(not math.isfinite(v) or not 0<=v<=name_cap for v in caps.values()):
        raise ValueError('l4_portfolio_name_caps_invalid')
    # Variables: target weights, binary membership, positive trade, negative
    # trade, and an epigraph variable for w'Qw. Costs apply to trades once.
    identity = eye(n, format='csc')
    zero = csc_matrix((n, n))
    column = csc_matrix((n, 1))
    upper = np.full(n, name_cap)
    lower = np.zeros(n)
    minima = np.full(n, min_weight)
    for i, symbol in enumerate(symbols):
        upper[i] = min(upper[i],caps.get(symbol,name_cap))
        if symbol in forbidden:
            upper[i] = min(upper[i], current[i])
        if symbol in locked:
            lower[i] = upper[i] = current[i]
            minima[i] = min(minima[i], current[i])
    if (lower > upper).any() or lower.sum() > exposure_cap + tolerance:
        raise ValueError('l4_portfolio_locked_exposure_requires_risk_exit')
    membership_upper = np.maximum(upper, 0)
    matrices = [hstack([identity, -csc_matrix(np.diag(membership_upper)), zero, zero, column]),
                hstack([-identity, csc_matrix(np.diag(minima)), zero, zero, column]),
                hstack([identity, zero, -identity, identity, column]),
                csc_matrix(np.r_[np.ones(n), np.zeros(3*n+1)][None, :]),
                csc_matrix(np.r_[np.zeros(n), np.ones(n), np.zeros(2*n+1)][None, :]),
                csc_matrix(np.r_[np.ones(n), np.zeros(n), np.full(n, buy_cost),
                                 np.full(n, sell_cost), 0][None, :])]
    matrix = vstack(matrices, format='csc')
    lhs = np.r_[np.full(2*n, -np.inf), current, -np.inf, -np.inf, -np.inf]
    rhs = np.r_[np.zeros(2*n), current, exposure_cap, count_cap, capital_available]
    groups = {}
    group_rows = []
    for group_id, group in sorted((exposure_groups or {}).items()):
        members = group.get('symbols') or []
        cap = group.get('cap')
        if (not group_id or not members or len(set(members)) != len(members)
                or set(members)-set(symbols) or not isinstance(cap,(int,float))
                or not math.isfinite(cap) or not 0 <= cap <= 1):
            raise ValueError('l4_portfolio_exposure_group_invalid')
        vector = np.array([float(symbol in members) for symbol in symbols])
        # A locked inherited overage cannot authorize any further group buying.
        inherited = float(vector @ lower)
        effective = max(float(cap), inherited)
        groups[group_id] = {'symbols':sorted(members),'cap':float(cap),
                            'effective_cap':effective,'locked_inherited_weight':inherited}
        group_rows.append((vector,effective))
        matrix = vstack([matrix,csc_matrix(np.r_[vector,np.zeros(3*n+1)][None,:])],format='csc')
        lhs = np.r_[lhs,-np.inf]
        rhs = np.r_[rhs,effective]
    # q >= lambda_min*I. For binary membership z, w_i^2 >= 2*a_i*w_i-a_i^2*z_i.
    # These global perspective cuts remain valid for EVERY candidate subset;
    # unlike a tangent at one sparse portfolio they also bound unseen subsets.
    diagonal_floor=max(0.,eigen_floor-1e-12)
    for fraction in (.25,.5,.75,1.):
        anchors=upper*fraction
        row=np.r_[2*diagonal_floor*anchors,-diagonal_floor*anchors**2,np.zeros(2*n),-1.]
        matrix=vstack([matrix,csc_matrix(10000.*row[None,:])],format='csc')
        lhs=np.r_[lhs,-np.inf];rhs=np.r_[rhs,0.]
    bounds = Bounds(np.r_[lower, np.zeros(3*n+1)],
                    np.r_[upper, np.ones(n), np.ones(2*n), np.inf])
    objective = np.r_[-mu, np.zeros(n), np.full(n, buy_cost), np.full(n, sell_cost), 1.]
    integrality = np.r_[np.zeros(n), np.ones(n), np.zeros(2*n+1)]
    deadline = time.monotonic() + time_limit
    best, best_value, global_lower, rounds = None, math.inf, -math.inf, 0
    while time.monotonic() < deadline:
        result = milp(objective * 10000., integrality=integrality, bounds=bounds,
                      constraints=LinearConstraint(matrix, lhs, rhs),
                      options={'time_limit': max(.01, deadline-time.monotonic()), 'mip_rel_gap': 1e-10,
                               # HiGHS defaults to 1e-6, looser than our 1e-8 certificate.
                               'mip_feasibility_tolerance': max(1e-10, tolerance*.1)})
        rounds += 1
        bound = getattr(result, 'mip_dual_bound', None)
        if bound is not None and math.isfinite(bound):
            global_lower = max(global_lower, float(bound) / 10000.)
        if result.x is None:
            break
        candidate = result.x[:n]
        positive, negative = np.maximum(candidate-current, 0), np.maximum(current-candidate, 0)
        value = float(candidate @ q @ candidate - mu @ candidate + buy_cost*positive.sum() + sell_cost*negative.sum())
        active = candidate > 1e-7
        valid = (candidate.min() >= -tolerance and (candidate <= upper+tolerance).all()
                 and (candidate >= lower-tolerance).all() and active.sum() <= count_cap
                 and (candidate[active] >= minima[active]-tolerance).all()
                 and all(vector @ candidate <= cap+tolerance for vector,cap in group_rows)
                 and candidate.sum() <= exposure_cap+tolerance
                 and candidate.sum()+buy_cost*positive.sum()+sell_cost*negative.sum() <= capital_available+tolerance)
        if not valid:
            raise ValueError('l4_portfolio_solver_infeasible_result')
        if value < best_value:
            best, best_value = candidate.copy(), value
        if best_value - global_lower <= tolerance:
            break
        tangent = np.r_[2*q@candidate, np.zeros(3*n), -1.]
        matrix = vstack([matrix, csc_matrix(10000. * tangent[None, :])], format='csc')
        lhs = np.r_[lhs, -np.inf]
        rhs = np.r_[rhs, 10000. * float(candidate@q@candidate)]
    gap = best_value - global_lower
    if best is None or not math.isfinite(gap) or gap > tolerance:
        raise ValueError('l4_portfolio_optimality_not_certified')
    if gap < -tolerance:
        raise ValueError('l4_portfolio_invalid_bound')
    weights = {s: float(max(0., w)) for s, w in zip(symbols, best)}
    return {'weights': weights, 'cash_weight': float(1-best.sum()),
            'expected_gross': float(gross@best), 'risk_penalty': float(best@risk_matrix@best),
            'l2_penalty':float(l2_penalty*(best@best)),
            'turnover_pressure_penalty':float(turnover_penalty*(pressure@best)),
            'utility_parameters':{'alpha_strength':alpha_strength,'risk_aversion':risk_aversion,
                'turnover_penalty':turnover_penalty,'l2_penalty':l2_penalty},
            'expected_trading_cost': float(buy_cost*np.maximum(best-current, 0).sum()
                                           + sell_cost*np.maximum(current-best, 0).sum()),
            'proof': {'evaluated_candidate_count': n, 'preselection': False,
                      'objective_utility': -best_value, 'global_utility_upper_bound': -global_lower,
                      'absolute_objective_gap': max(0., gap), 'tolerance': tolerance,
                      'within_tolerance': True, 'rounds': rounds},
            'constraints': {'exposure_cap': exposure_cap, 'name_cap': name_cap,
                            'min_weight': min_weight, 'max_positions': max_positions, 'name_caps':caps,
                            'exposure_groups':groups}}
