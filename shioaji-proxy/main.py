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
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# ── 環境變數 ────────────────────────────────────────────────────────────────
API_KEY    = os.environ.get("SHIOAJI_API_KEY", "")
SECRET_KEY = os.environ.get("SHIOAJI_SECRET_KEY", "")
PERSON_ID  = os.environ.get("SHIOAJI_PERSON_ID", "")
ACCOUNT_ID = os.environ.get("SHIOAJI_ACCOUNT_ID", "")
SERVICE_TOKEN = os.environ.get("PROXY_SERVICE_TOKEN", "")  # Worker 驗證用

# ── 全域狀態 ────────────────────────────────────────────────────────────────
api = None
connected = False
last_ticks: dict[str, dict] = {}   # symbol → latest tick data
subscribed: set[str] = set()

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
    if symbol in subscribed:
        return True
    try:
        import shioaji as sj
        contract = api.Contracts.Stocks.get(symbol)
        if not contract:
            # 嘗試 OTC
            contract = api.Contracts.Stocks.get(symbol)
        if contract:
            api.quote.subscribe(contract, quote_type=sj.constant.QuoteType.Tick, version=sj.constant.QuoteVersion.v1)
            subscribed.add(symbol)
            print(f"[Shioaji] Subscribed: {symbol}")
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
        "cached_ticks": len(last_ticks),
        "market_hours": is_market_hours(),
        "tw_time": get_tw_now().isoformat(),
    }


@app.get("/quote/{symbol}")
def quote(symbol: str, authorization: str | None = None):
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
def batch_quotes(req: BatchRequest, authorization: str | None = None):
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


@app.get("/snapshot/{symbol}")
def snapshot_endpoint(symbol: str, authorization: str | None = None):
    """強制用 snapshot API 取最新值（繞過 tick cache）"""
    verify_token(authorization)
    symbol = symbol.upper().strip()
    snap = get_snapshot(symbol)
    if snap:
        return {"status": "ok", "data": snap}
    raise HTTPException(404, f"No snapshot for {symbol}")


# ── Entry Point ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
