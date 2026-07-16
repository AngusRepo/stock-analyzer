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
import math
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
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
last_odd_bidasks: dict[str, dict] = {}
minute_bars: dict[str, deque] = defaultdict(lambda: deque(maxlen=360))
bidask_stats: dict[str, dict] = {}
odd_bidask_stats: dict[str, dict] = {}
subscribed: set[str] = set()
bidask_subscribed: set[str] = set()
odd_bidask_subscribed: set[str] = set()
watched_orderbook_symbols: dict[str, float] = {}
watched_odd_orderbook_symbols: dict[str, float] = {}
subscription_recovery: dict[str, dict] = {}
_state_lock = threading.RLock()
_session_call_lock = threading.Lock()
_broker_query_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="shioaji-broker-query")
_broker_query_capacity = threading.BoundedSemaphore(1)
_streaming_control_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="shioaji-streaming-control")
_streaming_control_capacity = threading.BoundedSemaphore(1)
_watchdog_stop = threading.Event()
_watchdog_thread: threading.Thread | None = None
_session_epoch = 0
_process_poisoned = False
_process_poison_reason: str | None = None
_process_poisoned_at: str | None = None
_process_exit_scheduled = False
_broker_query_timeout_count = 0
_streaming_control_timeout_count = 0
_streaming_control_inflight = False
_last_streaming_control_timeout_label: str | None = None
_last_streaming_control_timeout_at: str | None = None
_last_reconnect_attempt_at = 0.0
_reconnect_count = 0
_last_reconnect_reason: str | None = None
_last_reconnect_at: str | None = None
# F4: Rolling price buffer for momentum confirmation (30 entries ≈ 30 min at 1 tick/min)
_price_buffer: dict[str, deque] = defaultdict(lambda: deque(maxlen=30))

TW_TZ = timezone(timedelta(hours=8))
TW_SESSION_OPEN_MINUTE = 9 * 60
TW_SESSION_CLOSE_MINUTE = 13 * 60 + 30


def get_tw_now() -> datetime:
    return datetime.now(TW_TZ)


def _regular_session_wall_clock(value: datetime) -> bool:
    minute = value.hour * 60 + value.minute
    return TW_SESSION_OPEN_MINUTE <= minute < TW_SESSION_CLOSE_MINUTE


