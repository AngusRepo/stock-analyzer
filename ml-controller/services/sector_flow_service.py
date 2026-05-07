"""
sector_flow_service.py — Compute + write sector_flow RRG (Phase 6.2+6.3)

Replaces:
- V1 dailyRecommendation.ts:170-204 theme RRG (correct formula, wrong in_current_watchlist=1 filter)
- V1 marketScreener.ts:calcIndustryRRG (wrong Z-score formula)

Drops B8 bug: `in_current_watchlist=1` filter (only 33 stocks) — now reads ALL stocks.
Fixes B9 bug: uses `tag_type` filter to separate concept vs industry.

Mapping:
    stock_tags.tag_type = 'concept'  → sector_flow.classification = 'theme'
    stock_tags.tag_type = 'industry' → sector_flow.classification = 'industry'
"""
from __future__ import annotations
import logging
from typing import Literal, Optional, TypedDict

from services import d1_client
from services._rrg_calculator import build_rrg_point, RrgPoint

logger = logging.getLogger(__name__)

TagType = Literal["concept", "industry", "subindustry"]
Classification = Literal["theme", "industry", "subindustry"]


class CashFlow(TypedDict):
    foreign_net: float
    trust_net: float
    dealer_net: float
    total_net: float


def _tag_type_to_classification(tag_type: TagType) -> Classification:
    if tag_type == "concept":
        return "theme"
    if tag_type == "subindustry":
        return "subindustry"
    return "industry"


def _load_member_returns_5d(as_of_date: str) -> dict[str, float]:
    """
    Load 5-trading-day returns for ALL stocks (NO in_current_watchlist filter — Bug B8 fix).

    Returns {symbol: return_5d} where return_5d = (close_now - close_5d_ago) / close_5d_ago.
    Uses last 6 price points per stock (most recent is "now", 6th is "5 days ago").

    as_of_date: the latest date to include (inclusive), e.g. "2026-04-08".
    """
    sql = """
    SELECT
      s.symbol,
      sp.date,
      sp.close
    FROM stock_prices sp
    JOIN stocks s ON s.id = sp.stock_id
    WHERE sp.date <= ?
      AND sp.date >= date(?, '-20 days')
    ORDER BY s.symbol ASC, sp.date DESC
    """
    rows = d1_client.query(sql, [as_of_date, as_of_date])
    # Group by symbol, take [0] and [5]
    by_sym: dict[str, list[float]] = {}
    for r in rows:
        sym = r.get("symbol")
        close = r.get("close")
        if sym is None or close is None:
            continue
        by_sym.setdefault(sym, []).append(float(close))

    returns: dict[str, float] = {}
    for sym, closes in by_sym.items():
        if len(closes) < 6:
            continue  # not enough history
        latest = closes[0]
        ago5 = closes[5]
        if ago5 > 0:
            returns[sym] = (latest - ago5) / ago5
    return returns


def _load_twii_return_5d(as_of_date: str) -> float:
    """
    TWII 5-day return from market_risk.twii_close.

    V1 logic (dailyRecommendation.ts:159-167):
      take last 6 rows by date DESC, latest=[0], prev5=[min(5,len-1)].
      if both valid: return (latest-prev5)/prev5, else 0.
    """
    sql = """
    SELECT twii_close FROM market_risk
    WHERE date <= ?
    ORDER BY date DESC LIMIT 6
    """
    rows = d1_client.query(sql, [as_of_date])
    if not rows or len(rows) < 2:
        return 0.0
    latest = rows[0].get("twii_close")
    idx = min(5, len(rows) - 1)
    prev5 = rows[idx].get("twii_close")
    if latest is None or prev5 is None or prev5 <= 0:
        return 0.0
    return (float(latest) - float(prev5)) / float(prev5)


