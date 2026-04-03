"""
routers/sector_flow.py — 全市場族群資金流向（TWSE/TPEX 官方 API）

資料來源（免費、無配額限制）：
  1. TWSE T86 — 上市三大法人買賣超日報（全市場，單位：股）
  2. TPEX 3itrade — 上櫃三大法人買賣超（全市場，單位：股）
  3. FinMind TaiwanStockInfo — 產業分類 mapping（fallback: TWSE t187ap03_L）

計算：per-stock 外資+投信淨買賣 × 收盤價 / 1e8 = 億元，按產業加總。
"""

import asyncio
import re
import httpx
from datetime import datetime, timedelta
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# TWSE 產業代碼 → 名稱（t187ap03_L 的 產業別 欄位是數字代碼）
TWSE_INDUSTRY_MAP = {
    "01": "水泥工業", "02": "食品工業", "03": "塑膠工業", "04": "紡織纖維",
    "05": "電機機械", "06": "電器電纜", "21": "化學工業", "22": "生技醫療業",
    "07": "化學生技醫療", "08": "玻璃陶瓷", "09": "造紙工業", "10": "鋼鐵工業",
    "11": "橡膠工業", "12": "汽車工業", "13": "電子工業", "24": "半導體業",
    "25": "電腦及週邊設備業", "26": "光電業", "27": "通信網路業",
    "28": "電子零組件業", "29": "電子通路業", "30": "資訊服務業",
    "31": "其他電子類", "14": "建材營造業", "15": "航運業", "16": "觀光餐旅",
    "17": "金融保險", "18": "貿易百貨", "23": "油電燃氣業", "19": "綜合",
    "20": "其他", "32": "文化創意業", "33": "農業科技", "34": "電子商務",
    "35": "綠能環保類", "36": "數位雲端類", "37": "運動休閒類",
    "38": "居家生活類",
}


class SectorFlowRequest(BaseModel):
    finmind_token: str | None = None  # optional, for sector mapping fallback
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
    stock_count: int
    sector_count: int


def _parse_tw_number(s: str) -> int:
    """解析台灣格式數字 '15,610,628' → 15610628，處理負號。"""
    if not s or s.strip() in ("", "-", "--"):
        return 0
    cleaned = s.replace(",", "").strip()
    try:
        return int(cleaned)
    except ValueError:
        return 0


def _twse_date(iso_date: str) -> str:
    """YYYY-MM-DD → YYYYMMDD"""
    return iso_date.replace("-", "")


def _roc_date(iso_date: str) -> str:
    """YYYY-MM-DD → 民國 YYY/MM/DD"""
    dt = datetime.strptime(iso_date, "%Y-%m-%d")
    roc_year = dt.year - 1911
    return f"{roc_year}/{dt.month:02d}/{dt.day:02d}"


async def _fetch_twse_t86(client: httpx.AsyncClient, date: str) -> list[dict]:
    """TWSE T86 三大法人買賣超日報。回傳 [{stock_id, foreign_net, trust_net, dealer_net}]"""
    url = f"https://www.twse.com.tw/rwd/zh/fund/T86?date={_twse_date(date)}&selectType=ALL&response=json"
    resp = await client.get(url, timeout=30.0)
    resp.raise_for_status()
    body = resp.json()
    if body.get("stat") != "OK" or not body.get("data"):
        return []

    results = []
    for row in body["data"]:
        # T86 fields: [0]代號 [1]名稱 [2-4]外資買/賣/淨 [5-7]外資自營 [8-10]投信買/賣/淨 [11]自營商淨
        sid = row[0].strip()
        if not re.match(r"^\d{4,6}$", sid):
            continue
        results.append({
            "stock_id": sid,
            "foreign_net": _parse_tw_number(row[4]),  # 外陸資買賣超（股）
            "trust_net": _parse_tw_number(row[10]),    # 投信買賣超（股）
        })
    return results


