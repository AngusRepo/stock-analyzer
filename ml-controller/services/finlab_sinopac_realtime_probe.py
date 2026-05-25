"""Read-only FinLab Sinopac realtime quote probe.

The probe is intentionally market-data only. It may log in and subscribe to
FinLab/Sinopac realtime tick and bid/ask callbacks when explicitly allowed,
but it never creates, updates, cancels, or submits orders.
"""

from __future__ import annotations

import json
import os
import statistics
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable


SCHEMA_VERSION = "finlab-sinopac-realtime-probe-v1"
EVENT_SCHEMA_VERSION = "finlab-sinopac-realtime-probe-event-v1"
REQUIRED_SINOPAC_ENV = [
    "SHIOAJI_API_KEY",
    "SHIOAJI_CERT_PASSWORD",
    "SHIOAJI_CERT_PATH",
    "SHIOAJI_CERT_PERSON_ID",
]


def _has_secret_key(env: dict[str, str]) -> bool:
    return bool(env.get("SHIOAJI_SECRET_KEY") or env.get("SHIOAJI_API_SECRET"))


def sinopac_env_status(env: dict[str, str] | None = None) -> dict[str, Any]:
    values = env or os.environ
    missing = [key for key in REQUIRED_SINOPAC_ENV if not values.get(key)]
    if not _has_secret_key(values):
        missing.append("SHIOAJI_SECRET_KEY_OR_SHIOAJI_API_SECRET")
    cert_path = values.get("SHIOAJI_CERT_PATH")
    cert_exists = bool(cert_path and Path(cert_path).exists())
    if cert_path and not cert_exists and "SHIOAJI_CERT_PATH" not in missing:
        missing.append("SHIOAJI_CERT_PATH_EXISTS")
    return {
        "ready": len(missing) == 0,
        "missing": missing,
        "cert_path_configured": bool(cert_path),
        "cert_path_exists": cert_exists,
    }


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            seconds = float(value)
            if seconds > 10**14:
                seconds = seconds / 1_000_000
            elif seconds > 10**11:
                seconds = seconds / 1000
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        normalized = text.replace("Z", "+00:00")
        if "T" not in normalized and " " in normalized:
            normalized = normalized.replace(" ", "T", 1)
        try:
            parsed = datetime.fromisoformat(normalized)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _latency_ms(source_time: datetime | None, received_at: datetime) -> int | None:
    if source_time is None:
        return None
    return max(0, round((received_at - source_time).total_seconds() * 1000))


def _first_number(*values: Any) -> float | None:
    for value in values:
        if isinstance(value, list) and value:
            found = _first_number(*value)
            if found is not None:
                return found
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            return number
    return None


def _int_values(values: Any) -> list[int]:
    output: list[int] = []
    for value in list(values or []):
        try:
            output.append(int(value))
        except (TypeError, ValueError):
            continue
    return output


@dataclass(frozen=True)
class ProbeEvent:
    schema_version: str
    run_id: str
    provider: str
    source_type: str
    symbol: str
    received_at: str
    source_time: str | None
    latency_ms: int | None
    price: float | None = None
    best_bid: float | None = None
    best_ask: float | None = None
    bid_prices: list[float] | None = None
    ask_prices: list[float] | None = None
    bid_volumes: list[int] | None = None
    ask_volumes: list[int] | None = None
    total_volume: int | None = None
    raw: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ProbeRecorder:
    def __init__(self, *, run_id: str, output_dir: Path | None = None) -> None:
        self.run_id = run_id
        self.output_dir = output_dir
        self.events: list[ProbeEvent] = []
        self._jsonl = None
        if output_dir is not None:
            output_dir.mkdir(parents=True, exist_ok=True)
            self._jsonl = (output_dir / "events.jsonl").open("a", encoding="utf-8")

    def close(self) -> None:
        if self._jsonl is not None:
            self._jsonl.close()
            self._jsonl = None

    def record(self, event: ProbeEvent) -> None:
        self.events.append(event)
        if self._jsonl is not None:
            self._jsonl.write(json.dumps(event.to_dict(), ensure_ascii=False) + "\n")
            self._jsonl.flush()

    def record_tick(self, tick: Any) -> None:
        received_at = _utc_now()
        source_time = _parse_time(getattr(tick, "time", None))
        self.record(
            ProbeEvent(
                schema_version=EVENT_SCHEMA_VERSION,
                run_id=self.run_id,
                provider="finlab_sinopac_realtime",
                source_type="tick",
                symbol=str(getattr(tick, "stock_id", "")),
                received_at=_iso(received_at),
                source_time=_iso(source_time) if source_time else None,
                latency_ms=_latency_ms(source_time, received_at),
                price=_first_number(getattr(tick, "price", None)),
                total_volume=int(getattr(tick, "total_volume", 0) or 0),
            )
        )

    def record_bidask(self, bidask: Any) -> None:
        received_at = _utc_now()
        source_time = _parse_time(getattr(bidask, "time", None))
        bid_prices = [float(v) for v in list(getattr(bidask, "bid_prices_top5", []) or []) if float(v or 0) > 0]
        ask_prices = [float(v) for v in list(getattr(bidask, "ask_prices_top5", []) or []) if float(v or 0) > 0]
        bid_volumes = [int(v) for v in list(getattr(bidask, "bid_volumes_top5", []) or [])]
        ask_volumes = [int(v) for v in list(getattr(bidask, "ask_volumes_top5", []) or [])]
        self.record(
            ProbeEvent(
                schema_version=EVENT_SCHEMA_VERSION,
                run_id=self.run_id,
                provider="finlab_sinopac_realtime",
                source_type="bidask",
                symbol=str(getattr(bidask, "stock_id", "")),
                received_at=_iso(received_at),
                source_time=_iso(source_time) if source_time else None,
                latency_ms=_latency_ms(source_time, received_at),
                best_bid=bid_prices[0] if bid_prices else None,
                best_ask=ask_prices[0] if ask_prices else None,
                bid_prices=bid_prices[:5],
                ask_prices=ask_prices[:5],
                bid_volumes=bid_volumes[:5],
                ask_volumes=ask_volumes[:5],
            )
        )


