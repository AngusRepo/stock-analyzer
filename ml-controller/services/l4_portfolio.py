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
from services.l4_quadratic_refinement import refine
from services.l4_numeric_contract import WEIGHT_SUPPORT

# Outer-approximation engineering constants (solver numerics, not trading parameters):
# static perspective cuts per name at k/8 of its cap, leading eigen-directions lifted,
# static tangents per lifted direction across its range, and the rounds without a
# certificate after which the lift is added.
PERSPECTIVE_ANCHORS = 8
FACTOR_RANK = 50
FACTOR_ANCHORS = 4
LIFT_AFTER_ROUNDS = 10


def allocate(*, symbols, expected_gross, covariance, current_weights,
             exposure_cap, name_cap, min_weight, max_positions,
             buy_cost, sell_cost, locked_symbols=(), forbidden_buys=(),
             capital_available=1., risk_aversion=2., name_caps=None, exposure_groups=None,
             alpha_strength=1., turnover_penalty=0., turnover_pressure=None, l2_penalty=0.,
             membership_groups=None, excluded_pairs=(), trade_uncertainty=None,
             buy_cost_adjustments=None, sell_cost_adjustments=None,
             objective_costs=None, tolerance=1e-8, time_limit=30.):
    n = len(symbols)
    if len(set(symbols)) != n:
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
    uncertainty=np.zeros(n) if trade_uncertainty is None else np.asarray(trade_uncertainty,float)
    if uncertainty.shape!=(n,) or not np.isfinite(uncertainty).all() or (uncertainty<0).any():
        raise ValueError('l4_trade_uncertainty_invalid')
    additional_buy=np.zeros(n) if buy_cost_adjustments is None else np.asarray(buy_cost_adjustments,float)
    additional_sell=np.zeros(n) if sell_cost_adjustments is None else np.asarray(sell_cost_adjustments,float)
    if any(v.shape!=(n,) or not np.isfinite(v).all() or (v<0).any() for v in (additional_buy,additional_sell)):
        raise ValueError('l4_execution_cost_invalid')
    buy_costs=buy_cost+additional_buy;sell_costs=sell_cost+additional_sell
    if (buy_costs>=1).any() or (sell_costs>=1).any():raise ValueError('l4_execution_cost_invalid')
    # Objective-only cost semantic (l4_cost_objective). Cash budget, validity and
    # reported trading cost always use the actual single-side fees above.
    if objective_costs is None:
        entry_costs,reduce_costs=buy_costs,sell_costs
    else:
        entry_costs,reduce_costs=(np.asarray(v,float) for v in objective_costs)
        if any(v.shape!=(n,) or not np.isfinite(v).all() or (v<0).any() or (v>=1).any() for v in (entry_costs,reduce_costs)):
            raise ValueError('l4_objective_cost_invalid')
    if (gross.shape != (n,) or mu.shape != (n,) or current.shape != (n,) or risk_matrix.shape != (n, n) or q.shape != (n, n)
            or not np.isfinite(mu).all() or not np.isfinite(q).all()
            or not np.isfinite(current).all() or (current < 0).any()
            or (n and np.max(abs(q - q.T)) > 1e-10)):
        raise ValueError('l4_portfolio_numeric_contract_invalid')
    eigen_floor=float(np.linalg.eigvalsh(q)[0]) if n else 0.
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
    pair_indices=[]
    for pair in excluded_pairs:
        if len(pair)!=2 or pair[0]==pair[1] or set(pair)-set(symbols):raise ValueError('l4_excluded_pair_invalid')
        pair_indices.append(tuple(symbols.index(s) for s in pair))
    if set(caps)-set(symbols) or any(not math.isfinite(v) or not 0<=v<=name_cap for v in caps.values()):
        raise ValueError('l4_portfolio_name_caps_invalid')
    if not n:
        if exposure_groups or membership_groups or excluded_pairs:
            raise ValueError('l4_portfolio_exposure_group_invalid')
        # With no candidates OR holdings the feasible portfolio is exactly cash.
        # This is an analytical zero-dimensional solution, not a synthetic fill.
        return {'weights': {}, 'cash_weight': 1., 'expected_gross': 0., 'risk_penalty': 0.,
            'l2_penalty': 0., 'turnover_pressure_penalty': 0., 'expected_trading_cost': 0.,
            'utility_parameters': {'alpha_strength': alpha_strength, 'risk_aversion': risk_aversion,
                'turnover_penalty': turnover_penalty, 'l2_penalty': l2_penalty},
            'proof': {'evaluated_candidate_count': 0, 'preselection': False,
                'objective_utility': 0., 'global_utility_upper_bound': 0., 'absolute_objective_gap': 0.,
                'tolerance': tolerance, 'within_tolerance': True, 'rounds': 0, 'solution': 'empty_account_cash'},
            'constraints': {'exposure_cap': exposure_cap, 'name_cap': name_cap,
                'min_weight': min_weight, 'max_positions': max_positions, 'name_caps': caps, 'exposure_groups': {}}}
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
    for i,j in pair_indices:
        # Existing correlated positions may remain, but cannot authorize further buying.
        if current[i]>WEIGHT_SUPPORT and current[j]>WEIGHT_SUPPORT:
            upper[i]=min(upper[i],current[i]);upper[j]=min(upper[j],current[j])
    if (lower > upper).any() or lower.sum() > exposure_cap + tolerance:
        raise ValueError('l4_portfolio_locked_exposure_requires_risk_exit')
    membership_upper = np.maximum(upper, 0)
    matrices = [hstack([identity, -csc_matrix(np.diag(membership_upper)), zero, zero, column]),
                hstack([-identity, csc_matrix(np.diag(minima)), zero, zero, column]),
                hstack([identity, zero, -identity, identity, column]),
                csc_matrix(np.r_[np.ones(n), np.zeros(3*n+1)][None, :]),
                csc_matrix(np.r_[np.zeros(n), np.ones(n), np.zeros(2*n+1)][None, :]),
                csc_matrix(np.r_[np.ones(n), np.zeros(n), buy_costs,
                                 sell_costs, 0][None, :])]
    matrix = vstack(matrices, format='csc')
    lhs = np.r_[np.full(2*n, -np.inf), current, -np.inf, -np.inf, -np.inf]
    rhs = np.r_[np.zeros(2*n), current, exposure_cap, count_cap, capital_available]
    groups = {}
    group_rows = []
    membership_rows=[];membership_limits=[];membership_evidence={}
    for key,group in sorted((membership_groups or {}).items()):
        members=group.get('symbols') or [];limit=group.get('max_count')
        if not key or not members or len(set(members))!=len(members) or set(members)-set(symbols) or type(limit) is not int or limit<1:
            raise ValueError('l4_membership_group_invalid')
        indices=[symbols.index(s) for s in members]
        inherited=int(sum(lower[i]>0 for i in indices));effective=max(limit,inherited)
        membership_rows.append(indices);membership_limits.append(effective)
        membership_evidence[key]={'symbols':members,'max_count':limit,'effective_count':effective,'inherited_count':inherited}
    for i,j in pair_indices:
        membership_rows.append([i,j]);membership_limits.append(2 if current[i]>WEIGHT_SUPPORT and current[j]>WEIGHT_SUPPORT else 1)
    if membership_rows:
        rr=[];cc=[]
        for row,indices in enumerate(membership_rows):
            rr.extend([row]*len(indices));cc.extend(indices)
        selection=csc_matrix((np.ones(len(rr)),(rr,cc)),shape=(len(membership_rows),n))
        matrix=vstack([matrix,hstack([csc_matrix((len(membership_rows),n)),selection,csc_matrix((len(membership_rows),2*n+1))])],format='csc')
        lhs=np.r_[lhs,np.full(len(membership_rows),-np.inf)];rhs=np.r_[rhs,membership_limits]
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
    # Keep the original feasible region for fixed-membership QP refinement.
    # Quadratic epigraph cuts constrain the MILP bound, not this exact QP.
    linear_matrix, linear_lhs, linear_rhs = matrix, lhs, rhs
    linear_bounds = Bounds(np.r_[lower, np.zeros(3*n+1)], np.r_[upper, np.ones(n), np.ones(2*n), np.inf])
    # Outer approximation of w'Qw with Q = d*I + F'F + E, each part PSD:
    #   d*I: d is the eigen floor. Per name s_i >= d*w_i^2/z_i through perspective cuts
    #        s_i >= d*(2a*w_i - a^2*z_i), valid for every subset. Separable, so the bound
    #        moves name by name; one aggregated row per anchor could not (a ridge arm
    #        with 475 candidates stayed 1e-4 from its bound after 120s).
    #   F'F: the leading eigen-directions of Q - d*I, lifted as y = F w with u_j >= y_j^2
    #        by one-dimensional tangents. A dense tangent of w'Qw tightens one direction
    #        per round; high risk-aversion arms never closed the gap without the lift.
    #   E:   the PSD remainder, epigraph t >= w'Ew by tangents (Kelley).
    # Every cut is a tangent of a convex function, so the MILP optimum bounds the exact
    # objective from below over the whole feasible set. The lift makes every round
    # costlier, so it is added only after LIFT_AFTER_ROUNDS rounds without a certificate
    # (a round count, not a clock, so a replay takes the same path); the rebuilt model
    # keeps the incumbent, the verified bound and a cut at every point seen so far.
    diagonal = max(0., eigen_floor*(1-1e-9)-1e-12)
    residual = q - diagonal*np.eye(n)
    values, vectors = np.linalg.eigh((residual+residual.T)*.5)
    by_size = np.argsort(-values)
    deadline = time.monotonic() + time_limit
    model = {}

    def build(rank):
        leading = by_size[:rank]
        leading = leading[values[leading] > 0.]
        factor = (vectors[:, leading]*np.sqrt(values[leading])).T
        k = len(leading)
        rest = residual-factor.T@factor
        # Variables: w, z, pos, neg, t | s (n) | y (k) | u (k).
        width = 5*n+1+2*k
        s_at, y_at, u_at = 4*n+1, 5*n+1, 5*n+1+k
        y_low = np.minimum(factor*lower, factor*upper).sum(axis=1)
        y_high = np.maximum(factor*lower, factor*upper).sum(axis=1)
        model.update(factor=factor, k=k, rest=(rest+rest.T)*.5, width=width, s_at=s_at, y_at=y_at, u_at=u_at,
                     matrix=hstack([linear_matrix, csc_matrix((linear_matrix.shape[0], n+2*k))], format='csc'),
                     lhs=linear_lhs, rhs=linear_rhs,
                     bounds=Bounds(np.r_[lower, np.zeros(3*n+1), np.zeros(n), y_low, np.zeros(k)],
                                   np.r_[upper, np.ones(n), np.ones(2*n), np.inf, np.full(n, np.inf), y_high,
                                         np.full(k, np.inf)]),
                     objective=np.r_[-mu, np.zeros(n), entry_costs+uncertainty, reduce_costs+uncertainty, 1.,
                                     np.ones(n), np.zeros(k), np.ones(k)],
                     integrality=np.r_[np.zeros(n), np.ones(n), np.zeros(3*n+1+2*k)])
        if k:
            link = hstack([csc_matrix(-factor), csc_matrix((k, 4*n+1)), eye(k, format='csc'),
                           csc_matrix((k, k))], format='csc')
            model['matrix'] = vstack([model['matrix'], link], format='csc')
            model['lhs'], model['rhs'] = np.r_[model['lhs'], np.zeros(k)], np.r_[model['rhs'], np.zeros(k)]
            factor_cuts([(j, float(a)) for j in range(k) for a in np.linspace(y_low[j], y_high[j], FACTOR_ANCHORS)])
        if diagonal > 0:
            perspective_cuts([(i, float(upper[i]*f)) for i in range(n) if upper[i] > 0
                              for f in np.arange(1, PERSPECTIVE_ANCHORS+1)/PERSPECTIVE_ANCHORS])

    def add_rows(rr, cc, vv, bound):
        if not bound:
            return
        block = csc_matrix((10000.*np.asarray(vv, float), (rr, cc)), shape=(len(bound), model['width']))
        model['matrix'] = vstack([model['matrix'], block], format='csc')
        model['lhs'] = np.r_[model['lhs'], np.full(len(bound), -np.inf)]
        model['rhs'] = np.r_[model['rhs'], 10000.*np.asarray(bound, float)]

    def perspective_cuts(points):
        # d*(2a*w_i - a^2*z_i) - s_i <= 0
        rr, cc, vv = [], [], []
        for row, (i, a) in enumerate(points):
            rr += [row]*3; cc += [i, n+i, model['s_at']+i]; vv += [2*diagonal*a, -diagonal*a*a, -1.]
        add_rows(rr, cc, vv, [0.]*len(points))

    def factor_cuts(points):
        # 2a*y_j - u_j <= a^2
        rr, cc, vv = [], [], []
        for row, (j, a) in enumerate(points):
            rr += [row]*2; cc += [model['y_at']+j, model['u_at']+j]; vv += [2*a, -1.]
        add_rows(rr, cc, vv, [a*a for _, a in points])

    def cuts_at(points):
        rest = model['rest']
        for point in points:
            # 2(E c)'w - t <= c'Ec
            add_rows([0]*(n+1), list(range(n))+[4*n], np.r_[2*rest@point, -1.], [float(point@rest@point)])
        if model['k']:
            factor_cuts([(j, float(y)) for point in points for j, y in enumerate(model['factor']@point)])
        if diagonal > 0:
            perspective_cuts([(i, float(point[i])) for point in points for i in np.flatnonzero(point > WEIGHT_SUPPORT)])

    def solve(presolve):
        return milp(model['objective'] * 10000., integrality=model['integrality'], bounds=model['bounds'],
                    constraints=LinearConstraint(model['matrix'], model['lhs'], model['rhs']),
                    options={'time_limit': max(.01, deadline-time.monotonic()), 'mip_rel_gap': 1e-10,
                             'presolve': presolve,
                             # HiGHS defaults to 1e-6, looser than our 1e-8 certificate.
                             'mip_feasibility_tolerance': max(1e-10, tolerance*.1)})

    def dual_bound(result):
        bound = getattr(result, 'mip_dual_bound', None)
        return float(bound) / 10000. if bound is not None and math.isfinite(bound) else -math.inf

    build(0)
    seen = []
    best, best_value, global_lower, rounds, verifications, lifted = None, math.inf, -math.inf, 0, 0, False
    while time.monotonic() < deadline:
        if not lifted and rounds >= LIFT_AFTER_ROUNDS and FACTOR_RANK > 0:
            lifted = True
            build(FACTOR_RANK)
            cuts_at(seen)
        result = solve(True)
        rounds += 1
        if result.x is None:
            break
        raw = result.x[:n].copy()
        candidate = refine(result.x[:n], q=q, objective=model['objective'][:4*n+1], current=current,
                           matrix=linear_matrix, lhs=linear_lhs, rhs=linear_rhs,
                           bounds=linear_bounds, deadline=deadline)
        positive, negative = np.maximum(candidate-current, 0), np.maximum(current-candidate, 0)
        value = float(candidate @ q @ candidate - mu @ candidate + entry_costs@positive + reduce_costs@negative+uncertainty@(positive+negative))
        active = candidate > WEIGHT_SUPPORT
        valid = (candidate.min() >= -tolerance and (candidate <= upper+tolerance).all()
                 and (candidate >= lower-tolerance).all() and active.sum() <= count_cap
                 and (candidate[active] >= minima[active]-tolerance).all()
                 and all(vector @ candidate <= cap+tolerance for vector,cap in group_rows)
                 and candidate.sum() <= exposure_cap+tolerance
                 and candidate.sum()+buy_costs@positive+sell_costs@negative <= capital_available+tolerance
                 and (not membership_rows or (selection@active<=np.asarray(membership_limits)).all()))
        if not valid:
            raise ValueError('l4_portfolio_solver_infeasible_result')
        if value < best_value:
            best, best_value = candidate.copy(), value
        bound = dual_bound(result)
        if best_value - bound <= tolerance:
            # Bound within tolerance of the incumbent, or above it (an invalid bound: HiGHS
            # presolve reported Optimal above a feasible point, 11/18 ra 64). Only a bound
            # re-derived without presolve on the same model may certify or condemn: the
            # smaller of the two is kept, so one wrong solve cannot.
            verifications += 1
            bound = min(bound, dual_bound(solve(False)))
            global_lower = max(global_lower, bound)
            if best_value - global_lower <= tolerance:
                break
        points = [candidate] if np.max(abs(raw-candidate)) <= 1e-12 else [candidate, raw]
        seen += points
        cuts_at(points)
    gap = best_value - global_lower
    if best is None or not math.isfinite(gap) or gap > tolerance:
        raise ValueError('l4_portfolio_optimality_not_certified')
    if gap < -tolerance:
        raise ValueError('l4_portfolio_invalid_bound')
    weights = {s: float(max(0., w)) for s, w in zip(symbols, best)}
    return {'weights': weights, 'cash_weight': float(1-best.sum()),
            'trade_uncertainty_penalty':float(uncertainty@abs(best-current)),
            'expected_gross': float(gross@best), 'risk_penalty': float(best@risk_matrix@best),
            'l2_penalty':float(l2_penalty*(best@best)),
            'turnover_pressure_penalty':float(turnover_penalty*(pressure@best)),
            'utility_parameters':{'alpha_strength':alpha_strength,'risk_aversion':risk_aversion,
                'turnover_penalty':turnover_penalty,'l2_penalty':l2_penalty},
            'expected_trading_cost': float(buy_costs@np.maximum(best-current, 0)
                                           + sell_costs@np.maximum(current-best, 0)),
            'proof': {'evaluated_candidate_count': n, 'preselection': False,
                      'objective_utility': -best_value, 'global_utility_upper_bound': -global_lower,
                      'absolute_objective_gap': max(0., gap), 'tolerance': tolerance,
                      'within_tolerance': True, 'rounds': rounds, 'presolve_free_verifications': verifications,
                      'lifted_directions': model['k']},
            'constraints': {'exposure_cap': exposure_cap, 'name_cap': name_cap,
                            'min_weight': min_weight, 'max_positions': max_positions, 'name_caps':caps,
                            'exposure_groups':groups,'membership_groups':membership_evidence,'excluded_pairs':list(excluded_pairs)}}
