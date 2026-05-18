"""
obsidian_writer.py — Auto-generate Obsidian notes and push to GitHub

Trigger:
  1. Daily post-verify chain after TW 22:00 root → Daily + Trade + Pipeline notes
  2. Weekly Friday 22:30 TW (after audit) → Weekly review note
  3. Manual POST /obsidian/daily or /obsidian/weekly

Flow: D1 query → Jinja2 template → GitHub Git Trees API batch push
"""

import os
import json
import base64
import logging
from datetime import datetime, timezone, timedelta

import httpx
from jinja2 import Environment, FileSystemLoader

from services.model_pool_health import read_model_pool_health_rows

logger = logging.getLogger("obsidian")

# ── Config ────────────────────────────────────────────────────────────────────

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip()
CF_D1_DB_ID   = os.environ.get("CF_D1_DB_ID", "").strip()
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN",   "")
GITHUB_TOKEN  = os.environ.get("GITHUB_TOKEN",   "")
GITHUB_REPO_VAULT = os.environ.get("GITHUB_REPO_VAULT", "")  # e.g. "AngusRepo/stockvision-brain"
GITHUB_REPO_MAIN  = os.environ.get("GITHUB_REPO_MAIN",  "")  # e.g. "AngusRepo/stock-analyzer"

D1_API = (
    f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_DB_ID}/query"
    if CF_ACCOUNT_ID and CF_D1_DB_ID
    else ""
)
GITHUB_API = "https://api.github.com"

TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "templates")

TW_TZ = timezone(timedelta(hours=8))


def _today_tw() -> str:
    return datetime.now(TW_TZ).strftime("%Y-%m-%d")


def _now_tw() -> str:
    return datetime.now(TW_TZ).strftime("%Y-%m-%d %H:%M:%S")


# ── Jinja2 Setup ─────────────────────────────────────────────────────────────

_jinja_env = Environment(
    loader=FileSystemLoader(TEMPLATES_DIR),
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
)


def _render(template_name: str, **kwargs) -> str:
    tpl = _jinja_env.get_template(template_name)
    return tpl.render(**kwargs)


# ── D1 Helpers (same pattern as backtest_service.py) ─────────────────────────

async def _d1_query(client: httpx.AsyncClient, sql: str, params: list = None) -> list[dict]:
    if not (CF_API_TOKEN and D1_API):
        return []
    body: dict = {"sql": sql}
    if params:
        body["params"] = params
    try:
        resp = await client.post(
            D1_API, json=body,
            headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
            timeout=30.0,
        )
        if resp.status_code != 200:
            logger.warning(f"D1 query failed: {resp.status_code}")
            return []
        data = resp.json()
        if not data.get("success"):
            return []
        results = data.get("result", [])
        if results and isinstance(results, list) and "results" in results[0]:
            return results[0]["results"]
    except Exception as e:
        logger.warning(f"D1 query error: {e}")
    return []


# ── GitHub Git Trees API ─────────────────────────────────────────────────────

