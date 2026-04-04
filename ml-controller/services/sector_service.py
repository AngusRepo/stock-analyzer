"""
services/sector_service.py — 全市場族群資金流向資料抓取與聚合

從 routers/sector_flow.py 抽出的業務邏輯：
  - TWSE/TPEX 官方 API 資料抓取
  - 產業分類 mapping
  - 資金流向聚合計算
  - 工具函式（數字解析、日期轉換）
"""

import asyncio
import re
import logging
import httpx

logger = logging.getLogger(__name__)

# ─── Constants ────────────────────────────────────────────────────────────────

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


# ─── Utility Functions ────────────────────────────────────────────────────────

def parse_tw_number(s: str) -> int:
    """解析台灣格式數字 '15,610,628' → 15610628，處理負號。"""
    if not s or s.strip() in ("", "-", "--"):
        return 0
    cleaned = s.replace(",", "").strip()
    try:
        return int(cleaned)
    except ValueError:
        return 0


def twse_date(iso_date: str) -> str:
    """YYYY-MM-DD → YYYYMMDD"""
    return iso_date.replace("-", "")


def roc_date(iso_date: str) -> str:
    """YYYY-MM-DD → 民國 YYY/MM/DD"""
    from datetime import datetime
    dt = datetime.strptime(iso_date, "%Y-%m-%d")
    roc_year = dt.year - 1911
    return f"{roc_year}/{dt.month:02d}/{dt.day:02d}"


# ─── Data Fetching Functions ─────────────────────────────────────────────────

async def fetch_twse_t86(client: httpx.AsyncClient, date: str) -> list[dict]:
    """TWSE T86 三大法人買賣超日報。回傳 [{stock_id, foreign_net, trust_net}]"""
    url = f"https://www.twse.com.tw/rwd/zh/fund/T86?date={twse_date(date)}&selectType=ALL&response=json"
    resp = await client.get(url, timeout=30.0)
    resp.raise_for_status()
    body = resp.json()
    if body.get("stat") != "OK" or not body.get("data"):
        return []

    results = []
    for row in body["data"]:
        sid = row[0].strip()
        if not re.match(r"^\d{4,6}$", sid):
            continue
        results.append({
            "stock_id": sid,
            "foreign_net": parse_tw_number(row[4]),
            "trust_net": parse_tw_number(row[10]),
        })
    return results


async def fetch_tpex_chips(client: httpx.AsyncClient, date: str) -> list[dict]:
    """TPEX 三大法人買賣超（完整欄位）。"""
    url = "https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php"
    params = {"l": "zh-tw", "d": roc_date(date), "t": "D", "o": "json"}
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
            "foreign_buy":  parse_tw_number(row[2]),
            "foreign_sell": parse_tw_number(row[3]),
            "foreign_net":  parse_tw_number(row[4]),
            "trust_buy":    parse_tw_number(row[8]),
            "trust_sell":   parse_tw_number(row[9]),
            "trust_net":    parse_tw_number(row[10]),
            "dealer_buy":   parse_tw_number(row[12]) if len(row) > 12 else 0,
            "dealer_sell":  parse_tw_number(row[13]) if len(row) > 13 else 0,
            "dealer_net":   parse_tw_number(row[11]),
        })
    return results


async def fetch_tpex_margin(client: httpx.AsyncClient) -> list[dict]:
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


async def fetch_twse_prices(client: httpx.AsyncClient, date: str) -> dict[str, float]:
    """TWSE 上市個股日收盤價。回傳 {stock_id: close_price}"""
    url = f"https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?date={twse_date(date)}&response=json"
    resp = await client.get(url, timeout=30.0)
    resp.raise_for_status()
    body = resp.json()
    prices = {}
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


async def fetch_tpex_prices(client: httpx.AsyncClient, date: str) -> dict[str, float]:
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


async def fetch_sector_mapping(client: httpx.AsyncClient, finmind_token: str | None = None) -> dict[str, str]:
    """取得 stock_id → 產業名稱 mapping（TWSE + TPEX opendata）。"""
    sector_of: dict[str, str] = {}

    twse_task = client.get("https://openapi.twse.com.tw/v1/opendata/t187ap03_L", timeout=30.0)
    tpex_task = client.get("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O", timeout=30.0)
    results = await asyncio.gather(twse_task, tpex_task, return_exceptions=True)

    if not isinstance(results[0], Exception) and results[0].status_code == 200:
        for r in results[0].json():
            sid = r.get("公司代號", "").strip()
            code = r.get("產業別", "").strip()
            if sid and code:
                sector_of[sid] = TWSE_INDUSTRY_MAP.get(code, f"產業{code}")

    if not isinstance(results[1], Exception) and results[1].status_code == 200:
        for r in results[1].json():
            sid = r.get("SecuritiesCompanyCode", "").strip()
            code = r.get("SecuritiesIndustryCode", "").strip()
            if sid and code and sid not in sector_of:
                sector_of[sid] = TWSE_INDUSTRY_MAP.get(code, f"產業{code}")

    if sector_of:
        logger.info(f"TWSE+TPEX opendata sector mapping: {len(sector_of)} stocks")

    return sector_of


# ─── Aggregation ─────────────────────────────────────────────────────────────

def aggregate_sector_flow(
    all_chips: list[dict],
    all_prices: dict[str, float],
    sector_of: dict[str, str],
) -> tuple[list[dict], int]:
    """
    按產業加總資金流向。
    回傳 (sectors_list, matched_count)
    """
    sector_agg: dict[str, dict] = {}
    matched = 0
    for chip in all_chips:
        sid = chip.get("stock_id") or chip.get("symbol")
        sector = sector_of.get(sid)
        price = all_prices.get(sid, 0)
        if not sector or price <= 0:
            continue
        matched += 1

        if sector not in sector_agg:
            sector_agg[sector] = {"foreign_net": 0.0, "trust_net": 0.0, "stock_count": 0}
        agg = sector_agg[sector]
        agg["stock_count"] += 1
        agg["foreign_net"] += chip.get("foreign_net", 0) * price / 1e8
        agg["trust_net"] += chip.get("trust_net", 0) * price / 1e8

    sectors = []
    for name, agg in sector_agg.items():
        total = agg["foreign_net"] + agg["trust_net"]
        sectors.append({
            "sector": name,
            "foreign_net": round(agg["foreign_net"], 2),
            "trust_net": round(agg["trust_net"], 2),
            "total_net": round(total, 2),
            "stock_count": agg["stock_count"],
        })
    sectors.sort(key=lambda s: s["total_net"], reverse=True)

    return sectors, matched
