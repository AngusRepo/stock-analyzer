"""
routers/sector_flow.py — 全市場族群資金流向 API endpoint

業務邏輯已抽到 services/sector_service.py，
本檔僅負責 HTTP request/response 處理。
"""

import asyncio
import re
import logging
import httpx
from datetime import datetime, timedelta
from fastapi import APIRouter
from pydantic import BaseModel

from services.sector_service import (
    fetch_twse_t86, fetch_tpex_chips, fetch_tpex_margin,
    fetch_twse_prices, fetch_tpex_prices,
    fetch_sector_mapping, aggregate_sector_flow,
    twse_date, roc_date, parse_tw_number,
)

logger = logging.getLogger(__name__)
router = APIRouter()

_USER_AGENT = "StockVision/12.3 (sector-flow)"


# ─── Request / Response Models ────────────────────────────────────────────────

class SectorFlowRequest(BaseModel):
    finmind_token: str | None = None
    date: str | None = None

class SectorSummary(BaseModel):
    sector: str
    foreign_net: float
    trust_net: float
    total_net: float
    stock_count: int

class SectorFlowResponse(BaseModel):
    date: str
    sectors: list[SectorSummary]
    stock_count: int
    sector_count: int

class TpexProxyRequest(BaseModel):
    date: str | None = None


# ─── Helper ───────────────────────────────────────────────────────────────────

def _today_tw() -> str:
    return (datetime.utcnow() + timedelta(hours=8)).strftime("%Y-%m-%d")


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/sector-flow", response_model=SectorFlowResponse)
async def compute_sector_flow(req: SectorFlowRequest):
    """全市場族群資金流向（industry 級別）— TWSE/TPEX 官方 API。"""
    target_date = req.date or _today_tw()

    async with httpx.AsyncClient(
        headers={"User-Agent": _USER_AGENT},
        follow_redirects=True,
    ) as client:
        results = await asyncio.gather(
            fetch_twse_t86(client, target_date),
            fetch_tpex_chips(client, target_date),
            fetch_twse_prices(client, target_date),
            fetch_tpex_prices(client, target_date),
            fetch_sector_mapping(client, req.finmind_token),
            return_exceptions=True,
        )

        twse_chips = results[0] if not isinstance(results[0], Exception) else []
        tpex_chips = results[1] if not isinstance(results[1], Exception) else []
        twse_prices = results[2] if not isinstance(results[2], Exception) else {}
        tpex_prices = results[3] if not isinstance(results[3], Exception) else {}
        sector_of = results[4] if not isinstance(results[4], Exception) else {}

        for i, name in enumerate(["TWSE chips", "TPEX chips", "TWSE prices", "TPEX prices", "sector mapping"]):
            if isinstance(results[i], Exception):
                logger.warning(f"{name} failed: {results[i]}")

    all_chips = twse_chips + tpex_chips
    all_prices = {**twse_prices, **tpex_prices}

    if not all_chips:
        logger.warning(f"No chip data for {target_date}")
        return SectorFlowResponse(date=target_date, sectors=[], stock_count=0, sector_count=0)

    logger.info(f"Data: {len(twse_chips)} TWSE + {len(tpex_chips)} TPEX chips, "
                f"{len(all_prices)} prices, {len(sector_of)} sectors")

    sectors, matched = aggregate_sector_flow(all_chips, all_prices, sector_of)

    logger.info(f"Result: {matched} matched stocks → {len(sectors)} sectors")

    return SectorFlowResponse(
        date=target_date,
        sectors=[SectorSummary(**s) for s in sectors[:30]],
        stock_count=matched,
        sector_count=len(sectors),
    )


# ─── TPEX Proxy: Worker 無法直接呼叫 TPEX（被擋），透過 Controller 代理 ────────

@router.post("/tpex-chips")
async def proxy_tpex_chips(req: TpexProxyRequest):
    """TPEX 三大法人買賣超 proxy（Worker → Controller → TPEX）。"""
    target_date = req.date or _today_tw()

    async with httpx.AsyncClient(
        headers={"User-Agent": _USER_AGENT},
        follow_redirects=True,
    ) as client:
        chips = await fetch_tpex_chips(client, target_date)
        margin = await fetch_tpex_margin(client)

    logger.info(f"TPEX proxy: {len(chips)} chips + {len(margin)} margins for {target_date}")
    return {"date": target_date, "chips": chips, "margins": margin}


# ─── TWSE Proxy: CF Worker IP 被 TWSE SSL 擋，透過 Controller 代理 ──────────