async def _push_to_github(
    client: httpx.AsyncClient,
    repo: str,
    files: list[dict],  # [{"path": "Daily/2026-04-07.md", "content": "..."}]
    message: str,
) -> bool:
    """Batch commit multiple files using Git Trees API."""
    if not GITHUB_TOKEN or not repo:
        logger.warning("GITHUB_TOKEN or repo not set, skipping push")
        return False

    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    }
    base_url = f"{GITHUB_API}/repos/{repo}"

    try:
        # 1. Get latest commit SHA
        ref_resp = await client.get(f"{base_url}/git/ref/heads/main", headers=headers, timeout=15)
        if ref_resp.status_code != 200:
            logger.error(f"GitHub get ref failed: {ref_resp.status_code} {ref_resp.text[:200]}")
            return False
        latest_sha = ref_resp.json()["object"]["sha"]

        # 1b. Get the tree SHA from the commit (Trees API needs tree SHA, not commit SHA)
        commit_resp = await client.get(f"{base_url}/git/commits/{latest_sha}", headers=headers, timeout=15)
        if commit_resp.status_code != 200:
            logger.error(f"GitHub get commit failed: {commit_resp.status_code} {commit_resp.text[:200]}")
            return False
        base_tree_sha = commit_resp.json()["tree"]["sha"]

        # 2. Create tree with all files
        tree_items = []
        for f in files:
            tree_items.append({
                "path": f["path"],
                "mode": "100644",
                "type": "blob",
                "content": f["content"],
            })

        tree_resp = await client.post(
            f"{base_url}/git/trees",
            headers=headers, timeout=30,
            json={"base_tree": base_tree_sha, "tree": tree_items},
        )
        if tree_resp.status_code not in (200, 201):
            logger.error(f"GitHub create tree failed: {tree_resp.status_code} {tree_resp.text[:200]}")
            return False
        tree_sha = tree_resp.json()["sha"]

        # 3. Create commit
        commit_resp = await client.post(
            f"{base_url}/git/commits",
            headers=headers, timeout=15,
            json={"message": message, "tree": tree_sha, "parents": [latest_sha]},
        )
        if commit_resp.status_code not in (200, 201):
            logger.error(f"GitHub create commit failed: {commit_resp.status_code}")
            return False
        commit_sha = commit_resp.json()["sha"]

        # 4. Update ref
        update_resp = await client.patch(
            f"{base_url}/git/refs/heads/main",
            headers=headers, timeout=15,
            json={"sha": commit_sha},
        )
        if update_resp.status_code != 200:
            logger.error(f"GitHub update ref failed: {update_resp.status_code}")
            return False

        logger.info(f"Pushed {len(files)} files to {repo} ({commit_sha[:7]})")
        return True

    except Exception as e:
        logger.error(f"GitHub push error: {e}")
        return False


# ── ObsidianWriter ───────────────────────────────────────────────────────────