def _percentile(values: list[int], pct: float) -> int | None:
    if not values:
        return None
    if len(values) == 1:
        return values[0]
    ordered = sorted(values)
    index = round((len(ordered) - 1) * pct)
    return ordered[index]


def summarize_events(events: Iterable[ProbeEvent]) -> dict[str, Any]:
    groups: dict[str, list[int]] = {}
    counts: dict[str, int] = {}
    stale_over_3000: dict[str, int] = {}
    for event in events:
        key = f"{event.provider}:{event.source_type}:{event.symbol}"
        counts[key] = counts.get(key, 0) + 1
        if event.latency_ms is None:
            continue
        groups.setdefault(key, []).append(event.latency_ms)
        if event.latency_ms > 3000:
            stale_over_3000[key] = stale_over_3000.get(key, 0) + 1

    latency = {}
    for key, values in groups.items():
        latency[key] = {
            "count": len(values),
            "min_ms": min(values),
            "median_ms": round(statistics.median(values)),
            "p95_ms": _percentile(values, 0.95),
            "max_ms": max(values),
            "stale_over_3000_count": stale_over_3000.get(key, 0),
        }

    return {
        "schema_version": SCHEMA_VERSION,
        "event_count": sum(counts.values()),
        "counts": counts,
        "latency": latency,
    }


def _snapshot_quote_time(snapshot: dict[str, Any]) -> Any:
    for key in ("ts", "time", "datetime", "updated_at"):
        if snapshot.get(key):
            return snapshot[key]
    return None