@router.get("/twse/ex-dividend")
async def proxy_twse_ex_dividend():
    """除權除息預告（TWSE TWT48U + TPEX）。"""
    results = []
    async with httpx.AsyncClient(headers={"User-Agent": _USER_AGENT}, follow_redirects=True) as client:
        # TWSE
        try:
            resp = await client.get("https://openapi.twse.com.tw/v1/exchangeReport/TWT48U", timeout=30.0)
            if resp.status_code == 200:
                for r in resp.json():
                    sym = (r.get("證券代號") or "").strip()
                    if not re.match(r"^\d{4,6}$", sym):
                        continue
                    raw_date = (r.get("除權息日期") or "").strip()
                    ex_date = ""
                    if "/" in raw_date:
                        parts = raw_date.split("/")
                        y = int(parts[0]) + 1911
                        ex_date = f"{y}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"
                    type_str = (r.get("除權息類別") or "").strip()
                    has_cash = "息" in type_str
                    has_stock = "權" in type_str
                    ex_type = "both" if has_cash and has_stock else ("stock" if has_stock else "cash")
                    cash_div = None
                    try:
                        cash_div = float(str(r.get("現金股利", "0")).replace(",", "")) or None
                    except Exception:
                        pass
                    stock_div = None
                    try:
                        stock_div = float(str(r.get("無償配股率", "0")).replace(",", "")) or None
                    except Exception:
                        pass
                    if ex_date:
                        results.append({"symbol": sym, "ex_date": ex_date, "type": ex_type, "cash_dividend": cash_div, "stock_dividend": stock_div})
        except Exception as e:
            logger.warning(f"ex-dividend TWSE failed: {e}")

        # TPEX
        try:
            resp = await client.get("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_ex_dividend_forecast", timeout=30.0)
            if resp.status_code == 200:
                for r in resp.json():
                    sym = (r.get("SecuritiesCompanyCode") or "").strip()
                    if re.match(r"^\d{4,6}$", sym):
                        results.append({"symbol": sym, "ex_date": r.get("ExDividendDate", ""), "type": "cash", "cash_dividend": None, "stock_dividend": None})
        except Exception as e:
            logger.warning(f"ex-dividend TPEX failed: {e}")

    logger.info(f"ex-dividend: {len(results)} entries")
    return results


@router.get("/twse/attention-stocks")
async def proxy_twse_attention():
    """注意股標示（TWSE announcement/notice）。"""
    symbols = []
    try:
        async with httpx.AsyncClient(headers={"User-Agent": _USER_AGENT}, follow_redirects=True) as client:
            resp = await client.get("https://www.twse.com.tw/rwd/zh/announcement/notice?response=json", timeout=30.0)
            if resp.status_code == 200:
                body = resp.json()
                if body.get("stat") == "OK":
                    for row in body.get("data", []):
                        sym = str(row[1]).strip()
                        if re.match(r"^\d{4,6}$", sym):
                            symbols.append(sym)
    except Exception as e:
        logger.warning(f"attention-stocks failed: {e}")
    logger.info(f"attention: {len(symbols)} stocks")
    return symbols


@router.get("/twse/margin-summary")
async def proxy_twse_margin_summary():
    """融資融券市場統計（TWSE MI_MARGN selectType=MS）。"""
    now_tw = datetime.utcnow() + timedelta(hours=8)
    date_str = now_tw.strftime("%Y%m%d")
    try:
        async with httpx.AsyncClient(headers={"User-Agent": _USER_AGENT}, follow_redirects=True) as client:
            resp = await client.get(
                f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date={date_str}&selectType=MS&response=json",
                timeout=30.0,
            )
            if resp.status_code != 200:
                return {"balance": None, "limit": None}
            body = resp.json()
            if body.get("stat") != "OK" or not body.get("tables"):
                return {"balance": None, "limit": None}
            for table in body["tables"]:
                if not table.get("data"):
                    continue
                for row in table["data"]:
                    if not isinstance(row, list):
                        continue
                    if "融資" in str(row[0]):
                        balance = int(str(row[5]).replace(",", "").strip() or "0") if len(row) > 5 else 0
                        limit = int(str(row[6]).replace(",", "").strip() or "0") if len(row) > 6 else 0
                        if balance > 0 and limit > 0:
                            logger.info(f"margin: balance={balance}, limit={limit}")
                            return {"balance": balance, "limit": limit}
    except Exception as e:
        logger.warning(f"margin-summary failed: {e}")
    return {"balance": None, "limit": None}
