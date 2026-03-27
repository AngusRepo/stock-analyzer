"""
routers/sector_flow.py — 全市場族群資金流向（FinMind bulk API）

Worker 傳入 finmind_token + date，Controller 直接呼叫 FinMind：
  1. TaiwanStockInstitutionalInvestorsBuySell（全市場三大法人）
  2. TaiwanStockPrice（全市場股價）
  3. TaiwanStockInfo（產業分類 metadata）

計算每個 TWSE/OTC 官方產業的外資+投信淨買賣金額（億元），回傳排序結果。
"""

import httpx
from datetime import datetime, timedelta
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data"


class SectorFlowRequest(BaseModel):
    finmind_token: str
    date: str | None = None  # YYYY-MM-DD, default today TW


class SectorSummary(BaseModel):
    sector: str
    foreign_net: float  # 億元
    trust_net: float
    total_net: float
    stock_count: int


class SectorFlowResponse(BaseModel):
    date: str
    sectors: list[SectorSummary]
    stock_count: int  # 涵蓋總股數
    sector_count: int


async def _fm_fetch(client: httpx.AsyncClient, token: str, dataset: str, params: dict) -> list[dict]:
    """呼叫 FinMind API，回傳 data array。"""
    resp = await client.get(FINMIND_BASE, params={
        "dataset": dataset,
        "token": token,
        **params,
    }, timeout=60.0)
    resp.raise_for_status()
    body = resp.json()
    if body.get("status") != 200:
        raise ValueError(f"FinMind {dataset} error: {body.get('msg', 'unknown')}")
    return body.get("data", [])


@router.post("/sector-flow", response_model=SectorFlowResponse)
async def compute_sector_flow(req: SectorFlowRequest):
    """全市場族群資金流向（industry 級別）。"""
    # 日期：預設 TW 今天
    if req.date:
        target_date = req.date
    else:
        now_tw = datetime.utcnow() + timedelta(hours=8)
        target_date = now_tw.strftime("%Y-%m-%d")

    # 抓近 5 個交易日（往前推 7 天涵蓋週末）
    end_dt = datetime.strptime(target_date, "%Y-%m-%d")
    start_date = (end_dt - timedelta(days=7)).strftime("%Y-%m-%d")

    async with httpx.AsyncClient() as client:
        # 並行呼叫 3 個 API
        import asyncio
        chips_task = _fm_fetch(client, req.finmind_token,
                               "TaiwanStockInstitutionalInvestorsBuySell",
                               {"start_date": start_date, "end_date": target_date})
        prices_task = _fm_fetch(client, req.finmind_token,
                                "TaiwanStockPrice",
                                {"start_date": target_date, "end_date": target_date})
        info_task = _fm_fetch(client, req.finmind_token,
                              "TaiwanStockInfo", {})

        results = await asyncio.gather(
            chips_task, prices_task, info_task,
            return_exceptions=True,
        )
        # 處理個別 API 失敗（FinMind bulk chips 可能 400）
        chips_raw = results[0] if not isinstance(results[0], Exception) else []
        prices_raw = results[1] if not isinstance(results[1], Exception) else []
        info_raw = results[2] if not isinstance(results[2], Exception) else []

        if isinstance(results[0], Exception):
            print(f"[SectorFlow] chips API failed: {results[0]}")
        if isinstance(results[1], Exception):
            print(f"[SectorFlow] prices API failed: {results[1]}")
        if isinstance(results[2], Exception):
            print(f"[SectorFlow] info API failed: {results[2]}")

        if not chips_raw or not info_raw:
            return SectorFlowResponse(date=target_date, sectors=[], stock_count=0, sector_count=0)

    # 1. 產業分類 mapping
    sector_of: dict[str, str] = {}
    for s in info_raw:
        cat = s.get("industry_category")
        if cat:
            sector_of[s["stock_id"]] = cat

    # 2. 最新收盤價
    price_of: dict[str, float] = {}
    for p in prices_raw:
        price_of[p["stock_id"]] = p.get("close", 0)

    # 3. 法人淨買賣（張）per stock — aggregate 5 日
    # name: Foreign_Investor, Investment_Trust, Dealer_self
    stock_chips: dict[str, dict[str, float]] = {}
    for r in chips_raw:
        sid = r["stock_id"]
        if sid not in stock_chips:
            stock_chips[sid] = {"foreign": 0.0, "trust": 0.0}
        net = r.get("buy", 0) - r.get("sell", 0)
        name = r.get("name", "")
        if "Foreign" in name:
            stock_chips[sid]["foreign"] += net
        elif "Investment_Trust" in name:
            stock_chips[sid]["trust"] += net

    # 4. 按產業加總（張 × 股價 × 1000 / 1e8 = 億元）
    sector_agg: dict[str, dict] = {}
    for sid, chips in stock_chips.items():
        sector = sector_of.get(sid)
        if not sector:
            continue
        price = price_of.get(sid, 0)
        if price <= 0:
            continue

        if sector not in sector_agg:
            sector_agg[sector] = {"foreign_net": 0.0, "trust_net": 0.0, "stock_count": 0}
        agg = sector_agg[sector]
        agg["stock_count"] += 1
        agg["foreign_net"] += chips["foreign"] * price / 1e8
        agg["trust_net"] += chips["trust"] * price / 1e8

    # 5. 排序
    sectors = []
    for name, agg in sector_agg.items():
        total = agg["foreign_net"] + agg["trust_net"]
        sectors.append(SectorSummary(
            sector=name,
            foreign_net=round(agg["foreign_net"], 2),
            trust_net=round(agg["trust_net"], 2),
            total_net=round(total, 2),
            stock_count=agg["stock_count"],
        ))
    sectors.sort(key=lambda s: s.total_net, reverse=True)

    return SectorFlowResponse(
        date=target_date,
        sectors=sectors[:30],  # Top 30 產業
        stock_count=len(stock_chips),
        sector_count=len(sectors),
    )