def poll_proxy_snapshot(
    *,
    proxy_url: str,
    token: str | None,
    symbols: list[str],
    recorder: ProbeRecorder,
    timeout_seconds: int = 5,
) -> None:
    payload = json.dumps({"symbols": symbols}).encode("utf-8")
    request = urllib.request.Request(
        proxy_url.rstrip("/") + "/snapshots",
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        recorder.record(
            ProbeEvent(
                schema_version=EVENT_SCHEMA_VERSION,
                run_id=recorder.run_id,
                provider="shioaji_proxy_snapshot",
                source_type="error",
                symbol=",".join(symbols),
                received_at=_iso(_utc_now()),
                source_time=None,
                latency_ms=None,
                raw={"error": type(exc).__name__, "message": str(exc)[:200]},
            )
        )
        return

    data = body.get("data") if isinstance(body, dict) else {}
    if not isinstance(data, dict):
        return
    received_at = _utc_now()
    for symbol, snapshot in data.items():
        if not isinstance(snapshot, dict):
            continue
        source_time = _parse_time(_snapshot_quote_time(snapshot))
        recorder.record(
            ProbeEvent(
                schema_version=EVENT_SCHEMA_VERSION,
                run_id=recorder.run_id,
                provider="shioaji_proxy_snapshot",
                source_type="snapshot",
                symbol=str(symbol),
                received_at=_iso(received_at),
                source_time=_iso(source_time) if source_time else None,
                latency_ms=_latency_ms(source_time, received_at),
                price=_first_number(
                    snapshot.get("last"),
                    snapshot.get("price"),
                    snapshot.get("last_price"),
                    snapshot.get("trade_price"),
                    snapshot.get("close"),
                ),
                best_bid=_first_number(snapshot.get("bid"), snapshot.get("bid_price"), snapshot.get("best_bid")),
                best_ask=_first_number(snapshot.get("ask"), snapshot.get("ask_price"), snapshot.get("best_ask")),
            )
        )
    for symbol in symbols:
        poll_proxy_orderbook(
            proxy_url=proxy_url,
            token=token,
            symbol=symbol,
            recorder=recorder,
            timeout_seconds=timeout_seconds,
        )


def poll_proxy_orderbook(
    *,
    proxy_url: str,
    token: str | None,
    symbol: str,
    recorder: ProbeRecorder,
    timeout_seconds: int = 5,
) -> None:
    request = urllib.request.Request(
        proxy_url.rstrip("/") + f"/orderbook/{symbol}",
        method="GET",
        headers={
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        recorder.record(
            ProbeEvent(
                schema_version=EVENT_SCHEMA_VERSION,
                run_id=recorder.run_id,
                provider="shioaji_proxy_orderbook",
                source_type="error",
                symbol=symbol,
                received_at=_iso(_utc_now()),
                source_time=None,
                latency_ms=None,
                raw={"error": type(exc).__name__, "message": str(exc)[:200]},
            )
        )
        return

    if not isinstance(body, dict):
        return
    received_at = _utc_now()
    source_time = _parse_time(body.get("updated_at") or body.get("timestamp"))
    bid_prices = [float(v) for v in list(body.get("bid_prices") or []) if _first_number(v) is not None]
    ask_prices = [float(v) for v in list(body.get("ask_prices") or []) if _first_number(v) is not None]
    bid_volumes = _int_values(body.get("bid_volumes"))
    ask_volumes = _int_values(body.get("ask_volumes"))
    recorder.record(
        ProbeEvent(
            schema_version=EVENT_SCHEMA_VERSION,
            run_id=recorder.run_id,
            provider="shioaji_proxy_orderbook",
            source_type=str(body.get("status") or "orderbook"),
            symbol=symbol,
            received_at=_iso(received_at),
            source_time=_iso(source_time) if source_time else None,
            latency_ms=_latency_ms(source_time, received_at),
            price=_first_number(body.get("price")),
            best_bid=bid_prices[0] if bid_prices else None,
            best_ask=ask_prices[0] if ask_prices else None,
            bid_prices=bid_prices[:5],
            ask_prices=ask_prices[:5],
            bid_volumes=bid_volumes[:5],
            ask_volumes=ask_volumes[:5],
            raw={
                "depth_available": body.get("depth_available"),
                "features": body.get("features"),
            },
        )
    )


def run_probe(
    *,
    symbols: list[str],
    duration_seconds: int,
    output_dir: Path,
    allow_broker_login: bool = False,
    compare_proxy_url: str | None = None,
    proxy_token: str | None = None,
    proxy_poll_seconds: int = 15,
    account_factory: Callable[[], Any] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    run_id = f"finlab-sinopac-probe-{int(time.time())}"
    recorder = ProbeRecorder(run_id=run_id, output_dir=output_dir / run_id)
    summary_path = output_dir / run_id / "summary.json"
    status: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "mode": "read_only_market_data_probe",
        "symbols": symbols,
        "duration_seconds": duration_seconds,
        "live_submit_enabled": False,
        "events_path": str(output_dir / run_id / "events.jsonl"),
        "summary_path": str(summary_path),
        "status": "running",
    }

    account = None
    try:
        if allow_broker_login:
            env_status = sinopac_env_status()
            status["sinopac_env"] = env_status
            if not env_status["ready"]:
                status["status"] = "blocked"
                status["reason"] = "missing_sinopac_credentials"
                status["summary"] = summarize_events(recorder.events)
                return status

            if account_factory is None:
                from finlab.online.brokers.sinopac import SinopacAccount

                account_factory = SinopacAccount

            account = account_factory()
            account.on_tick(recorder.record_tick)
            account.on_bidask(recorder.record_bidask)
            account.connect_realtime()
            account.subscribe_ticks(symbols)
            account.subscribe_bidask(symbols)
            status["finlab_realtime"] = "subscribed"
        else:
            status["finlab_realtime"] = "skipped"
            status["finlab_realtime_reason"] = "allow_broker_login_required"

        deadline = time.monotonic() + max(0, duration_seconds)
        next_proxy_poll = 0.0
        while time.monotonic() < deadline:
            now_monotonic = time.monotonic()
            if compare_proxy_url and now_monotonic >= next_proxy_poll:
                poll_proxy_snapshot(
                    proxy_url=compare_proxy_url,
                    token=proxy_token,
                    symbols=symbols,
                    recorder=recorder,
                )
                next_proxy_poll = now_monotonic + max(1, proxy_poll_seconds)
            sleep(min(1.0, max(0.0, deadline - time.monotonic())))

        status["status"] = "completed"
        status["summary"] = summarize_events(recorder.events)
        return status
    finally:
        if account is not None:
            for method_name in ("unsubscribe_ticks", "unsubscribe_bidask"):
                try:
                    getattr(account, method_name)(symbols)
                except Exception:
                    pass
            try:
                account.disconnect_realtime()
            except Exception:
                pass
        recorder.close()
        if "summary" not in status:
            status["summary"] = summarize_events(recorder.events)
        summary_path.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
