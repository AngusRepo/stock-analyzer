"""
shioaji-proxy — 永豐即時報價 REST Proxy（Cloud Run 部署）

功能：
  - Shioaji SDK 連線永豐，訂閱即時報價
  - 暴露 REST API 給 Cloudflare Worker 呼叫
  - 只做報價查詢，不做下單（無 activate_ca）

Endpoints：
  GET /health              → 連線狀態
  GET /quote/{symbol}      → 單支即時報價
  POST /quotes             → 批次即時報價（body: {"symbols": ["2330","2317"]})
  GET /snapshot/{symbol}   → 最新快照（成交價/量/漲跌）

部署：
  Cloud Run, min-instances=0, 盤中自動啟動
  成本：~$5/月（在 $300 免費額度內）
"""
import os
import time
import threading
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

# ── 環境變數 ────────────────────────────────────────────────────────────────
API_KEY    = os.environ.get("SHIOAJI_API_KEY", "")
SECRET_KEY = os.environ.get("SHIOAJI_SECRET_KEY", "")
PERSON_ID  = os.environ.get("SHIOAJI_PERSON_ID", "")
ACCOUNT_ID = os.environ.get("SHIOAJI_ACCOUNT_ID", "")
SERVICE_TOKEN = os.environ.get("PROXY_SERVICE_TOKEN", "")  # Worker 驗證用
ENVIRONMENT = os.environ.get("ENVIRONMENT", "development").strip().lower()

# ── 全域狀態 ────────────────────────────────────────────────────────────────
api = None
connected = False
last_ticks: dict[str, dict] = {}   # symbol → latest tick data
last_bidasks: dict[str, dict] = {}
subscribed: set[str] = set()
bidask_subscribed: set[str] = set()
# F4: Rolling price buffer for momentum confirmation (30 entries ≈ 30 min at 1 tick/min)
_price_buffer: dict[str, deque] = defaultdict(lambda: deque(maxlen=30))

TW_TZ = timezone(timedelta(hours=8))


def get_tw_now() -> datetime:
    return datetime.now(TW_TZ)


def is_market_hours() -> bool:
    now = get_tw_now()
    if now.weekday() >= 5:  # 週六日
        return False
    hour_min = now.hour * 100 + now.minute
    return 855 <= hour_min <= 1335  # 08:55 ~ 13:35（含盤前盤後緩衝）


# ── Shioaji 連線管理 ────────────────────────────────────────────────────────
def init_shioaji():
    global api, connected
    if not API_KEY or not SECRET_KEY:
        print("[Shioaji] Missing API_KEY or SECRET_KEY, skipping init")
        return

    try:
        import shioaji as sj
        # simulation=True：模擬環境（行情報價可用，不需要「正式環境」權限）
        api = sj.Shioaji(simulation=True)
        accounts = api.login(
            api_key=API_KEY,
            secret_key=SECRET_KEY,
        )
        connected = True
        print(f"[Shioaji] Connected. Accounts: {len(accounts)}")

        # 設定 tick callback
        @api.on_tick_stk_v1()
        def on_tick(exchange, tick):
            symbol = tick.code
            last_ticks[symbol] = {
                "symbol": symbol,
                "price": tick.close,
                "volume": tick.volume,
                "total_volume": tick.total_volume,
                "bid": tick.bid_price,
                "ask": tick.ask_price,
                "timestamp": tick.datetime.isoformat() if hasattr(tick, 'datetime') else None,
                "updated_at": datetime.now(TW_TZ).isoformat(),
            }
            # F4: Append to rolling buffer (deduped to ~1 entry per minute)
            buf = _price_buffer[symbol]
            now_ts = time.time()
            if not buf or now_ts - buf[-1][0] >= 30:  # at most 1 entry per 30 sec
                buf.append((now_ts, tick.close))

        @api.on_bidask_stk_v1()
        def on_bidask(exchange, bidask):
            symbol = bidask.code

            def to_float_list(values):
                return [float(v) for v in list(values or [])]

            def to_int_list(values):
                return [int(v) for v in list(values or [])]

            bid_prices = to_float_list(getattr(bidask, "bid_price", []))
            bid_volumes = to_int_list(getattr(bidask, "bid_volume", []))
            ask_prices = to_float_list(getattr(bidask, "ask_price", []))
            ask_volumes = to_int_list(getattr(bidask, "ask_volume", []))
            bid1 = bid_prices[0] if bid_prices else None
            ask1 = ask_prices[0] if ask_prices else None
            mid = (bid1 + ask1) / 2 if bid1 and ask1 else None

            last_bidasks[symbol] = {
                "symbol": symbol,
                "bid_prices": bid_prices,
                "bid_volumes": bid_volumes,
                "ask_prices": ask_prices,
                "ask_volumes": ask_volumes,
                "price": mid,
                "timestamp": bidask.datetime.isoformat() if hasattr(bidask, "datetime") else None,
                "updated_at": datetime.now(TW_TZ).isoformat(),
                "simtrade": bool(getattr(bidask, "simtrade", False)),
            }

    except Exception as e:
        print(f"[Shioaji] Init failed: {e}")
        connected = False