class ObsidianWriter:

    async def generate_daily(self, date: str = None) -> dict:
        """Generate Daily + Trade + Pipeline notes, push to GitHub, sync progress.md."""
        date = date or _today_tw()
        logger.info(f"[Obsidian] Generating daily notes for {date}")

        async with httpx.AsyncClient() as client:
            # ── Fetch all data from D1 ──
            risk = (await _d1_query(client, "SELECT * FROM market_risk ORDER BY date DESC LIMIT 1")) or [{}]
            risk = risk[0] if risk else {}

            recommendations = await _d1_query(client,
                "SELECT * FROM daily_recommendations WHERE date=? ORDER BY score DESC", [date])

            snapshot = (await _d1_query(client,
                "SELECT * FROM paper_daily_snapshots WHERE account_id=1 AND date=? LIMIT 1", [date])) or [{}]
            snapshot = snapshot[0] if snapshot else {}

            orders = await _d1_query(client,
                "SELECT * FROM paper_orders WHERE account_id=1 AND DATE(created_at, '+8 hours')=? ORDER BY created_at", [date])

            positions = await _d1_query(client,
                "SELECT symbol, name, shares, avg_cost, entry_price, current_price, "
                "unrealized_pnl, unrealized_pnl_pct FROM paper_positions WHERE account_id=1")

            decisions = await _d1_query(client,
                "SELECT * FROM decision_logs WHERE date=? ORDER BY total_score DESC", [date])

            # T2 pending buys (may not exist yet if morning hasn't run)
            t2_buys = await _d1_query(client,
                "SELECT * FROM paper_orders WHERE account_id=1 AND side='buy' AND DATE(created_at, '+8 hours')=? AND source='auto_ml'", [date])

            # ── Generate Daily note ──
            daily_content = _render("daily.md.j2",
                date=date,
                risk=risk,
                recommendations=recommendations,
                snapshot=snapshot,
                orders=orders,
                positions=positions,
                t2_buys=t2_buys,
                generated_at=_now_tw(),
            )

            files = [{"path": f"Daily/{date}.md", "content": daily_content}]

            # ── Generate Trade notes ──
            decision_map = {d.get("symbol", ""): d for d in decisions}
            for order in orders:
                sym = order.get("symbol", "")
                decision = decision_map.get(sym, {})
                side = order.get("side", "buy")

                # For sells, calculate hold days and P&L
                hold_days = 0
                realized_pnl = 0
                realized_pnl_pct = 0
                exit_reason = ""
                if side == "sell":
                    try:
                        note = json.loads(order.get("note", "{}")) if isinstance(order.get("note"), str) else (order.get("note") or {})
                        hold_days = note.get("hold_days", 0)
                        entry_price = note.get("entry_price", order.get("price", 0))
                        realized_pnl = (order["price"] - entry_price) * order.get("shares", 0)
                        realized_pnl_pct = ((order["price"] - entry_price) / entry_price * 100) if entry_price > 0 else 0
                        exit_reason = note.get("exit_reason", "")
                    except (json.JSONDecodeError, TypeError):
                        pass

                trade_content = _render("trade.md.j2",
                    date=date,
                    order=order,
                    decision=decision,
                    hold_days=hold_days,
                    realized_pnl=realized_pnl,
                    realized_pnl_pct=realized_pnl_pct,
                    exit_reason=exit_reason,
                )
                files.append({
                    "path": f"Trades/{side.upper()}-{sym}-{date}.md",
                    "content": trade_content,
                })

            # ── Generate Pipeline note ──
            pipeline_content = _render("pipeline.md.j2",
                date=date,
                recommendations=recommendations,
                t2_buys=t2_buys,
            )
            files.append({"path": f"Pipeline/{date}.md", "content": pipeline_content})

            # ── Push to Obsidian vault ──
            vault_ok = await _push_to_github(client, GITHUB_REPO_VAULT, files, f"auto: daily {date}")

            # ── Sync progress.md ──
            progress_ok = await self._sync_progress(client, date, risk, snapshot, recommendations, positions, orders, t2_buys)

            return {
                "status": "ok",
                "date": date,
                "files_generated": len(files),
                "vault_pushed": vault_ok,
                "progress_synced": progress_ok,
                "details": [f["path"] for f in files],
            }

    async def generate_weekly(self, date: str = None) -> dict:
        """Generate Weekly Review note from audit data."""
        date = date or _today_tw()
        logger.info(f"[Obsidian] Generating weekly review for {date}")

        async with httpx.AsyncClient() as client:
            # Find the audit report for this week
            audit = (await _d1_query(client,
                "SELECT * FROM weekly_audit_reports ORDER BY date DESC LIMIT 1")) or [{}]
            audit = audit[0] if audit else {}

            # Parse JSON fields
            def safe_json(s):
                if not s:
                    return {}
                try:
                    return json.loads(s) if isinstance(s, str) else s
                except (json.JSONDecodeError, TypeError):
                    return {}

            l1 = safe_json(audit.get("l1_performance"))
            l2 = safe_json(audit.get("l2_decisions"))
            l3 = safe_json(audit.get("l3_model_health"))

            # Get week dates
            dt = datetime.strptime(date, "%Y-%m-%d")
            week_start = (dt - timedelta(days=dt.weekday())).strftime("%Y-%m-%d")
            week_end = (dt - timedelta(days=dt.weekday()) + timedelta(days=4)).strftime("%Y-%m-%d")
            week_number = dt.isocalendar()[1]

            # Model health: model_pool.json is the V2 source of truth.
            models = read_model_pool_health_rows()
            degraded = [
                m for m in models
                if m.get("lifecycle_status") in ("degraded", "retired")
                or ((m.get("ic_4w_avg") is not None) and m.get("ic_4w_avg") < 0)
            ]

            # Weekly trades
            trades = await _d1_query(client,
                "SELECT side, symbol, signal, price, shares, created_at FROM paper_orders "
                "WHERE account_id=1 AND DATE(created_at, '+8 hours') >= ? AND DATE(created_at, '+8 hours') <= ? ORDER BY created_at",
                [week_start, week_end])

            weekly_content = _render("weekly_review.md.j2",
                week_start=week_start,
                week_end=week_end,
                week_number=week_number,
                weekly_return=l1.get("weekly_return", "N/A"),
                buy_count=l1.get("total_buys", 0),
                sell_count=l1.get("total_sells", 0),
                win_rate=l1.get("win_rate", 0),
                profit_factor=l1.get("profit_factor", "N/A"),
                mdd=l1.get("max_drawdown", 0),
                sharpe=l1.get("sharpe_30d", "N/A"),
                sortino=l1.get("sortino_30d", "N/A"),
                calmar=l1.get("calmar", "N/A"),
                bot_week=l1.get("bot_week_return"),
                bm_week=l1.get("benchmark_week_return"),
                bot_month=l1.get("bot_month_return"),
                bm_month=l1.get("benchmark_month_return"),
                trades=[{
                    "date": t.get("created_at", "")[:10],
                    "side": t.get("side", ""),
                    "symbol": t.get("symbol", ""),
                    "signal": t.get("signal", ""),
                    "score": 0,
                    "pnl": "—",
                } for t in trades],
                factor_attribution=l2.get("factor_attribution", []),
                models=models,
                degraded_models=degraded,
                ai_diagnosis=safe_json(audit.get("ai_diagnosis")) if isinstance(audit.get("ai_diagnosis"), str) else audit.get("ai_diagnosis", ""),
            )

            files = [{"path": f"Audits/Weekly/{dt.strftime('%Y')}-W{week_number:02d}.md", "content": weekly_content}]
            vault_ok = await _push_to_github(client, GITHUB_REPO_VAULT, files, f"auto: weekly W{week_number}")

            return {
                "status": "ok",
                "week": f"W{week_number}",
                "vault_pushed": vault_ok,
            }

    async def _sync_progress(
        self, client: httpx.AsyncClient,
        date: str, risk: dict, snapshot: dict,
        recommendations: list, positions: list, orders: list, t2_buys: list,
    ) -> bool:
        """Compress daily data into progress.md and push to main repo."""
        buy_orders = [o for o in orders if o.get("side") == "buy"]
        sell_orders = [o for o in orders if o.get("side") == "sell"]
        ml_buys = [r for r in recommendations if r.get("signal") in ("BUY", "STRONG_BUY")]

        # Get degraded models from the V2 model pool owner.
        degraded_str = "None"
        try:
            models = [
                m for m in read_model_pool_health_rows()
                if m.get("lifecycle_status") in ("degraded", "retired")
                or ((m.get("ic_4w_avg") is not None) and m.get("ic_4w_avg") < 0)
            ]
            if models:
                degraded_str = ", ".join(
                    f"{m['model_name']}(IC={m.get('ic_4w_avg', 'N/A')})"
                    for m in models
                )
        except Exception:
            pass

        total_value = snapshot.get("total_value", 0)
        initial_cash = 1_000_000  # default
        total_return = ((total_value - initial_cash) / initial_cash * 100) if total_value > 0 and initial_cash > 0 else 0

        progress_content = _render("progress.md.j2",
            date=date,
            total_value=total_value,
            total_return=total_return,
            cash=snapshot.get("cash", 0),
            positions_count=len(positions),
            positions=positions,
            mdd=(snapshot.get("max_drawdown_to_date", 0) or 0) * 100,
            sharpe=snapshot.get("sharpe_30d", "N/A"),
            screener_count=len(recommendations),
            ml_buy_count=len(ml_buys),
            t2_count=len(t2_buys),
            buy_count=len(buy_orders),
            sell_count=len(sell_orders),
            degraded_models=degraded_str,
            optuna_version="latest",
            worker_version="latest",
            action_items=[],
        )

        files = [{"path": "progress.md", "content": progress_content}]

        # Push to main repo (stockvision-cloudflare-v12)
        main_ok = False
        if GITHUB_REPO_MAIN:
            main_ok = await _push_to_github(client, GITHUB_REPO_MAIN, files, f"auto: progress {date}")

        # Also push Current-State.md to vault
        vault_ok = False
        if GITHUB_REPO_VAULT:
            vault_files = [{"path": "Current-State.md", "content": progress_content}]
            vault_ok = await _push_to_github(client, GITHUB_REPO_VAULT, vault_files, f"auto: state {date}")

        return main_ok or vault_ok
