"""
weekly_audit_graph.py — Weekly AI Audit Report (P2#16)

Friday post-close pipeline:
  1. Read L1 (trade performance), L2 (decision logs), L3 (model health)
  2. Compute diagnosis: which factors contributed most to wins/losses
  3. Compare current params vs Optuna optimal
  4. LLM writes human-readable report
  5. Return report (Worker pushes to Discord + archives to D1)
"""
import json
import logging
import os
import statistics
from datetime import datetime, timezone, timedelta
from typing import Any

import httpx

from services.model_pool_health import read_model_pool_health_rows

logger = logging.getLogger(__name__)

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID", "")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
D1_API = (
    f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
    f"/d1/database/{CF_D1_DB_ID}/query"
)

SCORE_V2_COMPONENTS = (
    ("mlEdge", "ML Edge"),
    ("chipFlow", "Chip Flow"),
    ("technicalStructure", "Technical Structure"),
    ("fundamentalQuality", "Fundamental Quality"),
    ("newsTheme", "News/Theme"),
)


def _float_or_none(value: Any) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n else None


def _clamp_pct(value: float | None) -> float:
    if value is None:
        return 0.0
    return max(0.0, min(1.0, value))


def _json_record(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _score_v2_payload(value: Any) -> dict[str, Any] | None:
    payload = _json_record(value)
    if not payload or payload.get("version") != "score_v2":
        return None
    components = payload.get("components")
    return payload if isinstance(components, dict) else None


def _component_contributions(row: dict[str, Any]) -> tuple[dict[str, float], bool]:
    payload = _score_v2_payload(row.get("score_components"))
    if payload:
        components = payload.get("components") or {}
        total = _float_or_none(payload.get("total"))
        if not total or total <= 0:
            total = sum(_float_or_none(components.get(key)) or 0.0 for key, _ in SCORE_V2_COMPONENTS)
        return {
            key: _clamp_pct(((_float_or_none(components.get(key)) or 0.0) / total) if total and total > 0 else 0.0)
            for key, _ in SCORE_V2_COMPONENTS
        }, True

    total_score = _float_or_none(row.get("total_score"))

    def legacy_pct(pct_key: str, score_key: str) -> float:
        pct_value = _float_or_none(row.get(pct_key))
        if pct_value is not None:
            return _clamp_pct(pct_value)
        score = _float_or_none(row.get(score_key))
        if score is None or not total_score or total_score <= 0:
            return 0.0
        return _clamp_pct(score / total_score)

    return {
        "mlEdge": legacy_pct("ml_pct", "ml_score"),
        "chipFlow": legacy_pct("chip_pct", "chip_score"),
        "technicalStructure": legacy_pct("tech_pct", "tech_score"),
        "fundamentalQuality": 0.0,
        "newsTheme": 0.0,
    }, False


async def _d1_query(client: httpx.AsyncClient, sql: str, params: list = None) -> list[dict]:
    if not CF_API_TOKEN:
        return []
    body = {"sql": sql}
    if params:
        body["params"] = params
    resp = await client.post(
        D1_API, json=body,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
        timeout=30.0,
    )
    if resp.status_code != 200:
        return []
    data = resp.json()
    if not data.get("success"):
        return []
    results = data.get("result", [])
    if results and isinstance(results, list) and "results" in results[0]:
        return results[0]["results"]
    return []


async def _d1_exec(client: httpx.AsyncClient, sql: str, params: list = None) -> bool:
    if not CF_API_TOKEN:
        return False
    body = {"sql": sql}
    if params:
        body["params"] = params
    resp = await client.post(
        D1_API, json=body,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
        timeout=30.0,
    )
    return resp.status_code == 200 and resp.json().get("success", False)


async def generate_weekly_audit() -> dict:
    """
    Generate weekly AI audit report from L1/L2/L3 data.
    Returns structured report dict with sections.
    """
    if not CF_API_TOKEN:
        return {"error": "CF_API_TOKEN not set", "status": "failed"}

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")

    async with httpx.AsyncClient() as client:
        # ── L1: Trade Performance (7-day) ──
        snapshots = await _d1_query(client, """
            SELECT date, total_value, pnl_pct, max_drawdown_to_date,
                   sharpe_30d, sortino_30d, calmar, cagr
            FROM paper_daily_snapshots
            WHERE account_id = 1 AND date >= ?
            ORDER BY date ASC
        """, [week_ago])

        orders = await _d1_query(client, """
            SELECT side, symbol, price, shares, note, created_at
            FROM paper_orders
            WHERE account_id = 1 AND created_at >= ?
            ORDER BY created_at
        """, [week_ago])

        buys = [o for o in orders if o["side"] == "buy"]
        sells = [o for o in orders if o["side"] == "sell"]

        # Weekly return
        weekly_return = None
        if len(snapshots) >= 2:
            start_val = snapshots[0].get("total_value", 0)
            end_val = snapshots[-1].get("total_value", 0)
            if start_val > 0:
                weekly_return = (end_val - start_val) / start_val

        l1 = {
            "period": f"{week_ago} ~ {today}",
            "weekly_return": f"{weekly_return:.2%}" if weekly_return is not None else "N/A",
            "total_buys": len(buys),
            "total_sells": len(sells),
            "latest_mdd": snapshots[-1].get("max_drawdown_to_date") if snapshots else None,
            "latest_sharpe": snapshots[-1].get("sharpe_30d") if snapshots else None,
            "latest_sortino": snapshots[-1].get("sortino_30d") if snapshots else None,
            "latest_calmar": snapshots[-1].get("calmar") if snapshots else None,
            "latest_cagr": snapshots[-1].get("cagr") if snapshots else None,
        }

        # ── L2: Decision Attribution (7-day) ──
        decisions = await _d1_query(client, """
            SELECT symbol, action, score_components, chip_score, tech_score, ml_score, total_score,
                   chip_pct, tech_pct, ml_pct, debate_verdict, ml_signal, ml_confidence
            FROM decision_logs
            WHERE date >= ? ORDER BY date
        """, [week_ago])

        # Aggregate Score V2 factor contributions. Historical rows without
        # score_components are read as a storage projection only.
        contribution_rows = [_component_contributions(d) for d in decisions]
        score_v2_payload_count = sum(1 for _, is_score_v2 in contribution_rows if is_score_v2)
        avg_contribution = {key: 0.0 for key, _ in SCORE_V2_COMPONENTS}
        if decisions:
            avg_contribution = {
                key: statistics.mean(row[key] for row, _ in contribution_rows)
                for key, _ in SCORE_V2_COMPONENTS
            }
        factor_attribution = [
            {
                "name": label,
                "avg_pct": round(avg_contribution[key] * 100, 1),
            }
            for key, label in SCORE_V2_COMPONENTS
        ]

        debate_counts = {"APPROVE": 0, "DOWNGRADE": 0, "REJECT": 0}
        for d in decisions:
            v = d.get("debate_verdict")
            if v in debate_counts:
                debate_counts[v] += 1

        l2 = {
            "total_decisions": len(decisions),
            "score_v2_payloads": f"{score_v2_payload_count}/{len(decisions)}",
            "avg_ml_edge_contribution": f"{avg_contribution['mlEdge']:.0%}",
            "avg_chip_flow_contribution": f"{avg_contribution['chipFlow']:.0%}",
            "avg_technical_structure_contribution": f"{avg_contribution['technicalStructure']:.0%}",
            "avg_fundamental_quality_contribution": f"{avg_contribution['fundamentalQuality']:.0%}",
            "avg_news_theme_contribution": f"{avg_contribution['newsTheme']:.0%}",
            "dominant_factor": max(
                [(label, avg_contribution[key]) for key, label in SCORE_V2_COMPONENTS],
                key=lambda x: x[1]
            )[0] if decisions else "N/A",
            "factor_attribution": factor_attribution,
            "debate_verdicts": debate_counts,
        }

        # ── L3: Model Health (latest) ──
        model_health = read_model_pool_health_rows()

        degraded_models = [m for m in model_health if m.get("lifecycle_status") == "degraded"]
        low_accuracy = [m for m in model_health if (m.get("accuracy_30d") or 0.5) < 0.45]
        high_accuracy = [m for m in model_health if (m.get("accuracy_30d") or 0) > 0.55]

        l3 = {
            "total_models": len(model_health),
            "degraded": [m["model_name"] for m in degraded_models],
            "low_accuracy": [f"{m['model_name']}({m.get('accuracy_30d', 0):.1%})" for m in low_accuracy],
            "high_accuracy": [f"{m['model_name']}({m.get('accuracy_30d', 0):.1%})" for m in high_accuracy],
            "models": [
                {
                    "name": m["model_name"],
                    "acc_30d": m.get("accuracy_30d"),
                    "pf": m.get("profit_factor"),
                    "status": m.get("lifecycle_status", "active"),
                }
                for m in model_health
            ],
        }

        # ── MC + PBO latest ──
        mc = await _d1_query(client, """
            SELECT mdd_95th, go_live_verdict FROM monte_carlo_results
            ORDER BY run_date DESC LIMIT 1
        """)
        pbo = await _d1_query(client, """
            SELECT pbo, go_live_verdict FROM pbo_results
            ORDER BY run_date DESC LIMIT 1
        """)

        risk_assessment = {
            "mc_mdd_95th": mc[0].get("mdd_95th") if mc else None,
            "mc_verdict": mc[0].get("go_live_verdict") if mc else None,
            "pbo": pbo[0].get("pbo") if pbo else None,
            "pbo_verdict": pbo[0].get("go_live_verdict") if pbo else None,
        }

        # ── Build report text ──
        report_sections = []

        # Section 1: Performance
        perf_parts = [
            f"## 📊 Weekly Performance ({l1['period']})",
            f"- Return: **{l1['weekly_return']}**",
            f"- Trades: {l1['total_buys']} buys, {l1['total_sells']} sells",
        ]
        metrics = []
        if l1.get('latest_sharpe'):
            metrics.append(f"Sharpe: {l1['latest_sharpe']:.2f}")
        if l1.get('latest_sortino'):
            metrics.append(f"Sortino: {l1['latest_sortino']:.2f}")
        if l1.get('latest_mdd'):
            metrics.append(f"MDD: {l1['latest_mdd']:.1%}")
        if metrics:
            perf_parts.append(f"- {' | '.join(metrics)}")
        report_sections.append("\n".join(perf_parts))

        # Section 2: Decision Attribution
        report_sections.append(
            f"\n## 🎯 Decision Attribution\n"
            f"- {l2['total_decisions']} buy decisions this week\n"
            f"- Score V2 payload coverage: {l2['score_v2_payloads']}\n"
            f"- Dominant Score V2 factor: **{l2['dominant_factor']}**\n"
            f"- Avg contribution: ML Edge {l2['avg_ml_edge_contribution']} | "
            f"Chip Flow {l2['avg_chip_flow_contribution']} | "
            f"Technical Structure {l2['avg_technical_structure_contribution']} | "
            f"Fundamental Quality {l2['avg_fundamental_quality_contribution']} | "
            f"News/Theme {l2['avg_news_theme_contribution']}\n"
            f"- Debate: {debate_counts['APPROVE']} approve, "
            f"{debate_counts['DOWNGRADE']} downgrade, {debate_counts['REJECT']} reject"
        )

        # Section 3: Model Health
        report_sections.append(
            f"\n## 🤖 Model Health\n"
            f"- Active: {l3['total_models'] - len(l3['degraded'])} / {l3['total_models']}\n"
            + (f"- ⚠️ Degraded: {', '.join(l3['degraded'])}\n" if l3['degraded'] else "")
            + (f"- 🔴 Low accuracy: {', '.join(l3['low_accuracy'])}\n" if l3['low_accuracy'] else "")
            + (f"- 🟢 High accuracy: {', '.join(l3['high_accuracy'])}\n" if l3['high_accuracy'] else "")
        )

        # Section 4: Risk Assessment
        mc_str = f"MC 95th MDD: {risk_assessment['mc_mdd_95th']:.1%} ({risk_assessment['mc_verdict']})" if risk_assessment.get("mc_mdd_95th") else "MC: N/A"
        pbo_str = f"PBO: {risk_assessment['pbo']:.1%} ({risk_assessment['pbo_verdict']})" if risk_assessment.get("pbo") else "PBO: N/A"
        report_sections.append(
            f"\n## 🛡️ Risk Assessment\n"
            f"- {mc_str}\n"
            f"- {pbo_str}"
        )

        full_report = "\n".join(report_sections)

        # ── Archive to D1 ──
        await _d1_exec(client, """
            INSERT OR REPLACE INTO weekly_audit_reports
            (report_date, report_text, l1_json, l2_json, l3_json, risk_json)
            VALUES (?, ?, ?, ?, ?, ?)
        """, [
            today, full_report,
            json.dumps(l1, ensure_ascii=False),
            json.dumps(l2, ensure_ascii=False),
            json.dumps(l3, ensure_ascii=False),
            json.dumps(risk_assessment, ensure_ascii=False),
        ])

        return {
            "status": "success",
            "report_date": today,
            "report": full_report,
            "l1": l1,
            "l2": l2,
            "l3": l3,
            "risk": risk_assessment,
        }
