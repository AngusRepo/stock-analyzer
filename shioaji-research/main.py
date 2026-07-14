from __future__ import annotations

import hmac
import math
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Header, HTTPException


API_KEY = os.environ.get("SHIOAJI_API_KEY", "")
SECRET_KEY = os.environ.get("SHIOAJI_SECRET_KEY", "")
SERVICE_TOKEN = os.environ.get("PROXY_SERVICE_TOKEN", "")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "development").strip().lower()
IS_CLOUD_RUNTIME = bool(os.environ.get("K_SERVICE") or os.environ.get("K_REVISION"))
TW_TZ = timezone(timedelta(hours=8))

api = None
connected = False
_query_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="shioaji-research")
_query_capacity = threading.BoundedSemaphore(1)


def query_timeout_seconds() -> float:
    try:
        value = float(os.environ.get("SHIOAJI_RESEARCH_QUERY_TIMEOUT_SECONDS", "45"))
    except ValueError:
        return 45.0
    return max(5.0, min(value, 90.0))


def verify_token(authorization: str | None) -> None:
    if not SERVICE_TOKEN:
        raise HTTPException(503, "Service authentication is not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    if not hmac.compare_digest(authorization[7:].strip(), SERVICE_TOKEN):
        raise HTTPException(401, "Invalid token")


def init_shioaji() -> None:
    global api, connected
    if not API_KEY or not SECRET_KEY:
        return
    import shioaji as sj

    client = sj.Shioaji(simulation=True)
    client.login(api_key=API_KEY, secret_key=SECRET_KEY)
    api = client
    connected = True


def shutdown_shioaji() -> None:
    global api, connected
    client = api
    api = None
    connected = False
    if client is not None:
        try:
            client.logout()
        except Exception:
            pass


def _normalize_datetime(value: object) -> datetime | None:
    if hasattr(value, "to_pydatetime"):
        value = value.to_pydatetime()
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            raw = float(value)
        except (TypeError, ValueError, OverflowError):
            raw = math.nan
        if math.isfinite(raw) and raw > 0:
            magnitude = abs(raw)
            divisor = 1_000_000_000 if magnitude >= 1e17 else 1_000_000 if magnitude >= 1e14 else 1_000 if magnitude >= 1e11 else 1
            try:
                parsed = datetime.fromtimestamp(raw / divisor, timezone.utc)
            except (OverflowError, OSError, ValueError):
                return None
        else:
            text = str(value).strip()
            if not text:
                return None
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=TW_TZ)
    tw_value = parsed.astimezone(TW_TZ)
    raw_minute = parsed.hour * 60 + parsed.minute
    tw_minute = tw_value.hour * 60 + tw_value.minute
    in_raw_session = 9 * 60 <= raw_minute < 13 * 60 + 30
    in_tw_session = 9 * 60 <= tw_minute < 13 * 60 + 30
    if in_raw_session and not in_tw_session:
        return parsed.replace(tzinfo=None).replace(tzinfo=TW_TZ)
    return tw_value


def _series_value(payload: object, *names: str):
    for name in names:
        if isinstance(payload, dict) and name in payload:
            return payload[name]
        value = getattr(payload, name, None)
        if value is not None:
            return value
    return None


def _float_at(values: object, index: int) -> float | None:
    try:
        value = float(values[index])
    except (IndexError, KeyError, TypeError, ValueError, OverflowError):
        return None
    return value if math.isfinite(value) else None


def _query_kbars(symbol: str, start: str, end: str):
    client = api
    if client is None or not connected:
        raise RuntimeError("shioaji_research_disconnected")
    contract = client.Contracts.Stocks.get(symbol)
    if not contract:
        raise LookupError(f"stock_contract_not_found:{symbol}")
    return client.kbars(contract, start=start, end=end)


def get_kbars(symbol: str, start: str, end: str, limit: int = 5000) -> list[dict]:
    if not _query_capacity.acquire(blocking=False):
        raise HTTPException(429, "Research query already in progress")
    try:
        future = _query_executor.submit(_query_kbars, symbol, start, end)
        try:
            payload = future.result(timeout=query_timeout_seconds())
        except FutureTimeoutError as exc:
            future.cancel()
            raise HTTPException(504, f"Historical kbar query timed out: {symbol}") from exc
    finally:
        _query_capacity.release()

    timestamps = _series_value(payload, "ts", "Time", "time")
    opens = _series_value(payload, "Open", "open")
    highs = _series_value(payload, "High", "high")
    lows = _series_value(payload, "Low", "low")
    closes = _series_value(payload, "Close", "close")
    volumes = _series_value(payload, "Volume", "volume")
    if any(values is None for values in (timestamps, opens, highs, lows, closes)):
        raise HTTPException(502, "Historical kbar payload is missing OHLC fields")

    count = min(len(timestamps), len(opens), len(highs), len(lows), len(closes), max(1, min(limit, 5000)))
    rows: list[dict] = []
    for index in range(count):
        timestamp = _normalize_datetime(timestamps[index])
        open_px = _float_at(opens, index)
        high_px = _float_at(highs, index)
        low_px = _float_at(lows, index)
        close_px = _float_at(closes, index)
        if timestamp is None or any(value is None for value in (open_px, high_px, low_px, close_px)):
            continue
        rows.append({
            "ts": timestamp.isoformat(),
            "open": open_px,
            "high": high_px,
            "low": low_px,
            "close": close_px,
            "volume": _float_at(volumes, index) if volumes is not None else 0.0,
        })
    return rows


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_shioaji()
    yield
    shutdown_shioaji()


app = FastAPI(
    title="StockVision Shioaji Research",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None if ENVIRONMENT == "production" or IS_CLOUD_RUNTIME else "/docs",
    redoc_url=None if ENVIRONMENT == "production" or IS_CLOUD_RUNTIME else "/redoc",
    openapi_url=None if ENVIRONMENT == "production" or IS_CLOUD_RUNTIME else "/openapi.json",
)


@app.get("/health")
def health():
    return {
        "status": "ok" if connected else "disconnected",
        "connected": connected,
        "owner": "historical_market_research",
    }


@app.get("/kbars/{symbol}")
def kbars_endpoint(
    symbol: str,
    start: str,
    end: str,
    limit: int = 5000,
    authorization: str | None = Header(default=None),
):
    verify_token(authorization)
    normalized_symbol = symbol.upper().strip()
    if not re.fullmatch(r"[0-9A-Z]{2,10}", normalized_symbol):
        raise HTTPException(400, "invalid Taiwan security symbol")
    try:
        start_date = datetime.fromisoformat(start).date()
        end_date = datetime.fromisoformat(end).date()
    except ValueError as exc:
        raise HTTPException(400, "start and end must be ISO dates") from exc
    if end_date < start_date or (end_date - start_date).days > 14:
        raise HTTPException(400, "historical kbar range must be between 0 and 14 days")
    rows = get_kbars(normalized_symbol, start_date.isoformat(), end_date.isoformat(), limit)
    return {
        "status": "ok",
        "symbol": normalized_symbol,
        "start": start_date.isoformat(),
        "end": end_date.isoformat(),
        "count": len(rows),
        "data": rows,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