async def _fetch_tpex_chips(client: httpx.AsyncClient, date: str) -> list[dict]:
    """TPEX 三大法人買賣超（完整欄位）。"""
    url = "https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php"
    params = {"l": "zh-tw", "d": _roc_date(date), "t": "D", "o": "json"}
    resp = await client.get(url, params=params, timeout=30.0)
    resp.raise_for_status()
    body = resp.json()
    if body.get("stat") != "ok" or not body.get("tables"):
        return []

    results = []
    table = body["tables"][0] if body["tables"] else {}
    for row in table.get("data", []):
        sid = row[0].strip()
        if not re.match(r"^\d{4,6}$", sid):
            continue
        results.append({
            "symbol": sid,
            "foreign_buy":  _parse_tw_number(row[2]),
            "foreign_sell": _parse_tw_number(row[3]),
            "foreign_net":  _parse_tw_number(row[4]),
            "trust_buy":    _parse_tw_number(row[8]),
            "trust_sell":   _parse_tw_number(row[9]),
            "trust_net":    _parse_tw_number(row[10]),
            "dealer_buy":   _parse_tw_number(row[12]) if len(row) > 12 else 0,
            "dealer_sell":  _parse_tw_number(row[13]) if len(row) > 13 else 0,
            "dealer_net":   _parse_tw_number(row[11]),
        })
    return results


async def _fetch_tpex_margin(client: httpx.AsyncClient) -> list[dict]:
    """TPEX 融資融券。"""
    url = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance"
    resp = await client.get(url, timeout=30.0)
    resp.raise_for_status()
    body = resp.json()
    if not isinstance(body, list):
        return []
    results = []
    for r in body:
        sid = (r.get("SecuritiesCompanyCode") or "").strip()
        if not re.match(r"^\d{4,6}$", sid):
            continue
        results.append({
            "symbol": sid,
            "margin_buy":     int(r.get("MarginPurchase", "0").replace(",", "") or 0),
            "margin_sell":    int(r.get("MarginSales", "0").replace(",", "") or 0),
            "margin_balance": int(r.get("MarginPurchaseBalance", "0").replace(",", "") or 0),
            "short_buy":      int(r.get("ShortCovering", r.get("ShortBuy", "0")).replace(",", "") or 0),
            "short_sell":     int(r.get("ShortSale", "0").replace(",", "") or 0),
            "short_balance":  int(r.get("ShortSaleBalance", "0").replace(",", "") or 0),
        })
    return results


async def _fetch_twse_prices(client: httpx.AsyncClient, date: str) -> dict[str, float]:
    """TWSE 上市個股日收盤價。回傳 {stock_id: close_price}"""
    url = f"https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?date={_twse_date(date)}&response=json"
    resp = await client.get(url, timeout=30.0)
    resp.raise_for_status()
    body = resp.json()
    prices = {}
    # STOCK_DAY_ALL fields: [0]代號 [1]名稱 [2]成交股數 [3]成交金額 [4]開盤 [5]最高 [6]最低 [7]收盤
    for row in body.get("data", []):
        sid = row[0].strip()
        if not re.match(r"^\d{4,6}$", sid):
            continue
        try:
            close = float(str(row[7]).replace(",", ""))
            prices[sid] = close
        except (ValueError, IndexError):
            continue
    return prices


async def _fetch_tpex_prices(client: httpx.AsyncClient, date: str) -> dict[str, float]:
    """TPEX 上櫃股票收盤價（OpenAPI）。"""
    url = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
    resp = await client.get(url, timeout=30.0)
    resp.raise_for_status()
    body = resp.json()
    prices = {}
    for row in body:
        sid = row.get("SecuritiesCompanyCode", "").strip()
        if not re.match(r"^\d{4,6}$", sid):
            continue
        try:
            close = float(str(row.get("Close", "0")).replace(",", ""))
            if close > 0:
                prices[sid] = close
        except (ValueError, TypeError):
            continue
    return prices