def shutdown_shioaji():
    global api, connected
    if api and connected:
        try:
            api.logout()
            print("[Shioaji] Logged out")
        except Exception as e:
            print(f"[Shioaji] Logout error: {e}")
        connected = False


def subscribe_symbol(symbol: str):
    """訂閱個股即時 tick"""
    global api
    if not api or not connected:
        return False
    try:
        import shioaji as sj
        contract = api.Contracts.Stocks.get(symbol)
        if not contract:
            # 嘗試 OTC
            contract = api.Contracts.Stocks.get(symbol)
        if contract:
            if symbol not in subscribed:
                api.quote.subscribe(contract, quote_type=sj.constant.QuoteType.Tick, version=sj.constant.QuoteVersion.v1)
                subscribed.add(symbol)
                print(f"[Shioaji] Tick subscribed: {symbol}")
            if symbol not in bidask_subscribed:
                api.quote.subscribe(contract, quote_type=sj.constant.QuoteType.BidAsk, version=sj.constant.QuoteVersion.v1)
                bidask_subscribed.add(symbol)
                print(f"[Shioaji] BidAsk subscribed: {symbol}")
            return True
        else:
            print(f"[Shioaji] Contract not found: {symbol}")
            return False
    except Exception as e:
        print(f"[Shioaji] Subscribe {symbol} failed: {e}")
        return False


def get_snapshot(symbol: str) -> dict | None:
    """用 snapshots API 取得最新報價（不需要預先訂閱）"""
    if not api or not connected:
        return None
    try:
        contract = api.Contracts.Stocks.get(symbol)
        if not contract:
            return None
        snapshots = api.snapshots([contract])
        if snapshots and len(snapshots) > 0:
            s = snapshots[0]
            return {
                "symbol": symbol,
                "price": s.close,
                "last": s.close,
                "close": s.close,
                "open": s.open,
                "high": s.high,
                "low": s.low,
                "volume": s.volume,
                "total_volume": s.total_volume,
                "change_price": s.change_price,
                "change_rate": s.change_rate,
                "updated_at": datetime.now(TW_TZ).isoformat(),
            }
        return None
    except Exception as e:
        print(f"[Shioaji] Snapshot {symbol} failed: {e}")
        return None


def _series_value(container, *names):
    for name in names:
        if isinstance(container, dict) and name in container:
            return container[name]
        if hasattr(container, name):
            return getattr(container, name)
    return None


def _iso_kbar_ts(value) -> str:
    if hasattr(value, "to_pydatetime"):
        value = value.to_pydatetime()
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=TW_TZ)
        return dt.astimezone(TW_TZ).isoformat()
    return str(value)


def _float_at(values, index: int) -> float | None:
    try:
        value = values[index]
        return float(value)
    except Exception:
        return None


