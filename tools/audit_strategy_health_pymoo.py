"""Read-only production strategy-health audit using pymoo Pareto ranking.

The audit intentionally ranks observed evidence; it does not tune thresholds,
promote strategies, change weights, or write to D1.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np
from pymoo.util.nds.non_dominated_sorting import NonDominatedSorting


ACTIVE_MIN_HIT_RATE = 0.48
PROMOTION_MIN_HIT_RATE = 0.52
MIN_DECISIONS = 30
MIN_MATCH_RATE = 0.02
MIN_SAMPLES = 30
MIN_MATURE_DATES = 10
MIN_MAX_DRAWDOWN = -0.08
LCB90_Z = 1.281551565545
S12_ID = "stock_tech_s12_multitimeframe_smc_reclaim_v2"
S12_REPLAY_SIGNATURE = (
    "s12_replay_v3:tw_equity_raw_daily_namespace_safe:overlapping_r2_pit:"
    "five_session_price_domain:v2"
)
ROUNDTRIP_COST_BPS = 18


def run_d1(worker_dir: Path, sql: str) -> list[dict[str, Any]]:
    del worker_dir
    config_path = Path(os.environ["APPDATA"]) / "xdg.config" / ".wrangler" / "config" / "default.toml"
    match = re.search(r'^oauth_token\s*=\s*"([^"]+)"', config_path.read_text(encoding="utf-8"), re.MULTILINE)
    if not match:
        raise RuntimeError("wrangler_oauth_token_not_found")
    request = Request(
        "https://api.cloudflare.com/client/v4/accounts/619a83ac9f20847d9e2f2920823b727d/d1/database/6401a5f6-5767-4fa8-a1a7-ec8d4739ac79/query",
        data=json.dumps({"sql": sql, "params": []}).encode("utf-8"),
        headers={"Authorization": f"Bearer {match.group(1)}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=60) as response:
            payload = json.load(response)
    except HTTPError as cause:
        body = cause.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"d1_http_failed:{cause.code}:{body[-2000:]}") from cause
    if payload.get("success") is not True or not payload.get("result"):
        raise RuntimeError(f"d1_query_failed:{payload}")
    result = payload["result"][0]
    if result.get("success") is not True:
        raise RuntimeError(f"d1_statement_failed:{result}")
    return list(result.get("results") or [])


def round6(value: float | None) -> float | None:
    return None if value is None or not math.isfinite(value) else round(value, 6)


def max_drawdown(values: list[float]) -> float | None:
    if not values:
        return None
    equity = 1.0
    peak = 1.0
    drawdown = 0.0
    for value in values:
        equity *= max(0.0, 1.0 + value)
        peak = max(peak, equity)
        drawdown = min(drawdown, equity / peak - 1.0 if peak > 0 else -1.0)
    return round6(drawdown)


def lcb90(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    mean = statistics.fmean(values)
    standard_error = statistics.stdev(values) / math.sqrt(len(values))
    return round6(mean - LCB90_Z * standard_error)


def finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def gate_failures(row: dict[str, Any]) -> tuple[list[str], list[str]]:
    evidence: list[str] = []
    economics: list[str] = []
    status = row["status"]
    if row["evaluable_decisions"] < MIN_DECISIONS:
        evidence.append("evaluable_decisions_lt_30")
    if row["match_rate"] is None or row["match_rate"] < MIN_MATCH_RATE:
        evidence.append("match_rate_lt_0.02")
    if row["samples"] < MIN_SAMPLES:
        evidence.append("samples_lt_30")
    if row["mature_dates"] < MIN_MATURE_DATES:
        evidence.append("mature_dates_lt_10")
    for field in ("hit_rate", "avg_return", "max_drawdown", "date_return_lcb90"):
        if row[field] is None:
            evidence.append(f"{field}_missing")
    hit_floor = ACTIVE_MIN_HIT_RATE if status == "active" else PROMOTION_MIN_HIT_RATE
    if row["hit_rate"] is not None and row["hit_rate"] < hit_floor:
        economics.append(f"hit_rate_lt_{hit_floor}")
    if row["avg_return"] is not None and row["avg_return"] <= 0:
        economics.append("avg_return_not_positive")
    if row["max_drawdown"] is not None and row["max_drawdown"] < MIN_MAX_DRAWDOWN:
        economics.append("max_drawdown_lt_-0.08")
    if row["date_return_lcb90"] is not None and row["date_return_lcb90"] <= 0:
        economics.append("date_return_lcb90_not_positive")
    return evidence, economics


def max_return_correlation(
    strategy_id: str,
    returns_by_strategy: dict[str, dict[str, float]],
) -> tuple[float | None, str | None, int]:
    own = returns_by_strategy.get(strategy_id, {})
    best: tuple[float, str, int] | None = None
    for other_id, other in returns_by_strategy.items():
        if other_id == strategy_id:
            continue
        dates = sorted(set(own).intersection(other))
        if len(dates) < 5:
            continue
        left = np.asarray([own[date] for date in dates], dtype=float)
        right = np.asarray([other[date] for date in dates], dtype=float)
        if np.std(left) == 0 or np.std(right) == 0:
            continue
        correlation = float(np.corrcoef(left, right)[0, 1])
        if not math.isfinite(correlation):
            continue
        candidate = (abs(correlation), other_id, len(dates))
        if best is None or candidate[0] > best[0]:
            best = candidate
    return (round6(best[0]), best[1], best[2]) if best else (None, None, 0)


def audit(repo: Path, as_of_date: str) -> dict[str, Any]:
    worker_dir = repo / "worker"
    specs = run_d1(
        worker_dir,
        """
        SELECT strategy_id, version, name, status, alpha_bucket, promotion_status
          FROM strategy_spec_registry
         WHERE status IN ('active','candidate','shadow','research')
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'candidate' THEN 1
                              WHEN 'shadow' THEN 2 ELSE 3 END,
                  strategy_id
        """,
    )
    daily = run_d1(
        worker_dir,
        f"""
        SELECT date, strategy_id, strategy_version, decisions, evaluable_decisions,
               unavailable_decisions, matched, reward_samples, reward_hits,
               reward_sum, date_portfolio_return, decision_contract_version,
               reward_contract_version
          FROM strategy_learning_daily_stats
         WHERE date >= (
           SELECT MIN(date) FROM (
             SELECT DISTINCT date FROM strategy_learning_daily_stats
              WHERE date <= '{as_of_date}' ORDER BY date DESC LIMIT 60
           )
         )
           AND date <= '{as_of_date}'
         ORDER BY date, strategy_id, strategy_version
        """,
    )
    s12_daily = run_d1(
        worker_dir,
        f"""
        SELECT o.signal_date AS date,
               COUNT(*) AS samples,
               SUM(CASE WHEN CAST(o.pnl_pct AS REAL) - ({ROUNDTRIP_COST_BPS} / 10000.0) > 0
                        THEN 1 ELSE 0 END) AS hits,
               SUM(CAST(o.pnl_pct AS REAL) - ({ROUNDTRIP_COST_BPS} / 10000.0)) AS reward_sum,
               AVG(CAST(o.pnl_pct AS REAL) - ({ROUNDTRIP_COST_BPS} / 10000.0)) AS date_return
          FROM s12_replay_trade_outcomes o
         WHERE o.signal_date IS NOT NULL
           AND date(o.signal_date) <= date('{as_of_date}')
           AND o.sample_eligible=1
           AND o.source='s12_multisession_structure_replay_v3'
           AND o.pnl_pct IS NOT NULL
           AND json_extract(o.detail_json, '$.schema_version')='s12-replay-trade-outcome-v3'
           AND json_extract(o.detail_json, '$.observation_kind')='executed'
           AND json_extract(o.detail_json, '$.replay_diagnostics.replay_engine_signature')='{S12_REPLAY_SIGNATURE}'
           AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date('{as_of_date}')
         GROUP BY o.signal_date
         ORDER BY o.signal_date
        """,
    )

    by_strategy: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in daily:
        by_strategy[str(row["strategy_id"])].append(row)
    returns_by_strategy: dict[str, dict[str, float]] = defaultdict(dict)
    rows: list[dict[str, Any]] = []
    for spec in specs:
        strategy_id = str(spec["strategy_id"])
        observed = by_strategy.get(strategy_id, [])
        decisions = [r for r in observed if r.get("decision_contract_version") == "strategy-evaluation-v2"]
        rewards = [
            r for r in observed
            if r.get("reward_contract_version") == "selection-reference-snapshot-v3"
            and int(r.get("reward_samples") or 0) > 0
        ]
        evaluable = sum(int(r.get("evaluable_decisions") or 0) for r in decisions)
        matched = sum(int(r.get("matched") or 0) for r in decisions)
        samples = sum(int(r.get("reward_samples") or 0) for r in rewards)
        hits = sum(int(r.get("reward_hits") or 0) for r in rewards)
        reward_sum = sum(float(r.get("reward_sum") or 0) for r in rewards)
        date_returns = [finite(r.get("date_portfolio_return")) for r in rewards]
        date_returns = [value for value in date_returns if value is not None]
        for reward in rewards:
            value = finite(reward.get("date_portfolio_return"))
            if value is not None:
                returns_by_strategy[strategy_id][str(reward["date"])] = value
        if strategy_id == S12_ID:
            s12_returns = [finite(r.get("date_return")) for r in s12_daily]
            date_returns = [value for value in s12_returns if value is not None]
            samples = sum(int(r.get("samples") or 0) for r in s12_daily)
            hits = sum(int(r.get("hits") or 0) for r in s12_daily)
            reward_sum = sum(float(r.get("reward_sum") or 0) for r in s12_daily)
            returns_by_strategy[strategy_id] = {
                str(row["date"]): float(row["date_return"])
                for row in s12_daily
                if finite(row.get("date_return")) is not None
            }
        row = {
            "strategy_id": strategy_id,
            "version": spec["version"],
            "name": spec["name"],
            "status": spec["status"],
            "alpha_bucket": spec["alpha_bucket"],
            "decisions": sum(int(r.get("decisions") or 0) for r in decisions),
            "evaluable_decisions": evaluable,
            "unavailable_decisions": sum(int(r.get("unavailable_decisions") or 0) for r in decisions),
            "matched": matched,
            "match_rate": round6(matched / evaluable) if evaluable else None,
            "samples": samples,
            "hit_rate": round6(hits / samples) if samples else None,
            "avg_return": round6(reward_sum / samples) if samples else None,
            "max_drawdown": max_drawdown(date_returns),
            "mature_dates": len(date_returns),
            "date_return_lcb90": lcb90(date_returns),
            "reward_owner": "s12_execution_replay_v3_net" if strategy_id == S12_ID else "selection_edge_v4",
        }
        rows.append(row)

    for row in rows:
        correlation, peer, overlap = max_return_correlation(row["strategy_id"], returns_by_strategy)
        row["max_abs_return_correlation"] = correlation
        row["most_correlated_peer"] = peer
        row["correlation_overlap_dates"] = overlap
        evidence_failures, economic_failures = gate_failures(row)
        row["evidence_failures"] = evidence_failures
        row["economic_failures"] = economic_failures
        row["gate_class"] = (
            "pass" if not evidence_failures and not economic_failures
            else "evidence_repair" if evidence_failures and not economic_failures
            else "economic_repair" if economic_failures and not evidence_failures
            else "evidence_and_economic_repair"
        )

    complete = [
        row for row in rows
        if all(row[field] is not None for field in (
            "hit_rate", "avg_return", "max_drawdown", "date_return_lcb90"
        ))
    ]
    if complete:
        objectives = np.asarray([
            [
                -float(row["date_return_lcb90"]),
                -float(row["avg_return"]),
                -float(row["hit_rate"]),
                abs(min(float(row["max_drawdown"]), 0.0)),
                -math.log1p(int(row["samples"])),
                float(row["max_abs_return_correlation"] or 0.0),
            ]
            for row in complete
        ])
        fronts = NonDominatedSorting().do(objectives)
        for rank, front in enumerate(fronts, start=1):
            for index in front:
                complete[int(index)]["pymoo_pareto_rank"] = rank
    for row in rows:
        row.setdefault("pymoo_pareto_rank", None)

    rows.sort(key=lambda row: (
        row["pymoo_pareto_rank"] is None,
        row["pymoo_pareto_rank"] or 999,
        0 if row["status"] == "active" else 1,
        row["strategy_id"],
    ))
    return {
        "schema_version": "stockvision-strategy-health-pymoo-audit-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "as_of_date": as_of_date,
        "source": "production D1 read-only; strategy_learning_daily_stats rolling <=60 sessions",
        "pymoo_version": __import__("pymoo").__version__,
        "method": {
            "algorithm": "pymoo NonDominatedSorting",
            "objectives_minimized": [
                "negative_date_return_lcb90",
                "negative_avg_cost_net_return",
                "negative_hit_rate",
                "max_drawdown_magnitude",
                "negative_log1p_samples",
                "max_absolute_return_correlation",
            ],
            "guardrail": "diagnostic_only_no_threshold_tuning_no_promotion_no_weight_change",
        },
        "thresholds": {
            "active_retention_min_hit_rate": ACTIVE_MIN_HIT_RATE,
            "promotion_min_hit_rate": PROMOTION_MIN_HIT_RATE,
            "min_evaluable_decisions": MIN_DECISIONS,
            "min_match_rate": MIN_MATCH_RATE,
            "min_samples": MIN_SAMPLES,
            "min_mature_dates": MIN_MATURE_DATES,
            "min_max_drawdown": MIN_MAX_DRAWDOWN,
            "min_avg_return_exclusive": 0,
            "min_date_return_lcb90_exclusive": 0,
        },
        "strategies": rows,
    }


def markdown(report: dict[str, Any]) -> str:
    rows = report["strategies"]
    failed = [row for row in rows if row["gate_class"] != "pass"]
    lines = [
        "# Production strategy health — pymoo audit",
        "",
        f"- As of: `{report['as_of_date']}`",
        f"- pymoo: `{report['pymoo_version']}`",
        "- Scope: active, candidate, shadow, research; read-only diagnostic.",
        "- Guardrail: no threshold relaxation, promotion, weight change, or retraining.",
        "",
        "| Strategy | Status | Class | Pareto | Samples | Hit | Avg net | MDD | Dates | LCB90 | Max |corr| |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        fmt = lambda value: "—" if value is None else f"{float(value):.4f}"
        lines.append(
            f"| `{row['strategy_id']}` | {row['status']} | {row['gate_class']} | "
            f"{row['pymoo_pareto_rank'] or '—'} | {row['samples']} | {fmt(row['hit_rate'])} | "
            f"{fmt(row['avg_return'])} | {fmt(row['max_drawdown'])} | {row['mature_dates']} | "
            f"{fmt(row['date_return_lcb90'])} | {fmt(row['max_abs_return_correlation'])} |"
        )
    lines.extend(["", "## Failed strategies", ""])
    for row in failed:
        reasons = row["evidence_failures"] + row["economic_failures"]
        lines.append(f"- `{row['strategy_id']}` ({row['status']}): {', '.join(reasons)}")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--as-of-date", default="2026-08-16")
    parser.add_argument("--output-dir", type=Path, default=None)
    args = parser.parse_args()
    output_dir = args.output_dir or args.repo / "audits" / "strategy-health" / f"PYMOO-{args.as_of_date.replace('-', '')}"
    output_dir.mkdir(parents=True, exist_ok=True)
    report = audit(args.repo.resolve(), args.as_of_date)
    (output_dir / "pymoo-strategy-health.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "pymoo-strategy-health.md").write_text(markdown(report), encoding="utf-8")
    print(json.dumps({
        "output_dir": str(output_dir.resolve()),
        "strategies": len(report["strategies"]),
        "passing": sum(row["gate_class"] == "pass" for row in report["strategies"]),
        "failed": sum(row["gate_class"] != "pass" for row in report["strategies"]),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
