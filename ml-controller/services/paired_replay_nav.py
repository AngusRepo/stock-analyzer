"""Calendar-aligned historical replay NAV, never prospective maturity credit.

Trade-index partitions are not paired observations: arms trade different names,
amounts and dates. Use the same source calendar and the actual account NAV from
the existing cost/settlement/corporate-action replay owner instead.
"""
from __future__ import annotations

from datetime import date
import math
from typing import Any

from services.paired_nav_journal import digest


def field(value: Any, key: str, default=None):
    return value.get(key, default) if isinstance(value, dict) else getattr(value, key, default)


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or value is None:
        raise ValueError('paired_replay_invalid_number:' + name)
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError('paired_replay_invalid_number:' + name) from exc
    if not math.isfinite(result):
        raise ValueError('paired_replay_invalid_number:' + name)
    return result


def paired_calendar_nav(champion: Any, candidate: Any, *, calendar: list[str],
                        start_date: str, end_date: str, initial_capital: float,
                        n_partitions: int = 6) -> dict[str, Any]:
    if type(n_partitions) is not int or n_partitions < 1:
        raise ValueError('paired_replay_invalid_partition_count')
    if (date.fromisoformat(start_date).isoformat() != start_date
            or date.fromisoformat(end_date).isoformat() != end_date or start_date > end_date):
        raise ValueError('paired_replay_invalid_scope')
    if not isinstance(calendar, (list, tuple)) or not calendar:
        raise ValueError('paired_replay_source_calendar_missing')
    for day in calendar:
        if not isinstance(day, str) or date.fromisoformat(day).isoformat() != day:
            raise ValueError('paired_replay_invalid_calendar_date')
    if list(calendar) != sorted(set(calendar)):
        raise ValueError('paired_replay_calendar_not_strictly_ordered')
    days = [day for day in calendar if start_date <= day <= end_date]
    if not days:
        raise ValueError('paired_replay_empty_calendar')
    initial = _number(initial_capital, 'initial_capital')
    if initial <= 0:
        raise ValueError('paired_replay_nonpositive_initial_capital')
    arms = {}
    for name, metrics in (('champion', champion), ('candidate', candidate)):
        if (field(metrics, 'start_date') != start_date or field(metrics, 'end_date') != end_date
                or _number(field(metrics, 'initial_capital'), name + '.initial') != initial):
            raise ValueError('paired_replay_arm_scope_mismatch:' + name)
        curve = field(metrics, 'equity_curve')
        if not isinstance(curve, (list, tuple)) or len(curve) != len(days):
            raise ValueError('paired_replay_nav_calendar_incomplete:' + name)
        values = []
        for day, point in zip(days, curve):
            if not isinstance(point, (list, tuple)) or len(point) != 2 or point[0] != day:
                raise ValueError('paired_replay_nav_date_mismatch:' + name)
            value = _number(point[1], name + '.' + day)
            if value < 0:
                raise ValueError('paired_replay_negative_nav:' + name + ':' + day)
            if values and values[-1] == 0 and value > 0:
                raise ValueError('paired_replay_unexplained_recapitalization:' + name + ':' + day)
            values.append(value)
        final = _number(field(metrics, 'final_equity'), name + '.final')
        if not math.isclose(final, values[-1], rel_tol=1e-12, abs_tol=1e-8):
            raise ValueError('paired_replay_final_nav_mismatch:' + name)
        total_return = values[-1] / initial - 1
        if not math.isclose(_number(field(metrics, 'total_return'), name + '.total_return'),
                            total_return, rel_tol=1e-10, abs_tol=1e-10):
            raise ValueError('paired_replay_summary_return_mismatch:' + name)
        old = [initial, *values[:-1]]
        arms[name] = {'daily_returns': [new / prior - 1 if prior else None for prior, new in zip(old, values)],
                      'nav': values, 'total_return': total_return}
    count = min(len(days), n_partitions)
    boundaries = [(i * len(days) // count, (i + 1) * len(days) // count) for i in range(count)]
    for arm in arms.values():
        values = arm['nav']
        arm['partition_returns'] = []
        for start, end in boundaries:
            opening = values[start - 1] if start else initial
            arm['partition_returns'].append(values[end - 1] / opening - 1 if opening else None)
    insolvent = [name for name, arm in arms.items() if 0 in arm['nav']]
    return {
        'schema': 'paired-calendar-replay-nav-v1',
        'status': 'terminal_insolvency' if insolvent else 'complete',
        'insolvent_arms': insolvent,
        'evidence_kind': 'historical_replay_diagnostic',
        'prospective': False, 'nav_maturity_credit': 0, 'promotion_allowed': False,
        'dates': days, 'calendar_checksum': digest(days),
        'initial_capital': initial, 'sessions': len(days),
        'partition_dates': [{'start': days[start], 'end': days[end - 1], 'sessions': end - start}
                            for start, end in boundaries],
        'champion': arms['champion'], 'candidate': arms['candidate'],
        'daily_net_return_delta': [c - b if b is not None and c is not None else None
                                  for b, c in zip(arms['champion']['daily_returns'],
                                                        arms['candidate']['daily_returns'])],
        'total_return_delta': arms['candidate']['total_return'] - arms['champion']['total_return'],
    }