def get_kbars(symbol: str, start: str, end: str, limit: int = 3000) -> list[dict]:
    """Return historical 1-minute kbars from Shioaji for S12 intraday structure replay."""
    if not api or not connected:
        return []
    try:
        contract = api.Contracts.Stocks.get(symbol)
        if not contract:
            return []
        kbars = api.kbars(contract, start=start, end=end)
        ts = _series_value(kbars, "ts", "Time", "time")
        opens = _series_value(kbars, "Open", "open")
        highs = _series_value(kbars, "High", "high")
        lows = _series_value(kbars, "Low", "low")
        closes = _series_value(kbars, "Close", "close")
        volumes = _series_value(kbars, "Volume", "volume")
        if ts is None or opens is None or highs is None or lows is None or closes is None:
            return []

        count = min(len(ts), len(opens), len(highs), len(lows), len(closes), max(1, int(limit)))
        rows: list[dict] = []
        for index in range(count):
            open_px = _float_at(opens, index)
            high_px = _float_at(highs, index)
            low_px = _float_at(lows, index)
            close_px = _float_at(closes, index)
            if open_px is None or high_px is None or low_px is None or close_px is None:
                continue
            rows.append({
                "ts": _iso_kbar_ts(ts[index]),
                "open": open_px,
                "high": high_px,
                "low": low_px,
                "close": close_px,
                "volume": _float_at(volumes, index) if volumes is not None else 0,
            })
        return rows
    except Exception as e:
        print(f"[Shioaji] Kbars {symbol} failed: {e}")
        return []


# ── FastAPI App ─────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: connect to Shioaji
    init_shioaji()
    yield
    # Shutdown: disconnect
    shutdown_shioaji()


app = FastAPI(title="Shioaji Quote Proxy", version="1.0.0", lifespan=lifespan)


# ── Auth Middleware ──────────────────────────────────────────────────────────
def verify_token(authorization: str | None):
    if not SERVICE_TOKEN:
        if ENVIRONMENT == "production":
            raise HTTPException(500, "PROXY_SERVICE_TOKEN not configured")
        return  # 未設定 token → 不驗證（開發模式）
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    if authorization[7:] != SERVICE_TOKEN:
        raise HTTPException(401, "Invalid token")


# ── Endpoints ───────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status": "ok" if connected else "disconnected",
        "connected": connected,
        "subscribed_count": len(subscribed),
        "bidask_subscribed_count": len(bidask_subscribed),
        "cached_ticks": len(last_ticks),
        "cached_bidasks": len(last_bidasks),
        "auth_configured": bool(SERVICE_TOKEN),
        "market_hours": is_market_hours(),
        "tw_time": get_tw_now().isoformat(),
    }


@app.get("/quote/{symbol}")
def quote(symbol: str, authorization: str | None = Header(default=None)):
    """單支即時報價 — 先查 tick cache，沒有就用 snapshot"""
    verify_token(authorization)
    symbol = symbol.upper().strip()

    # 先查已訂閱的 tick cache
    if symbol in last_ticks:
        return {"status": "ok", "source": "tick", "data": last_ticks[symbol]}

    # 自動訂閱（下次 tick 進來就有 cache）
    subscribe_symbol(symbol)

    # 用 snapshot 取即時值（不需要等 tick）
    snap = get_snapshot(symbol)
    if snap:
        return {"status": "ok", "source": "snapshot", "data": snap}

    raise HTTPException(404, f"No quote available for {symbol}")


class BatchRequest(BaseModel):
    symbols: list[str]


@app.post("/quotes")
def batch_quotes(req: BatchRequest, authorization: str | None = Header(default=None)):
    """批次即時報價"""
    verify_token(authorization)
    results: dict[str, dict] = {}

    for symbol in req.symbols:
        symbol = symbol.upper().strip()
        # 先查 tick cache
        if symbol in last_ticks:
            results[symbol] = last_ticks[symbol]
            continue
        # 訂閱 + snapshot
        subscribe_symbol(symbol)
        snap = get_snapshot(symbol)
        if snap:
            results[symbol] = snap

    return {"status": "ok", "count": len(results), "data": results}


@app.post("/snapshots")
def batch_snapshots(req: BatchRequest, authorization: str | None = Header(default=None)):
    """Batch snapshot endpoint used by the Worker execution core."""
    verify_token(authorization)
    results: dict[str, dict] = {}

    for symbol in req.symbols:
        symbol = symbol.upper().strip()
        snap = get_snapshot(symbol)
        if snap:
            results[symbol] = snap

    return {"status": "ok", "count": len(results), "data": results}


@app.get("/snapshot/{symbol}")
def snapshot_endpoint(symbol: str, authorization: str | None = Header(default=None)):
    """強制用 snapshot API 取最新值（繞過 tick cache）"""
    verify_token(authorization)
    symbol = symbol.upper().strip()
    snap = get_snapshot(symbol)
    if snap:
        return {"status": "ok", "data": snap}
    raise HTTPException(404, f"No snapshot for {symbol}")