def _epoch_kbar_datetime(value) -> datetime | None:
    try:
        raw = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(raw) or raw <= 0:
        return None
    magnitude = abs(raw)
    if magnitude >= 1e17:
        seconds = raw / 1_000_000_000
    elif magnitude >= 1e14:
        seconds = raw / 1_000_000
    elif magnitude >= 1e11:
        seconds = raw / 1_000
    else:
        seconds = raw
    try:
        return datetime.fromtimestamp(seconds, timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _normalize_kbar_datetime(value) -> datetime | None:
    if hasattr(value, "to_pydatetime"):
        value = value.to_pydatetime()
    if not isinstance(value, datetime):
        text = str(value).strip()
        if not text:
            return None
        epoch_dt = _epoch_kbar_datetime(text)
        if epoch_dt is not None:
            value = epoch_dt
        else:
            try:
                value = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return None
    dt = value
    if dt.tzinfo is None:
        return dt.replace(tzinfo=TW_TZ)
    tw_dt = dt.astimezone(TW_TZ)
    if _regular_session_wall_clock(dt) and not _regular_session_wall_clock(tw_dt):
        return dt.replace(tzinfo=None).replace(tzinfo=TW_TZ)
    return tw_dt


def orderbook_max_age_ms() -> int:
    try:
        value = int(os.environ.get("SHIOAJI_ORDERBOOK_MAX_AGE_MS", "1500"))
    except ValueError:
        return 1500
    return max(500, min(value, 60_000))


def orderbook_refresh_wait_seconds() -> float:
    try:
        value = float(os.environ.get("SHIOAJI_ORDERBOOK_REFRESH_WAIT_SECONDS", "2.0"))
    except ValueError:
        return 2.0
    return max(0.1, min(value, 3.0))


def parse_quote_time(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TW_TZ)
    return dt.astimezone(TW_TZ)


def orderbook_source_time(depth: dict | None) -> datetime | None:
    if not depth:
        return None
    return parse_quote_time(depth.get("timestamp") or depth.get("source_time") or depth.get("updated_at"))


def orderbook_confirmation_time(depth: dict | None) -> datetime | None:
    if not depth:
        return None
    return parse_quote_time(depth.get("confirmed_at") or depth.get("updated_at") or depth.get("timestamp"))


def orderbook_age_ms(depth: dict | None) -> int | None:
    confirmation_time = orderbook_confirmation_time(depth)
    if confirmation_time is None:
        return None
    return int(max(0, (get_tw_now() - confirmation_time).total_seconds() * 1000))


def orderbook_source_age_ms(depth: dict | None) -> int | None:
    source_time = orderbook_source_time(depth)
    if source_time is None:
        return None
    return int(max(0, (get_tw_now() - source_time).total_seconds() * 1000))


def orderbook_is_fresh(depth: dict | None) -> bool:
    age = orderbook_age_ms(depth)
    return age is not None and age <= orderbook_max_age_ms()


def is_market_hours() -> bool:
    now = get_tw_now()
    if now.weekday() >= 5:  # 週六日
        return False
    hour_min = now.hour * 100 + now.minute
    return 855 <= hour_min <= 1335  # 08:55 ~ 13:35（含盤前盤後緩衝）


# ── Shioaji 連線管理 ────────────────────────────────────────────────────────
def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


def session_call_lock_timeout_seconds() -> float:
    return _env_float("SHIOAJI_SESSION_CALL_LOCK_TIMEOUT_SECONDS", 0.25, 0.05, 2.0)


def broker_query_timeout_seconds() -> float:
    return _env_float("SHIOAJI_BROKER_QUERY_TIMEOUT_SECONDS", 2.0, 0.25, 5.0)


def streaming_control_timeout_seconds() -> float:
    return _env_float("SHIOAJI_STREAMING_CONTROL_TIMEOUT_SECONDS", 12.0, 0.25, 30.0)


def tick_max_age_ms() -> int:
    return _env_int("SHIOAJI_TICK_MAX_AGE_MS", 1500, 500, 60_000)


def tick_age_ms(tick: dict | None) -> int | None:
    if not tick:
        return None
    received_at = parse_quote_time(tick.get("updated_at"))
    if received_at is None:
        return None
    return int(max(0, (get_tw_now() - received_at).total_seconds() * 1000))


def tick_is_fresh(tick: dict | None) -> bool:
    age = tick_age_ms(tick)
    return age is not None and age <= tick_max_age_ms()


def _tick_event_datetime(value) -> datetime:
    dt = parse_quote_time(value)
    return dt if dt is not None else get_tw_now()


def update_minute_bar(symbol: str, tick: dict) -> None:
    price = tick.get("price")
    if price is None:
        return
    event_time = _tick_event_datetime(tick.get("timestamp"))
    if not _regular_session_wall_clock(event_time):
        return
    bucket = event_time.replace(second=0, microsecond=0)
    volume = int(tick.get("volume") or 0)
    bars = minute_bars[symbol]
    if bars and bars[-1]["ts"] == bucket.isoformat():
        bar = bars[-1]
        bar["high"] = max(float(bar["high"]), float(price))
        bar["low"] = min(float(bar["low"]), float(price))
        bar["close"] = float(price)
        bar["volume"] = int(bar.get("volume") or 0) + volume
        bar["last_event_at"] = tick.get("updated_at")
        bar["session_epoch"] = tick.get("session_epoch")
        return
    bars.append({
        "ts": bucket.isoformat(),
        "open": float(price),
        "high": float(price),
        "low": float(price),
        "close": float(price),
        "volume": volume,
        "last_event_at": tick.get("updated_at"),
        "session_epoch": tick.get("session_epoch"),
        "source": "streaming_tick_accumulator",
    })


def completed_streaming_bars(symbol: str, start: str, end: str, limit: int) -> list[dict]:
    now_bucket = get_tw_now().replace(second=0, microsecond=0)
    with _state_lock:
        rows = [dict(row) for row in minute_bars.get(symbol, ())]
    completed = []
    for row in rows:
        dt = parse_quote_time(row.get("ts"))
        if dt is None or dt >= now_bucket:
            continue
        trade_date = dt.date().isoformat()
        if start <= trade_date <= end:
            completed.append({**row, "completed": True})
    return completed[-max(1, min(int(limit), 5000)):]


def market_risk_proxy_symbol() -> str:
    return os.environ.get("SHIOAJI_MARKET_RISK_SYMBOL", "0050").strip().upper() or "0050"


def _terminate_poisoned_process() -> None:
    os._exit(70)


def poison_process(reason: str, *, exit_delay_seconds: float = 0.25) -> None:
    """Fail the whole broker owner after an uninterruptible SDK call times out.

    Python cannot safely cancel a running Shioaji SDK thread. Keeping the
    process alive would leave the single broker session lock/executor occupied
    forever, so Cloud Run must replace the poisoned instance.
    """
    global connected, _process_poisoned, _process_poison_reason
    global _process_poisoned_at, _process_exit_scheduled
    with _state_lock:
        if _process_poisoned:
            return
        _process_poisoned = True
        _process_poison_reason = reason
        _process_poisoned_at = get_tw_now().isoformat()
        connected = False
        if _process_exit_scheduled:
            return
        _process_exit_scheduled = True
    print(f"[Shioaji] Process poisoned; requesting replacement: {reason}", flush=True)
    timer = threading.Timer(max(0.0, exit_delay_seconds), _terminate_poisoned_process)
    timer.daemon = True
    timer.start()


def run_broker_query(callable_, label: str):
    """Run one blocking request-type SDK call with bounded queueing and fail-fast timeout."""
    global _broker_query_timeout_count
    if _process_poisoned:
        print(f"[Shioaji] Broker process poisoned; reject: {label}")
        return None
    if not _broker_query_capacity.acquire(blocking=False):
        print(f"[Shioaji] Broker query busy; reject: {label}")
        return None

    def invoke():
        if not _session_call_lock.acquire(timeout=session_call_lock_timeout_seconds()):
            return None
        try:
            return callable_()
        finally:
            _session_call_lock.release()

    future = _broker_query_executor.submit(invoke)
    future.add_done_callback(lambda _future: _broker_query_capacity.release())
    try:
        return future.result(timeout=broker_query_timeout_seconds())
    except FutureTimeoutError:
        _broker_query_timeout_count += 1
        future.cancel()
        print(f"[Shioaji] Broker query timeout: {label}", flush=True)
        poison_process(f"broker_query_timeout:{label}")
        return None


def streaming_control_busy() -> bool:
    with _state_lock:
        return _streaming_control_inflight


def run_streaming_control(callable_, label: str):
    """Serialize streaming subscribe operations without poisoning the broker owner.

    Shioaji subscribe can legitimately take longer than request-style snapshot
    calls while the quote channel is warming. A timed-out subscribe remains the
    owner of this lane until it actually returns; watchdog recovery must not
    start another session operation meanwhile.
    """
    global _streaming_control_inflight, _streaming_control_timeout_count
    global _last_streaming_control_timeout_label, _last_streaming_control_timeout_at
    if _process_poisoned:
        return None
    if not _streaming_control_capacity.acquire(blocking=False):
        print(f"[Shioaji] Streaming control busy; defer: {label}")
        return None

    with _state_lock:
        _streaming_control_inflight = True

    def invoke():
        if not _session_call_lock.acquire(timeout=session_call_lock_timeout_seconds()):
            return None
        try:
            return callable_()
        finally:
            _session_call_lock.release()

    def release_lane(_future) -> None:
        global _streaming_control_inflight
        with _state_lock:
            _streaming_control_inflight = False
        _streaming_control_capacity.release()

    future = _streaming_control_executor.submit(invoke)
    future.add_done_callback(release_lane)
    try:
        return future.result(timeout=streaming_control_timeout_seconds())
    except FutureTimeoutError:
        with _state_lock:
            _streaming_control_timeout_count += 1
            _last_streaming_control_timeout_label = label
            _last_streaming_control_timeout_at = get_tw_now().isoformat()
        print(f"[Shioaji] Streaming control still pending after timeout: {label}", flush=True)
        return None


def normalize_lot_type(value: str | None) -> str:
    return "odd_lot" if str(value or "").strip().lower() in {"odd", "odd_lot", "intraday_odd"} else "board_lot"


def _depth_store(lot_type: str) -> dict[str, dict]:
    return last_odd_bidasks if normalize_lot_type(lot_type) == "odd_lot" else last_bidasks


def _stats_store(lot_type: str) -> dict[str, dict]:
    return odd_bidask_stats if normalize_lot_type(lot_type) == "odd_lot" else bidask_stats


def watchdog_enabled() -> bool:
    return os.environ.get("SHIOAJI_WATCHDOG_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}


def watchdog_interval_seconds() -> float:
    return _env_float("SHIOAJI_WATCHDOG_INTERVAL_SECONDS", 2.0, 0.5, 30.0)


def orderbook_watch_ttl_seconds() -> float:
    return _env_float("SHIOAJI_ORDERBOOK_WATCH_TTL_SECONDS", 3600.0, 60.0, 8 * 3600.0)


def orderbook_recovery_cooldown_seconds() -> float:
    return _env_float("SHIOAJI_ORDERBOOK_RECOVERY_COOLDOWN_SECONDS", 8.0, 1.0, 120.0)


def orderbook_symbol_recovery_after_ms() -> int:
    return _env_int("SHIOAJI_ORDERBOOK_SYMBOL_RECOVERY_AFTER_MS", 120_000, 10_000, 600_000)


def reconnect_cooldown_seconds() -> float:
    return _env_float("SHIOAJI_RECONNECT_COOLDOWN_SECONDS", 60.0, 10.0, 600.0)


def reconnect_after_consecutive_failures() -> int:
    return _env_int("SHIOAJI_RECONNECT_AFTER_CONSECUTIVE_ORDERBOOK_FAILURES", 4, 2, 20)


def reconnect_after_global_stale_seconds() -> float:
    return _env_float("SHIOAJI_RECONNECT_AFTER_GLOBAL_STALE_SECONDS", 45.0, 10.0, 300.0)


def static_watchlist_symbols() -> list[str]:
    raw = os.environ.get("SHIOAJI_ORDERBOOK_WATCHLIST", "")
    symbols = []
    for item in raw.replace(";", ",").split(","):
        symbol = item.strip().upper()
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    return symbols


def watch_orderbook_symbols(
    symbols: list[str],
    ttl_seconds: float | None = None,
    lot_type: str = "board_lot",
) -> list[str]:
    now = time.time()
    ttl = ttl_seconds if ttl_seconds is not None else orderbook_watch_ttl_seconds()
    clean: list[str] = []
    watch_store = watched_odd_orderbook_symbols if normalize_lot_type(lot_type) == "odd_lot" else watched_orderbook_symbols
    with _state_lock:
        for symbol in symbols:
            normalized = str(symbol).strip().upper()
            if not normalized or normalized in clean:
                continue
            clean.append(normalized)
            watch_store[normalized] = max(
                watch_store.get(normalized, 0),
                now + ttl,
            )
    return clean


def active_orderbook_watch_symbols(lot_type: str = "board_lot") -> list[str]:
    now = time.time()
    odd_lot = normalize_lot_type(lot_type) == "odd_lot"
    static_symbols = [] if odd_lot else static_watchlist_symbols()
    watch_store = watched_odd_orderbook_symbols if odd_lot else watched_orderbook_symbols
    with _state_lock:
        for symbol in static_symbols:
            watch_store[symbol] = max(
                watch_store.get(symbol, 0),
                now + max(orderbook_watch_ttl_seconds(), 3600.0),
            )
        expired = [
            symbol for symbol, expires_at in watch_store.items()
            if expires_at < now and symbol not in static_symbols
        ]
        for symbol in expired:
            watch_store.pop(symbol, None)
            subscription_recovery.pop(f"{normalize_lot_type(lot_type)}:{symbol}", None)
        return sorted(watch_store)


def _parse_iso_age_seconds(value: str | None) -> float | None:
    dt = parse_quote_time(value)
    if dt is None:
        return None
    return max(0.0, (get_tw_now() - dt).total_seconds())


def latest_bidask_event_age_seconds(symbols: list[str]) -> float | None:
    ages: list[float] = []
    with _state_lock:
        for symbol in symbols:
            stat = bidask_stats.get(symbol) or {}
            age = _parse_iso_age_seconds(stat.get("last_event_at"))
            if age is not None:
                ages.append(age)
    return min(ages) if ages else None


def orderbook_health_summary(symbols: list[str] | None = None, lot_type: str = "board_lot") -> dict:
    lot_type = normalize_lot_type(lot_type)
    target_symbols = symbols if symbols is not None else active_orderbook_watch_symbols(lot_type)
    depth_store = _depth_store(lot_type)
    stats_store = _stats_store(lot_type)
    fresh = 0
    stale = 0
    waiting = 0
    samples: list[dict] = []
    with _state_lock:
        for symbol in target_symbols:
            depth = depth_store.get(symbol)
            stat = stats_store.get(symbol) or {}
            if depth and orderbook_is_fresh(depth):
                fresh += 1
                status = "fresh"
            elif depth:
                stale += 1
                status = "stale"
            else:
                waiting += 1
                status = "waiting_callback"
            if len(samples) < 12:
                samples.append({
                    "symbol": symbol,
                    "status": status,
                    "quote_age_ms": orderbook_age_ms(depth),
                    "source_age_ms": orderbook_source_age_ms(depth),
                    "confirmed_at": (depth or {}).get("confirmed_at") or (depth or {}).get("updated_at"),
                    "bidask_event_count": int(stat.get("event_count") or 0),
                    "last_bidask_event_at": stat.get("last_event_at"),
                    "bid_levels": len((depth or {}).get("bid_prices") or []),
                    "ask_levels": len((depth or {}).get("ask_prices") or []),
                })
    return {
        "lot_type": lot_type,
        "watch_count": len(target_symbols),
        "fresh_bidasks": fresh,
        "stale_bidasks": stale,
        "waiting_bidasks": waiting,
        "samples": samples,
    }


def normalize_stock_tick(tick, callback_epoch: int) -> dict:
    """Normalize TickSTKv1 without assuming legacy bid/ask fields exist."""
    tick_datetime = getattr(tick, "datetime", None)
    return {
        "symbol": tick.code,
        "price": tick.close,
        "volume": tick.volume,
        "total_volume": tick.total_volume,
        "bid": getattr(tick, "bid_price", None),
        "ask": getattr(tick, "ask_price", None),
        "open": getattr(tick, "open", None),
        "high": getattr(tick, "high", None),
        "low": getattr(tick, "low", None),
        "price_chg": getattr(tick, "price_chg", None),
        "change_rate": getattr(tick, "pct_chg", None),
        "timestamp": tick_datetime.isoformat() if tick_datetime is not None else None,
        "updated_at": datetime.now(TW_TZ).isoformat(),
        "session_epoch": callback_epoch,
    }


def init_shioaji():
    global api, connected, _session_epoch
    if _process_poisoned:
        print("[Shioaji] Refusing init in poisoned process")
        return
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
        with _state_lock:
            _session_epoch += 1
            callback_epoch = _session_epoch
            connected = True
        print(f"[Shioaji] Connected. Accounts: {len(accounts)} epoch={callback_epoch}")

        # 設定 tick callback
        @api.on_tick_stk_v1()
        def on_tick(exchange, tick):
            symbol = tick.code
            with _state_lock:
                if callback_epoch != _session_epoch or _process_poisoned:
                    return
                normalized_tick = normalize_stock_tick(tick, callback_epoch)
                last_ticks[symbol] = normalized_tick
                update_minute_bar(symbol, normalized_tick)
                # F4: Append to rolling buffer (deduped to ~1 entry per minute)
                buf = _price_buffer[symbol]
                now_ts = time.time()
                if not buf or now_ts - buf[-1][0] >= 30:  # at most 1 entry per 30 sec
                    buf.append((now_ts, normalized_tick["price"]))

        @api.on_bidask_stk_v1()
        def on_bidask(exchange, bidask):
            symbol = bidask.code
            intraday_odd = bool(getattr(bidask, "intraday_odd", False))
            lot_type = "odd_lot" if intraday_odd else "board_lot"
            depth_store = _depth_store(lot_type)
            stats_store = _stats_store(lot_type)

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
            received_at = datetime.now(TW_TZ).isoformat()

            with _state_lock:
                if callback_epoch != _session_epoch or _process_poisoned:
                    return
                depth_store[symbol] = {
                    "symbol": symbol,
                    "bid_prices": bid_prices,
                    "bid_volumes": bid_volumes,
                    "ask_prices": ask_prices,
                    "ask_volumes": ask_volumes,
                    "price": mid,
                    "timestamp": bidask.datetime.isoformat() if hasattr(bidask, "datetime") else None,
                    "updated_at": received_at,
                    "confirmed_at": received_at,
                    "simtrade": bool(getattr(bidask, "simtrade", False)),
                    "intraday_odd": intraday_odd,
                    "lot_type": lot_type,
                    "session_epoch": callback_epoch,
                }
                stat = stats_store.setdefault(symbol, {"event_count": 0})
                stat["event_count"] = int(stat.get("event_count") or 0) + 1
                stat["last_event_at"] = received_at
                stat["last_source_time"] = depth_store[symbol]["timestamp"]
                stat["bid_levels"] = len(bid_prices)
                stat["ask_levels"] = len(ask_prices)
                _confirm_orderbook_recovery(symbol, depth_store[symbol], lot_type)

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


def subscribe_symbol(
    symbol: str,
    *,
    force_bidask: bool = False,
    lot_type: str = "board_lot",
):
    """Subscribe without holding callback-state locks across broker SDK calls."""
    global api
    symbol = symbol.upper().strip()
    lot_type = normalize_lot_type(lot_type)
    odd_lot = lot_type == "odd_lot"
    if not symbol or not api or not connected or _process_poisoned:
        return False
    if not is_market_hours():
        print(f"[Shioaji] Subscription deferred outside market hours: {symbol} lot={lot_type}")
        return False

    def subscribe_operation():
        import shioaji as sj
        current_api = api
        if not current_api or not connected or _process_poisoned:
            return False
        contract = current_api.Contracts.Stocks.get(symbol)
        if not contract:
            print(f"[Shioaji] Contract not found: {symbol}")
            return False

        if not odd_lot:
            with _state_lock:
                tick_needed = symbol not in subscribed
            if tick_needed:
                current_api.quote.subscribe(
                    contract,
                    quote_type=sj.constant.QuoteType.Tick,
                    version=sj.constant.QuoteVersion.v1,
                )
                with _state_lock:
                    subscribed.add(symbol)

        subscription_store = odd_bidask_subscribed if odd_lot else bidask_subscribed
        with _state_lock:
            already_subscribed = symbol in subscription_store
        if force_bidask and already_subscribed:
            try:
                current_api.quote.unsubscribe(
                    contract,
                    quote_type=sj.constant.QuoteType.BidAsk,
                    version=sj.constant.QuoteVersion.v1,
                    intraday_odd=odd_lot,
                )
            except Exception as exc:
                print(f"[Shioaji] BidAsk unsubscribe failed: {symbol} lot={lot_type} error={exc}")
            with _state_lock:
                subscription_store.discard(symbol)
            already_subscribed = False

        if not already_subscribed:
            current_api.quote.subscribe(
                contract,
                quote_type=sj.constant.QuoteType.BidAsk,
                version=sj.constant.QuoteVersion.v1,
                intraday_odd=odd_lot,
            )
            with _state_lock:
                subscription_store.add(symbol)
            print(f"[Shioaji] BidAsk subscribed: {symbol} lot={lot_type}")
        return True

    try:
        return bool(run_streaming_control(
            subscribe_operation,
            f"subscribe:{lot_type}:{symbol}:force={int(force_bidask)}",
        ))
    except Exception as exc:
        print(f"[Shioaji] Subscribe {symbol} lot={lot_type} failed: {exc}")
        return False


def _mark_orderbook_recovery(symbol: str, reason: str, lot_type: str = "board_lot") -> tuple[int, bool]:
    now = time.time()
    recovery_key = f"{normalize_lot_type(lot_type)}:{symbol}"
    with _state_lock:
        state = subscription_recovery.setdefault(recovery_key, {
            "consecutive_failures": 0,
            "last_attempt_at": 0.0,
            "next_attempt_at": 0.0,
            "last_reason": None,
            "inflight": False,
            "last_confirmed_at": None,
        })
        if bool(state.get("inflight")) or now < float(state.get("next_attempt_at") or 0.0):
            return int(state.get("consecutive_failures") or 0), False
        state["consecutive_failures"] = int(state.get("consecutive_failures") or 0) + 1
        state["last_reason"] = reason
        state["last_attempt_at"] = now
        backoff_seconds = min(
            120.0,
            orderbook_recovery_cooldown_seconds() * (2 ** max(0, int(state["consecutive_failures"]) - 1)),
        )
        state["next_attempt_at"] = now + backoff_seconds
        state["inflight"] = True
        return int(state["consecutive_failures"]), True


def _finish_orderbook_recovery(symbol: str, lot_type: str = "board_lot") -> None:
    recovery_key = f"{normalize_lot_type(lot_type)}:{symbol}"
    with _state_lock:
        state = subscription_recovery.get(recovery_key)
        if state:
            state["inflight"] = False


def _confirm_orderbook_recovery(symbol: str, depth: dict, lot_type: str = "board_lot") -> None:
    bid_prices = list(depth.get("bid_prices") or [])
    ask_prices = list(depth.get("ask_prices") or [])
    if not bid_prices or not ask_prices:
        return
    recovery_key = f"{normalize_lot_type(lot_type)}:{symbol}"
    with _state_lock:
        state = subscription_recovery.setdefault(recovery_key, {})
        state["consecutive_failures"] = 0
        state["next_attempt_at"] = 0.0
        state["last_reason"] = None
        state["last_confirmed_at"] = depth.get("confirmed_at") or depth.get("updated_at")


def reset_shioaji_connection(reason: str) -> bool:
    global api, connected, _last_reconnect_attempt_at, _reconnect_count, _last_reconnect_reason, _last_reconnect_at
    if _process_poisoned:
        return False
    if streaming_control_busy():
        print(f"[Shioaji] Reconnect deferred while streaming control is active: {reason}")
        return False
    now = time.time()
    with _state_lock:
        if now - _last_reconnect_attempt_at < reconnect_cooldown_seconds():
            return False
        _last_reconnect_attempt_at = now
        old_api = api
        api = None
        connected = False
        subscribed.clear()
        bidask_subscribed.clear()
        odd_bidask_subscribed.clear()
        last_ticks.clear()
        last_bidasks.clear()
        last_odd_bidasks.clear()
        bidask_stats.clear()
        odd_bidask_stats.clear()
        subscription_recovery.clear()
        _price_buffer.clear()

    if old_api:
        try:
            old_api.logout()
        except Exception as e:
            print(f"[Shioaji] Logout during reconnect failed: {e}")

    print(f"[Shioaji] Reconnecting realtime channel: {reason}")
    init_shioaji()
    with _state_lock:
        if connected:
            _reconnect_count += 1
            _last_reconnect_reason = reason
            _last_reconnect_at = get_tw_now().isoformat()
    watch_orderbook_symbols([market_risk_proxy_symbol()], ttl_seconds=86_400)
    for symbol in active_orderbook_watch_symbols():
        recover_orderbook_symbol_async(symbol, "post_reconnect_warmup")
    for symbol in active_orderbook_watch_symbols("odd_lot"):
        recover_orderbook_symbol_async(symbol, "post_reconnect_warmup", "odd_lot")
    return connected


def _execute_orderbook_recovery(symbol: str, reason: str, lot_type: str, failures: int) -> None:
    try:
        if failures >= reconnect_after_consecutive_failures():
            print(
                f"[Shioaji] Symbol refresh remains stale; keep session and retry symbol only: "
                f"{lot_type}:{symbol} failures={failures} reason={reason}"
            )
        subscribe_symbol(symbol, force_bidask=True, lot_type=lot_type)
    finally:
        _finish_orderbook_recovery(symbol, lot_type)


def recover_orderbook_symbol(symbol: str, reason: str, lot_type: str = "board_lot") -> None:
    symbol = symbol.upper().strip()
    lot_type = normalize_lot_type(lot_type)
    if not symbol:
        return
    watch_orderbook_symbols([symbol], lot_type=lot_type)
    if streaming_control_busy():
        return
    failures, should_attempt = _mark_orderbook_recovery(symbol, reason, lot_type)
    if not should_attempt:
        return
    _execute_orderbook_recovery(symbol, reason, lot_type, failures)


def recover_orderbook_symbol_async(symbol: str, reason: str, lot_type: str = "board_lot") -> None:
    symbol = symbol.upper().strip()
    lot_type = normalize_lot_type(lot_type)
    if not symbol:
        return
    watch_orderbook_symbols([symbol], lot_type=lot_type)
    if streaming_control_busy():
        return
    failures, should_attempt = _mark_orderbook_recovery(symbol, reason, lot_type)
    if not should_attempt:
        return
    thread = threading.Thread(
        target=_execute_orderbook_recovery,
        args=(symbol, reason, lot_type, failures),
        name=f"shioaji-recover-{normalize_lot_type(lot_type)}-{symbol}",
        daemon=True,
    )
    try:
        thread.start()
    except Exception:
        _finish_orderbook_recovery(symbol, lot_type)
        raise


def _watchdog_once() -> None:
    board_symbols = active_orderbook_watch_symbols()
    odd_symbols = active_orderbook_watch_symbols("odd_lot")
    symbols = board_symbols + odd_symbols
    if not symbols:
        return
    if not connected:
        reset_shioaji_connection("watchdog_disconnected")
        return

    latest_event_age = latest_bidask_event_age_seconds(symbols)
    if latest_event_age is not None and latest_event_age > reconnect_after_global_stale_seconds():
        reset_shioaji_connection(f"watchdog_global_bidask_stale:{latest_event_age:.1f}s")
        return

    for lot_type, target_symbols in (("board_lot", board_symbols), ("odd_lot", odd_symbols)):
        depth_store = _depth_store(lot_type)
        for symbol in target_symbols:
            depth = depth_store.get(symbol)
            bid_prices = list((depth or {}).get("bid_prices") or [])
            ask_prices = list((depth or {}).get("ask_prices") or [])
            confirmation_age_ms = orderbook_age_ms(depth)
            if (
                depth
                and bid_prices
                and ask_prices
                and confirmation_age_ms is not None
                and confirmation_age_ms <= orderbook_symbol_recovery_after_ms()
            ):
                continue
            reason = "watchdog_waiting_callback" if not depth else "watchdog_subscription_unconfirmed"
            recover_orderbook_symbol(symbol, reason, lot_type)


def _watchdog_loop() -> None:
    while not _watchdog_stop.wait(watchdog_interval_seconds()):
        if not is_market_hours():
            continue
        try:
            _watchdog_once()
        except Exception as e:
            print(f"[Shioaji] Watchdog failed: {e}")


def start_watchdog() -> None:
    global _watchdog_thread
    if not watchdog_enabled():
        return
    with _state_lock:
        if _watchdog_thread and _watchdog_thread.is_alive():
            return
        _watchdog_stop.clear()
        _watchdog_thread = threading.Thread(target=_watchdog_loop, name="shioaji-orderbook-watchdog", daemon=True)
        _watchdog_thread.start()
        print("[Shioaji] Orderbook watchdog started")


def stop_watchdog() -> None:
    global _watchdog_thread
    _watchdog_stop.set()
    thread = _watchdog_thread
    if thread and thread.is_alive():
        thread.join(timeout=3)
    _watchdog_thread = None


def get_snapshot(symbol: str) -> dict | None:
    """Return a fresh streaming tick snapshot without request-time SDK I/O."""
    if not connected or _process_poisoned:
        return None
    with _state_lock:
        tick = dict(last_ticks.get(symbol) or {})
    if not tick_is_fresh(tick):
        return None
    price = tick.get("price")
    return {
        **tick,
        "symbol": symbol,
        "price": price,
        "last": price,
        "close": price,
        "source": "streaming_tick_cache",
        "source_time": tick.get("timestamp"),
        "received_at": tick.get("updated_at"),
        "quote_age_ms": tick_age_ms(tick),
        "max_quote_age_ms": tick_max_age_ms(),
        "session_epoch": tick.get("session_epoch"),
    }


def _iso_kbar_ts(value) -> str:
    dt = _normalize_kbar_datetime(value)
    if dt is not None:
        return dt.isoformat()
    return str(value)


# ── FastAPI App ─────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: connect to Shioaji
    init_shioaji()
    watch_orderbook_symbols([market_risk_proxy_symbol()], ttl_seconds=86_400)
    static_symbols = active_orderbook_watch_symbols()
    start_watchdog()
    for symbol in static_symbols:
        recover_orderbook_symbol_async(symbol, "startup_warmup")
    yield
    # Shutdown: disconnect
    stop_watchdog()
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
def orderbook_recovery_health_summary() -> dict:
    now = time.time()
    with _state_lock:
        rows = [
            {
                "key": key,
                "consecutive_failures": int(state.get("consecutive_failures") or 0),
                "inflight": bool(state.get("inflight")),
                "retry_in_ms": max(0, int((float(state.get("next_attempt_at") or 0.0) - now) * 1000)),
                "last_reason": state.get("last_reason"),
                "last_confirmed_at": state.get("last_confirmed_at"),
            }
            for key, state in subscription_recovery.items()
        ]
    active = [row for row in rows if row["inflight"] or row["consecutive_failures"] > 0]
    return {
        "tracked_symbols": len(rows),
        "active_recoveries": sum(1 for row in active if row["inflight"]),
        "backoff_symbols": sum(1 for row in active if row["retry_in_ms"] > 0),
        "samples": active[:12],
    }


@app.get("/health")
def health():
    orderbook_health = orderbook_health_summary()
    market_hours = is_market_hours()
    watchdog_alive = bool(_watchdog_thread and _watchdog_thread.is_alive())
    subscription_healthy = bool(
        connected
        and not _process_poisoned
        and watchdog_alive
        and (
            not market_hours
            or (len(subscribed) > 0 and len(bidask_subscribed) > 0)
        )
    )
    execution_ready = bool(
        subscription_healthy
        and _session_epoch > 0
        and (
            not market_hours
            or (len(last_ticks) > 0 and int(orderbook_health.get("fresh_bidasks") or 0) > 0)
        )
    )
    return {
        "status": "poisoned" if _process_poisoned else "ok" if connected else "disconnected",
        "connected": connected,
        "process_poisoned": _process_poisoned,
        "process_poison_reason": _process_poison_reason,
        "process_poisoned_at": _process_poisoned_at,
        "broker_query_timeout_count": _broker_query_timeout_count,
        "streaming_control_busy": streaming_control_busy(),
        "streaming_control_timeout_count": _streaming_control_timeout_count,
        "last_streaming_control_timeout_label": _last_streaming_control_timeout_label,
        "last_streaming_control_timeout_at": _last_streaming_control_timeout_at,
        "session_epoch": _session_epoch,
        "subscribed_count": len(subscribed),
        "bidask_subscribed_count": len(bidask_subscribed),
        "cached_ticks": len(last_ticks),
        "cached_bidasks": len(last_bidasks),
        "bidask_event_symbols": len(bidask_stats),
        "auth_configured": bool(SERVICE_TOKEN),
        "market_hours": market_hours,
        "watchdog_enabled": watchdog_enabled(),
        "watchdog_alive": watchdog_alive,
        "orderbook_watch": orderbook_health,
        "orderbook_recovery": orderbook_recovery_health_summary(),
        "subscription_healthy": subscription_healthy,
        "execution_ready": execution_ready,
        "reconnect_count": _reconnect_count,
        "last_reconnect_at": _last_reconnect_at,
        "last_reconnect_reason": _last_reconnect_reason,
        "tw_time": get_tw_now().isoformat(),
    }


@app.get("/quote/{symbol}")
def quote(symbol: str, authorization: str | None = Header(default=None)):
    """單支 execution 報價；只讀 streaming tick cache。"""
    verify_token(authorization)
    symbol = symbol.upper().strip()
    snap = get_snapshot(symbol)
    if snap:
        return {"status": "ok", "source": "streaming_tick_cache", "data": snap}

    watch_orderbook_symbols([symbol])
    recover_orderbook_symbol_async(symbol, "quote_cache_miss")
    tick = last_ticks.get(symbol)
    raise HTTPException(503, {
        "status": "stale_tick" if tick else "no_tick",
        "symbol": symbol,
        "quote_age_ms": tick_age_ms(tick),
        "max_quote_age_ms": tick_max_age_ms(),
        "session_epoch": _session_epoch,
        "process_poisoned": _process_poisoned,
    })


class BatchRequest(BaseModel):
    symbols: list[str]
    lot_type: str = "board_lot"


@app.post("/quotes")
def batch_quotes(req: BatchRequest, authorization: str | None = Header(default=None)):
    """批次 execution 報價；只讀 streaming tick cache。"""
    verify_token(authorization)
    results: dict[str, dict] = {}
    errors: dict[str, dict] = {}

    for symbol in req.symbols:
        symbol = symbol.upper().strip()
        snap = get_snapshot(symbol)
        if snap:
            results[symbol] = snap
        else:
            watch_orderbook_symbols([symbol])
            recover_orderbook_symbol_async(symbol, "batch_quote_cache_miss")
            tick = last_ticks.get(symbol)
            errors[symbol] = {
                "status": "stale_tick" if tick else "no_tick",
                "quote_age_ms": tick_age_ms(tick),
                "max_quote_age_ms": tick_max_age_ms(),
                "session_epoch": _session_epoch,
            }

    return {
        "status": "ok" if not errors else "partial" if results else "empty",
        "count": len(results),
        "error_count": len(errors),
        "data": results,
        "errors": errors,
        "source": "streaming_tick_cache",
        "session_epoch": _session_epoch,
    }


@app.post("/snapshots")
def batch_snapshots(req: BatchRequest, authorization: str | None = Header(default=None)):
    """相容 alias；execution snapshot 同樣只讀 streaming tick cache。"""
    return batch_quotes(req, authorization)


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
    """Completed 1-minute bars from streaming cache during execution hours."""
    verify_token(authorization)
    symbol = symbol.upper().strip()
    end_date = end or get_tw_now().date().isoformat()
    start_date = start or (get_tw_now() - timedelta(days=7)).date().isoformat()
    today = get_tw_now().date().isoformat()
    if start_date == today and end_date == today:
        rows = completed_streaming_bars(symbol, start_date, end_date, limit)
        if not rows:
            watch_orderbook_symbols([symbol])
            recover_orderbook_symbol_async(symbol, "streaming_bar_cache_miss")
        return {
            "status": "ok" if rows else "empty",
            "symbol": symbol,
            "start": start_date,
            "end": end_date,
            "count": len(rows),
            "data": rows,
            "source": "streaming_tick_accumulator",
            "completed_only": True,
            "session_epoch": _session_epoch,
        }
    raise HTTPException(503, {
        "status": "research_service_required",
        "message": "Historical kbars are isolated from the execution broker session",
        "symbol": symbol,
        "start": start_date,
        "end": end_date,
        "session_epoch": _session_epoch,
    })


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
    Execution-safe market risk. Reads a subscribed ETF proxy tick only and
    never performs a request-time Shioaji SDK call.
    """
    verify_token(authorization)
    global _market_risk_cache, _market_risk_ts

    symbol = market_risk_proxy_symbol()
    with _state_lock:
        tick = dict(last_ticks.get(symbol) or {})
    if not connected or _process_poisoned or not tick_is_fresh(tick):
        watch_orderbook_symbols([symbol], ttl_seconds=86_400)
        recover_orderbook_symbol_async(symbol, "market_risk_cache_miss")
        return {
            "status": "error",
            "message": "market_risk_stream_unavailable",
            "risk_level": "unknown",
            "source": "streaming_tick_cache",
            "proxy_symbol": symbol,
            "quote_age_ms": tick_age_ms(tick),
            "session_epoch": _session_epoch,
        }

    close = float(tick.get("price") or 0)
    change_rate = float(tick.get("change_rate") or 0)
    total_volume = int(tick.get("total_volume") or 0)
    risk_level = "low"
    risk_reasons = []
    if change_rate <= -2.0:
        risk_level = "high"
        risk_reasons.append(f"市場代理跌 {change_rate:.1f}%（急跌）")
    elif change_rate <= -1.0:
        risk_level = "medium"
        risk_reasons.append(f"市場代理跌 {change_rate:.1f}%")

    result = {
        "status": "ok",
        "risk_level": risk_level,
        "index_price": close,
        "change_rate": round(change_rate, 2),
        "total_volume": total_volume,
        "risk_reasons": risk_reasons,
        "updated_at": tick.get("updated_at"),
        "source_time": tick.get("timestamp"),
        "quote_age_ms": tick_age_ms(tick),
        "source": "streaming_tick_cache",
        "proxy_symbol": symbol,
        "session_epoch": tick.get("session_epoch"),
    }
    _market_risk_cache = result
    _market_risk_ts = time.time()
    return result


# ── 五檔報價 + Orderbook Features ─────────────────────────────────────────
def _orderbook_diagnostic(
    symbol: str,
    status: str,
    depth: dict | None = None,
    message: str | None = None,
    lot_type: str = "board_lot",
) -> dict:
    lot_type = normalize_lot_type(lot_type)
    stat = _stats_store(lot_type).get(symbol, {})
    subscription_store = odd_bidask_subscribed if lot_type == "odd_lot" else bidask_subscribed
    source_time = orderbook_source_time(depth)
    return {
        "status": status,
        "symbol": symbol,
        "lot_type": lot_type,
        "depth_available": False,
        "message": message,
        "source_time": source_time.isoformat() if source_time else None,
        "received_at": depth.get("updated_at") if depth else None,
        "confirmed_at": (depth or {}).get("confirmed_at") or (depth or {}).get("updated_at"),
        "quote_age_ms": orderbook_age_ms(depth),
        "source_age_ms": orderbook_source_age_ms(depth),
        "max_quote_age_ms": orderbook_max_age_ms(),
        "refresh_wait_seconds": orderbook_refresh_wait_seconds(),
        "subscribed": symbol in subscribed,
        "bidask_subscribed": symbol in subscription_store,
        "bid_levels": len((depth or {}).get("bid_prices") or []),
        "ask_levels": len((depth or {}).get("ask_prices") or []),
        "bidask_event_count": int(stat.get("event_count") or 0),
        "last_bidask_event_at": stat.get("last_event_at"),
        "last_bidask_source_time": stat.get("last_source_time"),
        "session_epoch": _session_epoch,
        "process_poisoned": _process_poisoned,
    }


def _wait_for_fresh_orderbook(symbol: str, lot_type: str) -> dict | None:
    deadline = time.monotonic() + orderbook_refresh_wait_seconds()
    depth_store = _depth_store(lot_type)
    while time.monotonic() < deadline:
        with _state_lock:
            depth = dict(depth_store.get(symbol) or {})
        if depth and orderbook_is_fresh(depth):
            return depth
        time.sleep(0.05)
    with _state_lock:
        depth = dict(depth_store.get(symbol) or {})
    return depth or None


def _orderbook_payload(
    symbol: str,
    *,
    refresh: bool = True,
    lot_type: str = "board_lot",
) -> tuple[int, dict]:
    symbol = symbol.upper().strip()
    lot_type = normalize_lot_type(lot_type)
    depth_store = _depth_store(lot_type)
    stats_store = _stats_store(lot_type)
    try:
        if not api or not connected:
            return 503, _orderbook_diagnostic(symbol, "proxy_disconnected", message="Shioaji not connected", lot_type=lot_type)

        watch_orderbook_symbols([symbol], lot_type=lot_type)
        depth = depth_store.get(symbol)
        if refresh and (not depth or not orderbook_is_fresh(depth)):
            recover_orderbook_symbol_async(
                symbol,
                "request_waiting_callback" if not depth else "request_stale_depth",
                lot_type,
            )
            depth = _wait_for_fresh_orderbook(symbol, lot_type)

        if not depth:
            return 503, _orderbook_diagnostic(
                symbol,
                "waiting_callback",
                message="BidAsk subscribed but no depth callback has reached cache yet",
                lot_type=lot_type,
            )

        if not orderbook_is_fresh(depth):
            return 503, _orderbook_diagnostic(symbol, "stale_depth", depth=depth, lot_type=lot_type)

        bid_prices = list(depth.get("bid_prices") or [])[:5]
        bid_volumes = list(depth.get("bid_volumes") or [])[:5]
        ask_prices = list(depth.get("ask_prices") or [])[:5]
        ask_volumes = list(depth.get("ask_volumes") or [])[:5]

        if len(bid_prices) == 0 and len(ask_prices) == 0:
            if refresh:
                recover_orderbook_symbol_async(symbol, "request_empty_depth", lot_type)
            return 503, _orderbook_diagnostic(symbol, "empty_depth", depth=depth, lot_type=lot_type)
        if len(bid_prices) == 0 or len(ask_prices) == 0:
            if refresh:
                recover_orderbook_symbol_async(symbol, "request_no_depth", lot_type)
            return 503, _orderbook_diagnostic(
                symbol,
                "no_depth",
                depth=depth,
                message="BidAsk depth is missing bid or ask side",
                lot_type=lot_type,
            )

        total_bid_vol = sum(bid_volumes) if bid_volumes else 0
        total_ask_vol = sum(ask_volumes) if ask_volumes else 0
        total_vol = total_bid_vol + total_ask_vol
        imbalance = (total_bid_vol - total_ask_vol) / total_vol if total_vol > 0 else 0
        bid1 = bid_prices[0] if bid_prices else 0
        ask1 = ask_prices[0] if ask_prices else 0
        mid = (bid1 + ask1) / 2 if bid1 and ask1 else depth.get("price") or 0
        spread_pct = ((ask1 - bid1) / mid * 100) if mid > 0 and bid1 and ask1 else 0
        bid_concentration = (bid_volumes[0] / total_bid_vol) if total_bid_vol > 0 and bid_volumes else 0
        source_time = orderbook_source_time(depth)
        stat = stats_store.get(symbol, {})

        return 200, {
            "status": "ok",
            "symbol": symbol,
            "lot_type": lot_type,
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
            "source_time": source_time.isoformat() if source_time else None,
            "received_at": depth.get("updated_at"),
            "confirmed_at": depth.get("confirmed_at") or depth.get("updated_at"),
            "quote_age_ms": orderbook_age_ms(depth),
            "source_age_ms": orderbook_source_age_ms(depth),
            "max_quote_age_ms": orderbook_max_age_ms(),
            "updated_at": depth.get("updated_at"),
            "bidask_event_count": int(stat.get("event_count") or 0),
            "last_bidask_event_at": stat.get("last_event_at"),
        }

    except Exception as e:
        print(f"[Orderbook] {symbol} failed: {e}")
        return 500, _orderbook_diagnostic(symbol, "error", message=str(e), lot_type=lot_type)


@app.get("/orderbook/{symbol}")
def orderbook(symbol: str, lot_type: str = "board_lot", authorization: str | None = Header(default=None)):
    """Return latest streaming BidAsk L5 depth and derived orderbook features."""
    verify_token(authorization)
    status_code, payload = _orderbook_payload(symbol, lot_type=lot_type)
    if status_code != 200:
        raise HTTPException(status_code, payload)
    return payload


@app.post("/orderbooks")
def batch_orderbooks(req: BatchRequest, authorization: str | None = Header(default=None)):
    """Batch orderbook endpoint used by Worker execution and S12 realtime checks."""
    verify_token(authorization)
    data: dict[str, dict] = {}
    errors: dict[str, dict] = {}
    clean_symbols = []
    for symbol in req.symbols:
        normalized = symbol.upper().strip()
        if normalized and normalized not in clean_symbols:
            clean_symbols.append(normalized)

    lot_type = normalize_lot_type(req.lot_type)
    watch_orderbook_symbols(clean_symbols, lot_type=lot_type)
    depth_store = _depth_store(lot_type)
    refresh_symbols: list[str] = []
    with _state_lock:
        for symbol in clean_symbols:
            depth = dict(depth_store.get(symbol) or {})
            if not depth or not orderbook_is_fresh(depth):
                refresh_symbols.append(symbol)

    for symbol in refresh_symbols:
        recover_orderbook_symbol_async(
            symbol,
            "request_waiting_callback" if not depth_store.get(symbol) else "request_stale_depth",
            lot_type,
        )

    if refresh_symbols:
        deadline = time.monotonic() + orderbook_refresh_wait_seconds()
        while time.monotonic() < deadline:
            with _state_lock:
                pending = [
                    symbol for symbol in refresh_symbols
                    if not orderbook_is_fresh(depth_store.get(symbol))
                ]
            if not pending:
                break
            time.sleep(0.05)

    for symbol in clean_symbols:
        status_code, payload = _orderbook_payload(symbol, refresh=False, lot_type=lot_type)
        if status_code == 200:
            data[symbol] = payload
        else:
            errors[symbol] = payload

    return {
        "status": "ok" if not errors else "partial" if data else "empty",
        "count": len(data),
        "error_count": len(errors),
        "data": data,
        "errors": errors,
        "lot_type": lot_type,
        "max_quote_age_ms": orderbook_max_age_ms(),
        "refresh_wait_seconds": orderbook_refresh_wait_seconds(),
        "orderbook_watch": orderbook_health_summary(clean_symbols, lot_type),
        "tw_time": get_tw_now().isoformat(),
    }


# ── TWSE/TPEX Chips Proxy（CF Workers IP 被擋，透過 GCP proxy）────────────────

@app.post("/orderbook/watchlist")
def orderbook_watchlist(req: BatchRequest, authorization: str | None = Header(default=None)):
    """Prewarm BidAsk subscriptions for symbols that may need executable quotes."""
    verify_token(authorization)
    lot_type = normalize_lot_type(req.lot_type)
    symbols = watch_orderbook_symbols(req.symbols, lot_type=lot_type)
    for symbol in symbols:
        recover_orderbook_symbol_async(symbol, "watchlist_prewarm", lot_type)
    return {
        "status": "ok",
        "count": len(symbols),
        "symbols": symbols,
        "lot_type": lot_type,
        "orderbook_watch": orderbook_health_summary(symbols, lot_type),
        "watch_ttl_seconds": orderbook_watch_ttl_seconds(),
        "tw_time": get_tw_now().isoformat(),
    }


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