def _load_stock_tags(tag_type: TagType) -> dict[str, list[str]]:
    """
    Load {tag_name: [symbols]} for a given tag_type.
    """
    sql = """
    SELECT tag, symbol FROM stock_tags
    WHERE tag_type = ?
    """
    rows = d1_client.query(sql, [tag_type])
    by_tag: dict[str, list[str]] = {}
    for r in rows:
        tag = r.get("tag")
        sym = r.get("symbol")
        if tag and sym:
            by_tag.setdefault(tag, []).append(sym)
    return by_tag


def _load_symbol_cash_flows_5d(as_of_date: str, lookback_days: int = 5) -> dict[str, CashFlow]:
    """Load per-symbol 5-day institutional cash flow in TWD billions."""
    date_rows = d1_client.query(
        """
        SELECT DISTINCT date
        FROM chip_data
        WHERE date <= ?
        ORDER BY date DESC
        LIMIT ?
        """,
        [as_of_date, lookback_days],
    )
    dates = [r.get("date") for r in date_rows if r.get("date")]
    if not dates:
        return {}

    placeholders = ",".join("?" * len(dates))
    rows = d1_client.query(
        f"""
        SELECT
          c.symbol,
          COALESCE(c.foreign_net, 0) AS foreign_net,
          COALESCE(c.trust_net, 0) AS trust_net,
          COALESCE(c.dealer_net, 0) AS dealer_net,
          (
            SELECT sp.close
            FROM stock_prices sp
            JOIN stocks s ON s.id = sp.stock_id
            WHERE s.symbol = c.symbol
              AND sp.date <= c.date
            ORDER BY sp.date DESC
            LIMIT 1
          ) AS close
        FROM chip_data c
        WHERE c.date IN ({placeholders})
        """,
        dates,
    )

    flows: dict[str, CashFlow] = {}
    for r in rows:
        symbol = r.get("symbol")
        close = float(r.get("close") or 0)
        if not symbol or close <= 0:
            continue
        entry = flows.setdefault(
            symbol,
            {"foreign_net": 0.0, "trust_net": 0.0, "dealer_net": 0.0, "total_net": 0.0},
        )
        foreign_cash = float(r.get("foreign_net") or 0) * close / 1e8
        trust_cash = float(r.get("trust_net") or 0) * close / 1e8
        dealer_cash = float(r.get("dealer_net") or 0) * close / 1e8
        entry["foreign_net"] += foreign_cash
        entry["trust_net"] += trust_cash
        entry["dealer_net"] += dealer_cash
        entry["total_net"] += foreign_cash + trust_cash + dealer_cash
    return flows


def _aggregate_tag_cash_flows(
    tag_members: dict[str, list[str]],
    symbol_flows: dict[str, CashFlow],
) -> dict[str, CashFlow]:
    tag_flows: dict[str, CashFlow] = {}
    for tag, members in tag_members.items():
        flow: CashFlow = {"foreign_net": 0.0, "trust_net": 0.0, "dealer_net": 0.0, "total_net": 0.0}
        for symbol in members:
            sf = symbol_flows.get(symbol)
            if not sf:
                continue
            flow["foreign_net"] += sf["foreign_net"]
            flow["trust_net"] += sf["trust_net"]
            flow["dealer_net"] += sf["dealer_net"]
            flow["total_net"] += sf["total_net"]
        tag_flows[tag] = flow
    return tag_flows


def _load_stock_names() -> dict[str, str]:
    rows = d1_client.query("SELECT symbol, name FROM stocks")
    return {
        str(r.get("symbol")): str(r.get("name") or r.get("symbol"))
        for r in rows
        if r.get("symbol")
    }