@app.get("/kbars/{symbol}")
def kbars_endpoint(
    symbol: str,
    start: str | None = None,
    end: str | None = None,
    limit: int = 3000,
    authorization: str | None = Header(default=None),
):
    """Historical 1-minute kbars for intraday structure replay."""
    verify_token(authorization)
    symbol = symbol.upper().strip()
    end_date = end or get_tw_now().date().isoformat()
    start_date = start or (get_tw_now() - timedelta(days=7)).date().isoformat()
    rows = get_kbars(symbol, start_date, end_date, limit=max(1, min(int(limit), 5000)))
    return {
        "status": "ok",
        "symbol": symbol,
        "start": start_date,
        "end": end_date,
        "count": len(rows),
        "data": rows,
    }


# ── F4: Trend endpoint（買入二次確認用）────────────────────────────────────
@app.get("/trend/{symbol}")
def trend(symbol: str, minutes: int = 5, authorization: str | None = Header(default=None)):
    """回傳近 N 分鐘價格趨勢（slope + prices），用於買入二次確認。"""
    verify_token(authorization)
    symbol = symbol.upper().strip()
    buf = _price_buffer.get(symbol, deque())
    cutoff = time.time() - minutes * 60
    recent = [(ts, px) for ts, px in buf if ts >= cutoff]

    if len(recent) >= 2:
        slope_5min = (recent[-1][1] - recent[0][1]) / recent[0][1]  # 5 min return
    elif symbol in last_ticks:
        # 沒有 rolling buffer 但有 tick → 用 snapshot fallback
        snap = get_snapshot(symbol)
        slope_5min = snap["change_rate"] / 100 if snap and snap.get("change_rate") is not None else 0
    else:
        slope_5min = 0

    return {
        "symbol": symbol,
        "slope_5min": round(slope_5min, 6),
        "prices": [px for _, px in recent],
        "count": len(recent),
        "minutes": minutes,
    }


# ── Market Risk：盤中即時大盤風險 ──────────────────────────────────────────
# 用加權指數 snapshot 計算即時風險等級
# Worker intraday-check 觸價前讀此 endpoint
_market_risk_cache: dict = {}
_market_risk_ts: float = 0

@app.get("/market-risk")
def market_risk(authorization: str | None = Header(default=None)):
    """
    即時大盤風險評估（快取 60 秒）
    基於加權指數即時跌幅 + 量比 判斷 risk_level: low / medium / high
    """
    verify_token(authorization)
    global _market_risk_cache, _market_risk_ts

    # 60 秒快取
    if time.time() - _market_risk_ts < 60 and _market_risk_cache:
        return _market_risk_cache

    if not api or not connected:
        return {"status": "error", "message": "Shioaji not connected", "risk_level": "unknown"}

    try:
        # 取加權指數 snapshot（001 = TAIEX）
        tse_contract = api.Contracts.Indexs.TSE.get("001")
        if not tse_contract:
            return {"status": "error", "message": "Cannot find TAIEX contract", "risk_level": "unknown"}

        snapshots = api.snapshots([tse_contract])
        if not snapshots or len(snapshots) == 0:
            return {"status": "error", "message": "No TAIEX snapshot", "risk_level": "unknown"}

        s = snapshots[0]
        close = s.close
        change_rate = s.change_rate  # 漲跌幅 %
        total_volume = s.total_volume  # 成交量（張）

        # 計算 risk_level
        # 規則引擎（Phase 1，後續可升級為 LightGBM）
        risk_level = "low"
        risk_reasons = []

        # 1. 跌幅判斷（絕對值 + 相對值）
        if change_rate <= -2.0:
            risk_level = "high"
            risk_reasons.append(f"大盤跌 {change_rate:.1f}%（急跌）")
        elif change_rate <= -1.0:
            risk_level = "medium" if risk_level == "low" else risk_level
            risk_reasons.append(f"大盤跌 {change_rate:.1f}%")

        # 2. 量能判斷（相對於時間比例的預期量）
        now = get_tw_now()
        market_minutes = (now.hour * 60 + now.minute) - 9 * 60  # 09:00 開始
        if market_minutes > 0:
            # 台股日均量約 3000~5000 億，用 total_volume 相對時間比例判斷
            expected_pct = min(market_minutes / 270, 1.0)  # 270 分鐘 = 4.5 小時
            # 量能過低 = 空頭信號（市場觀望或恐慌性低量）
            # 這裡用簡化判斷，後續可改為 vs 20 日均量
            if expected_pct > 0.2 and total_volume < 100_000:  # 粗估：<10 萬張 = 極低量
                risk_level = "medium" if risk_level == "low" else risk_level
                risk_reasons.append("量能偏低")

        result = {
            "status": "ok",
            "risk_level": risk_level,
            "index_price": close,
            "change_rate": round(change_rate, 2),
            "total_volume": total_volume,
            "risk_reasons": risk_reasons,
            "updated_at": datetime.now(TW_TZ).isoformat(),
        }
        _market_risk_cache = result
        _market_risk_ts = time.time()
        return result

    except Exception as e:
        print(f"[MarketRisk] Failed: {e}")
        return {"status": "error", "message": str(e), "risk_level": "unknown"}