async def _fetch_sector_mapping(client: httpx.AsyncClient, finmind_token: str | None = None) -> dict[str, str]:
    """取得 stock_id → 產業名稱 mapping（TWSE + TPEX opendata）。"""
    sector_of: dict[str, str] = {}

    # TWSE + TPEX opendata（無配額限制，直接用）
    twse_task = client.get("https://openapi.twse.com.tw/v1/opendata/t187ap03_L", timeout=30.0)
    tpex_task = client.get("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O", timeout=30.0)
    results = await asyncio.gather(twse_task, tpex_task, return_exceptions=True)

    # TWSE 上市
    if not isinstance(results[0], Exception) and results[0].status_code == 200:
        for r in results[0].json():
            sid = r.get("公司代號", "").strip()
            code = r.get("產業別", "").strip()
            if sid and code:
                sector_of[sid] = TWSE_INDUSTRY_MAP.get(code, f"產業{code}")

    # TPEX 上櫃（SecuritiesIndustryCode 也是數字代碼）
    if not isinstance(results[1], Exception) and results[1].status_code == 200:
        for r in results[1].json():
            sid = r.get("SecuritiesCompanyCode", "").strip()
            code = r.get("SecuritiesIndustryCode", "").strip()
            if sid and code and sid not in sector_of:
                sector_of[sid] = TWSE_INDUSTRY_MAP.get(code, f"產業{code}")

    if sector_of:
        print(f"[SectorFlow] TWSE+TPEX opendata sector mapping: {len(sector_of)} stocks")

    return sector_of


@router.post("/sector-flow", response_model=SectorFlowResponse)
async def compute_sector_flow(req: SectorFlowRequest):
    """全市場族群資金流向（industry 級別）— TWSE/TPEX 官方 API。"""
    if req.date:
        target_date = req.date
    else:
        now_tw = datetime.utcnow() + timedelta(hours=8)
        target_date = now_tw.strftime("%Y-%m-%d")

    async with httpx.AsyncClient(
        headers={"User-Agent": "StockVision/12.3 (sector-flow)"},
        follow_redirects=True,
    ) as client:
        # 並行呼叫：TWSE chips + TPEX chips + TWSE prices + TPEX prices + sector mapping
        results = await asyncio.gather(
            _fetch_twse_t86(client, target_date),
            _fetch_tpex_chips(client, target_date),
            _fetch_twse_prices(client, target_date),
            _fetch_tpex_prices(client, target_date),
            _fetch_sector_mapping(client, req.finmind_token),
            return_exceptions=True,
        )

        twse_chips = results[0] if not isinstance(results[0], Exception) else []
        tpex_chips = results[1] if not isinstance(results[1], Exception) else []
        twse_prices = results[2] if not isinstance(results[2], Exception) else {}
        tpex_prices = results[3] if not isinstance(results[3], Exception) else {}
        sector_of = results[4] if not isinstance(results[4], Exception) else {}

        for i, name in enumerate(["TWSE chips", "TPEX chips", "TWSE prices", "TPEX prices", "sector mapping"]):
            if isinstance(results[i], Exception):
                print(f"[SectorFlow] {name} failed: {results[i]}")

    all_chips = twse_chips + tpex_chips
    all_prices = {**twse_prices, **tpex_prices}

    if not all_chips:
        print(f"[SectorFlow] No chip data for {target_date}")
        return SectorFlowResponse(date=target_date, sectors=[], stock_count=0, sector_count=0)

    print(f"[SectorFlow] Data: {len(twse_chips)} TWSE + {len(tpex_chips)} TPEX chips, "
          f"{len(all_prices)} prices, {len(sector_of)} sectors")

    # 按產業加總（淨買賣股數 × 收盤價 / 1e8 = 億元）
    sector_agg: dict[str, dict] = {}
    matched = 0
    for chip in all_chips:
        sid = chip["stock_id"]
        sector = sector_of.get(sid)
        price = all_prices.get(sid, 0)
        if not sector or price <= 0:
            continue
        matched += 1

        if sector not in sector_agg:
            sector_agg[sector] = {"foreign_net": 0.0, "trust_net": 0.0, "stock_count": 0}
        agg = sector_agg[sector]
        agg["stock_count"] += 1
        agg["foreign_net"] += chip["foreign_net"] * price / 1e8
        agg["trust_net"] += chip["trust_net"] * price / 1e8

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

    print(f"[SectorFlow] Result: {matched} matched stocks → {len(sectors)} sectors")

    return SectorFlowResponse(
        date=target_date,
        sectors=sectors[:30],
        stock_count=matched,
        sector_count=len(sectors),
    )