def write_sector_flow_stock_details(
    *,
    as_of_date: str,
    tag_members: dict[str, list[str]],
    symbol_flows: dict[str, CashFlow],
    top_per_theme: int = 10,
) -> int:
    """Refresh sector_flow_stocks so UI detail rows do not fall back to stale dates."""
    if not tag_members:
        return 0

    stock_names = _load_stock_names()
    statements: list[tuple[str, list]] = [
        ("DELETE FROM sector_flow_stocks WHERE date = ?", [as_of_date])
    ]
    for tag, members in tag_members.items():
        ranked = sorted(
            (
                (symbol, symbol_flows.get(symbol))
                for symbol in members
                if symbol_flows.get(symbol) and float(symbol_flows[symbol].get("total_net") or 0.0) > 0
            ),
            key=lambda item: float((item[1] or {}).get("total_net") or 0.0),
            reverse=True,
        )[: max(1, int(top_per_theme))]
        for symbol, flow in ranked:
            if not flow:
                continue
            statements.append((
                """
                INSERT INTO sector_flow_stocks
                  (date, theme, symbol, name, net_amount, foreign_net, trust_net, volume_ratio, classification)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.strip(),
                [
                    as_of_date,
                    tag,
                    symbol,
                    stock_names.get(symbol, symbol),
                    round(float(flow.get("total_net") or 0.0), 4),
                    round(float(flow.get("foreign_net") or 0.0), 4),
                    round(float(flow.get("trust_net") or 0.0), 4),
                    None,
                    "top",
                ],
            ))

    if len(statements) == 1:
        d1_client.execute(statements[0][0], statements[0][1])
        return 0
    result = d1_client.batch_execute(statements, chunk_size=100)
    written = max(0, int(result.get("success_count") or result.get("total") or 0) - 1)
    logger.info(f"[sector_flow] Wrote {written} sector_flow_stocks rows for {as_of_date}")
    return written


def _load_prev_rs_ratios(
    classification: Classification,
    as_of_date: str,
) -> dict[str, float]:
    """
    Load prev rs_ratio (5 trading days ago) for momentum computation.

    V1 dailyRecommendation.ts:183-188 logic:
      pick the 5th-most-recent date strictly before as_of_date that has rs_ratio data.
    """
    sql = """
    SELECT sector, rs_ratio FROM sector_flow
    WHERE classification = ?
      AND rs_ratio IS NOT NULL
      AND date = (
        SELECT date FROM sector_flow
        WHERE classification = ? AND rs_ratio IS NOT NULL AND date < ?
        ORDER BY date DESC LIMIT 1 OFFSET 4
      )
    ORDER BY sector
    """
    rows = d1_client.query(sql, [classification, classification, as_of_date])
    return {
        r["sector"]: float(r["rs_ratio"])
        for r in rows
        if r.get("sector") and r.get("rs_ratio") is not None
    }


def compute_sector_flow_for_tag_type(
    tag_type: TagType,
    as_of_date: str,
) -> list[RrgPoint]:
    """
    Compute RrgPoints for all tags of a given tag_type as of a date.
    Pure computation — does NOT write to D1 (call write_sector_flow to persist).
    """
    tag_members = _load_stock_tags(tag_type)
    returns = _load_member_returns_5d(as_of_date)
    twii_ret = _load_twii_return_5d(as_of_date)
    classification = _tag_type_to_classification(tag_type)
    prev_rs = _load_prev_rs_ratios(classification, as_of_date)

    points: list[RrgPoint] = []
    for tag, members in tag_members.items():
        member_returns = [returns[s] for s in members if s in returns]
        pt = build_rrg_point(
            sector=tag,
            member_returns=member_returns,
            benchmark_return_5d=twii_ret,
            prev_rs_ratio=prev_rs.get(tag),
        )
        points.append(pt)

    logger.info(
        f"[sector_flow] tag_type={tag_type} as_of={as_of_date} "
        f"twii_5d={twii_ret*100:.2f}% "
        f"total_tags={len(points)} "
        f"with_rs={sum(1 for p in points if p.rs_ratio is not None)}"
    )
    return points


def write_sector_flow(
    points: list[RrgPoint],
    classification: Classification,
    as_of_date: str,
    cash_flows: Optional[dict[str, CashFlow]] = None,
) -> int:
    """
    Upsert sector_flow rows.

    UNIQUE constraint: (date, sector, classification) — use INSERT OR REPLACE.
    Only writes rs_ratio / rs_momentum / quadrant (other chip-flow fields
    stay as they were, or default to 0/NULL if row is new).
    """
    if not points:
        return 0

    # INSERT OR REPLACE preserves UNIQUE constraint semantics
    # stock_count/up_count/foreign_net/trust_net/total_net are populated by
    # chip-flow computation (separate path) — here we ONLY populate RRG fields.
    # Use COALESCE via SELECT existing row, fallback to 0.
    statements: list[tuple[str, list]] = []
    for pt in points:
        if pt.rs_ratio is None:
            continue  # skip tags without enough members
        flow = (cash_flows or {}).get(pt.sector) or {
            "foreign_net": 0.0,
            "trust_net": 0.0,
            "total_net": 0.0,
        }
        statements.append((
            """
            INSERT INTO sector_flow (date, sector, classification, rs_ratio, rs_momentum, quadrant, stock_count, foreign_net, trust_net, total_net)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date, sector, classification) DO UPDATE SET
              rs_ratio = excluded.rs_ratio,
              rs_momentum = excluded.rs_momentum,
              quadrant = excluded.quadrant,
              stock_count = excluded.stock_count,
              foreign_net = excluded.foreign_net,
              trust_net = excluded.trust_net,
              total_net = excluded.total_net
            """.strip(),
            [
                as_of_date,
                pt.sector,
                classification,
                pt.rs_ratio,
                pt.rs_momentum,
                pt.quadrant,
                pt.member_count,
                round(float(flow.get("foreign_net") or 0.0), 4),
                round(float(flow.get("trust_net") or 0.0), 4),
                round(float(flow.get("total_net") or 0.0), 4),
            ],
        ))

    if not statements:
        return 0
    result = d1_client.batch_execute(statements)
    written = result.get("total", 0)
    logger.info(f"[sector_flow] Wrote {written} {classification} rows for {as_of_date}")
    return written


def run_sector_flow_pipeline(as_of_date: str) -> dict:
    """
    Full pipeline: compute concept + subindustry + industry, write all to sector_flow.

    Called by:
    - daily_pipeline_v2.py node_compute_sector_flow
    - backfill scripts (with explicit date)

    Each tag_type runs independently — failure in one does not block others.
    Subindustry is optional: if no rows exist for that tag_type the path
    silently writes 0 rows.
    """
    summary: dict = {"as_of_date": as_of_date}

    paths: list[tuple[TagType, Classification]] = [
        ("concept", "theme"),
        ("subindustry", "subindustry"),
        ("industry", "industry"),
    ]

    symbol_flows = _load_symbol_cash_flows_5d(as_of_date)
    for tag_type, classification in paths:
        try:
            tag_members = _load_stock_tags(tag_type)
            pts = compute_sector_flow_for_tag_type(tag_type, as_of_date)
            tag_flows = _aggregate_tag_cash_flows(tag_members, symbol_flows)
            written = write_sector_flow(pts, classification, as_of_date, tag_flows)
            counts = {"Leading": 0, "Weakening": 0, "Lagging": 0, "Improving": 0}
            for p in pts:
                if p.quadrant:
                    counts[p.quadrant] = counts.get(p.quadrant, 0) + 1
            summary[tag_type] = {
                "total_tags": len(pts),
                "with_rs": sum(1 for p in pts if p.rs_ratio is not None),
                "written": written,
                "quadrants": counts,
            }
            if tag_type == "concept":
                summary[tag_type]["stock_details_written"] = write_sector_flow_stock_details(
                    as_of_date=as_of_date,
                    tag_members=tag_members,
                    symbol_flows=symbol_flows,
                )
        except Exception as e:
            logger.error(f"[sector_flow] {tag_type} path failed: {e}")
            summary[tag_type] = {"error": str(e)}

    logger.info(f"[sector_flow] Pipeline complete: {summary}")
    return summary