# ── 五檔報價 + Orderbook Features ─────────────────────────────────────────
@app.get("/orderbook/{symbol}")
def orderbook(symbol: str, authorization: str | None = Header(default=None)):
    """Return latest streaming BidAsk L5 depth and derived orderbook features."""
    verify_token(authorization)
    symbol = symbol.upper().strip()

    try:
        if not api or not connected:
            raise HTTPException(503, "Shioaji not connected")

        if symbol not in last_bidasks:
            if not subscribe_symbol(symbol):
                raise HTTPException(404, f"Contract not found: {symbol}")
            time.sleep(0.2)

        depth = last_bidasks.get(symbol)
        if not depth:
            return {
                "status": "no_depth",
                "symbol": symbol,
                "depth_available": False,
                "price": None,
                "bid_prices": [],
                "bid_volumes": [],
                "ask_prices": [],
                "ask_volumes": [],
                "features": {
                    "bid_ask_imbalance": None,
                    "spread_pct": None,
                    "bid_concentration": None,
                },
                "updated_at": datetime.now(TW_TZ).isoformat(),
            }

        bid_prices = depth["bid_prices"][:5]
        bid_volumes = depth["bid_volumes"][:5]
        ask_prices = depth["ask_prices"][:5]
        ask_volumes = depth["ask_volumes"][:5]

        if len(bid_prices) == 0 and len(ask_prices) == 0:
            raise HTTPException(404, f"Contract not found: {symbol}")

        total_bid_vol = sum(bid_volumes) if bid_volumes else 0
        total_ask_vol = sum(ask_volumes) if ask_volumes else 0
        total_vol = total_bid_vol + total_ask_vol

        # Bid-Ask Imbalance: 正值 = 買方強，負值 = 賣方強
        imbalance = (total_bid_vol - total_ask_vol) / total_vol if total_vol > 0 else 0

        # Spread: 內外盤價差比例
        bid1 = bid_prices[0] if bid_prices else 0
        ask1 = ask_prices[0] if ask_prices else 0
        mid = (bid1 + ask1) / 2 if bid1 and ask1 else depth.get("price") or 0
        spread_pct = ((ask1 - bid1) / mid * 100) if mid > 0 and bid1 and ask1 else 0

        # Bid Concentration: 內盤第一檔集中度（大單守護）
        bid_concentration = (bid_volumes[0] / total_bid_vol) if total_bid_vol > 0 and bid_volumes else 0

        return {
            "status": "ok",
            "symbol": symbol,
            "depth_available": len(bid_prices) >= 5 and len(ask_prices) >= 5,
            "price": depth.get("price"),
            "bid_prices": bid_prices,
            "bid_volumes": bid_volumes,
            "ask_prices": ask_prices,
            "ask_volumes": ask_volumes,
            "features": {
                "bid_ask_imbalance": round(imbalance, 4),
                "spread_pct": round(spread_pct, 4),
                "bid_concentration": round(bid_concentration, 4),
            },
            "updated_at": depth.get("updated_at") or datetime.now(TW_TZ).isoformat(),
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[Orderbook] {symbol} failed: {e}")
        raise HTTPException(500, str(e))


# ── TWSE/TPEX Chips Proxy（CF Workers IP 被擋，透過 GCP proxy）────────────────

class ChipsRequest(BaseModel):
    date: str  # YYYY-MM-DD

@app.post("/twse-chips")
async def twse_chips(req: ChipsRequest):
    """Proxy TWSE institutional trading data (T86) for CF Workers"""
    import httpx, re
    d = req.date.replace("-", "")
    chips = []
    margins = []

    # 三大法人買賣超 (T86)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            url = f"https://www.twse.com.tw/rwd/zh/fund/T86?date={d}&selectType=ALL&response=json"
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            data = r.json()
            if data.get("stat") == "OK" and data.get("data"):
                parse = lambda s: int(re.sub(r"[,\s]", "", str(s)) or "0") if s else 0
                for row in data["data"]:
                    sym = str(row[0]).strip()
                    if not re.match(r"^\d{4,6}$", sym):
                        continue
                    chips.append({
                        "symbol": sym,
                        "foreign_buy": parse(row[2]), "foreign_sell": parse(row[3]), "foreign_net": parse(row[4]),
                        "trust_buy": parse(row[8]), "trust_sell": parse(row[9]), "trust_net": parse(row[10]),
                        "dealer_buy": parse(row[12]), "dealer_sell": parse(row[13]), "dealer_net": parse(row[11]),
                    })
    except Exception as e:
        print(f"[TWSE-Chips] T86 failed: {e}")

    # 融資融券 (MI_MARGN)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            url = f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date={d}&selectType=ALL&response=json"
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            data = r.json()
            tables = data.get("tables", [])
            if data.get("stat") == "OK" and len(tables) > 1 and tables[1].get("data"):
                parse = lambda s: int(re.sub(r"[,\s]", "", str(s)) or "0") if s else 0
                for row in tables[1]["data"]:
                    sym = str(row[0]).strip()
                    if not re.match(r"^\d{4,6}$", sym):
                        continue
                    margins.append({
                        "symbol": sym,
                        "margin_buy": parse(row[2]), "margin_sell": parse(row[3]),
                        "margin_balance": parse(row[6]),
                        "short_buy": parse(row[8]), "short_sell": parse(row[9]),
                        "short_balance": parse(row[12]),
                    })
    except Exception as e:
        print(f"[TWSE-Chips] MI_MARGN failed: {e}")

    return {"chips": chips, "margins": margins, "date": req.date}


@app.post("/tpex-chips")
async def tpex_chips(req: ChipsRequest):
    """Proxy TPEX institutional trading data for CF Workers (TPEX blocks CF IPs)"""
    import httpx
    parts = req.date.split("-")
    roc_year = int(parts[0]) - 1911
    roc_date = f"{roc_year}/{parts[1]}/{parts[2]}"

    chips = []
    margins = []

    # 1. 三大法人買賣超
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            url = f"https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&d={roc_date}&se=EW&t=D&o=json"
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            data = r.json()
            rows = data.get("tables", [{}])[0].get("data", [])
            import re
            parse = lambda s: int(re.sub(r"[,\s]", "", str(s)) or "0") if s else 0
            for row in rows:
                sym = str(row[0]).strip()
                if not re.match(r"^\d{4}$", sym):
                    continue
                chips.append({
                    "symbol": sym,
                    "foreign_buy": parse(row[2]), "foreign_sell": parse(row[3]), "foreign_net": parse(row[4]),
                    "trust_buy": parse(row[11]), "trust_sell": parse(row[12]), "trust_net": parse(row[13]),
                    "dealer_buy": parse(row[14]) + parse(row[17]),
                    "dealer_sell": parse(row[15]) + parse(row[18]),
                    "dealer_net": parse(row[20]),
                })
    except Exception as e:
        print(f"[TPEX-Chips] 3insti failed: {e}")

    # 2. 融資融券
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            url = f"https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&d={roc_date}&o=json"
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            data = r.json()
            rows = data.get("tables", [{}])[0].get("data", [])
            import re
            parse = lambda s: int(re.sub(r"[,\s]", "", str(s)) or "0") if s else 0
            for row in rows:
                sym = str(row[0]).strip()
                if not re.match(r"^\d{4}$", sym):
                    continue
                margins.append({
                    "symbol": sym,
                    "margin_buy": parse(row[2]), "margin_sell": parse(row[3]),
                    "margin_balance": parse(row[4]),
                    "short_buy": parse(row[8]), "short_sell": parse(row[9]),
                    "short_balance": parse(row[10]),
                })
    except Exception as e:
        print(f"[TPEX-Chips] margin failed: {e}")

    return {"chips": chips, "margins": margins, "date": req.date}


# ── Entry Point ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