# ─── TPEX Proxy: Worker 無法直接呼叫 TPEX（被擋），透過 Controller 代理 ────────

class TpexProxyRequest(BaseModel):
    date: str | None = None


@router.post("/tpex-chips")
async def proxy_tpex_chips(req: TpexProxyRequest):
    """TPEX 三大法人買賣超 proxy（Worker → Controller → TPEX）。"""
    if req.date:
        target_date = req.date
    else:
        now_tw = datetime.utcnow() + timedelta(hours=8)
        target_date = now_tw.strftime("%Y-%m-%d")

    async with httpx.AsyncClient(
        headers={"User-Agent": "StockVision/12.3"},
        follow_redirects=True,
    ) as client:
        chips = await _fetch_tpex_chips(client, target_date)
        margin = await _fetch_tpex_margin(client)

    print(f"[TpexProxy] {len(chips)} chips + {len(margin)} margins for {target_date}")
    return {"date": target_date, "chips": chips, "margins": margin}


# ─── TWSE Proxy: CF Worker IP 被 TWSE SSL 擋，透過 Controller 代理 ──────────

@router.get("/twse/ex-dividend")
async def proxy_twse_ex_dividend():
    """除權除息預告（TWSE TWT48U + TPEX）。"""
    results = []
    async with httpx.AsyncClient(headers={"User-Agent": "StockVision/12.3"}, follow_redirects=True) as client:
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
            print(f"[TwseProxy] ex-dividend TWSE failed: {e}")

        # TPEX
        try:
            resp = await client.get("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_ex_dividend_forecast", timeout=30.0)
            if resp.status_code == 200:
                for r in resp.json():
                    sym = (r.get("SecuritiesCompanyCode") or "").strip()
                    if re.match(r"^\d{4,6}$", sym):
                        results.append({"symbol": sym, "ex_date": r.get("ExDividendDate", ""), "type": "cash", "cash_dividend": None, "stock_dividend": None})
        except Exception as e:
            print(f"[TwseProxy] ex-dividend TPEX failed: {e}")

    print(f"[TwseProxy] ex-dividend: {len(results)} entries")
    return results


@router.get("/twse/attention-stocks")
async def proxy_twse_attention():
    """注意股標示（TWSE announcement/notice）。"""
    symbols = []
    try:
        async with httpx.AsyncClient(headers={"User-Agent": "StockVision/12.3"}, follow_redirects=True) as client:
            resp = await client.get("https://www.twse.com.tw/rwd/zh/announcement/notice?response=json", timeout=30.0)
            if resp.status_code == 200:
                body = resp.json()
                if body.get("stat") == "OK":
                    for row in body.get("data", []):
                        sym = str(row[1]).strip()
                        if re.match(r"^\d{4,6}$", sym):
                            symbols.append(sym)
    except Exception as e:
        print(f"[TwseProxy] attention failed: {e}")
    print(f"[TwseProxy] attention: {len(symbols)} stocks")
    return symbols


@router.get("/twse/margin-summary")
async def proxy_twse_margin_summary():
    """融資融券市場統計（TWSE MI_MARGN selectType=MS）。"""
    from datetime import datetime, timedelta
    now_tw = datetime.utcnow() + timedelta(hours=8)
    date_str = now_tw.strftime("%Y%m%d")
    try:
        async with httpx.AsyncClient(headers={"User-Agent": "StockVision/12.3"}, follow_redirects=True) as client:
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
                            print(f"[TwseProxy] margin: balance={balance}, limit={limit}")
                            return {"balance": balance, "limit": limit}
    except Exception as e:
        print(f"[TwseProxy] margin-summary failed: {e}")
    return {"balance": None, "limit": None}
