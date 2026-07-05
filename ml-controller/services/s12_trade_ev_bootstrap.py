from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Callable

from services import d1_client
from services.market_segment_policy import normalize_segment
from services.s12_trade_ev import build_s12_trade_ev_from_replay


QueryFn = Callable[[str, list[Any] | None], list[dict[str, Any]]]


def _to_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _json_obj(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _first_number(*values: Any) -> float | None:
    for value in values:
        out = _to_float(value)
        if out is not None:
            return out
    return None


def _nested(obj: dict[str, Any], *path: str) -> Any:
    cur: Any = obj
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _date_key(value: Any) -> str:
    text = str(value or "").strip()
    return text[:10] if len(text) >= 10 else ""


def _fallback_start_date(run_date: str, lookback_days: int) -> str:
    try:
        base = date.fromisoformat(str(run_date)[:10])
    except ValueError:
        base = date.today()
    return (base - timedelta(days=max(1, int(lookback_days)))).isoformat()


def _symbol_from_row(row: dict[str, Any]) -> str:
    return str(row.get("symbol") or row.get("stock_id") or "").strip()


def _market_segment_from_payloads(*payloads: dict[str, Any]) -> str:
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        fd = _json_obj(payload.get("forecast_data"))
        meta = (
            payload.get("stock_meta")
            or fd.get("stock_meta")
            or _nested(fd, "alpha_context", "stock_meta")
            or {}
        )
        raw = (
            payload.get("market_segment")
            or payload.get("market")
            or (meta.get("market_segment") if isinstance(meta, dict) else None)
            or (meta.get("market") if isinstance(meta, dict) else None)
        )
        segment = normalize_segment(raw)
        if segment != "UNKNOWN":
            return segment
    return "UNKNOWN"


def _alpha_bucket_from_payloads(*payloads: dict[str, Any]) -> str:
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        fd = _json_obj(payload.get("forecast_data"))
        for source in (
            payload.get("alpha_context"),
            payload.get("alpha_allocation"),
            fd.get("alpha_context"),
            fd.get("alpha_allocation"),
        ):
            if not isinstance(source, dict):
                continue
            value = str(source.get("edge_bucket") or source.get("bucket") or "").strip()
            if value:
                return value
    return "UNKNOWN"


def _entry_stop_from_row(row: dict[str, Any], prediction: dict[str, Any] | None) -> tuple[float | None, float | None]:
    pred = prediction if isinstance(prediction, dict) else {}
    entry = _first_number(
        row.get("entry_price"),
        row.get("current_price"),
        pred.get("entry_price"),
        pred.get("current_price"),
    )
    stop = _first_number(
        row.get("stop_loss"),
        row.get("s12_structure_stop"),
        pred.get("stop_loss"),
        pred.get("s12_structure_stop"),
        _nested(pred, "s12_defense", "stop_loss"),
        _nested(pred, "s12_exit", "structure_stop"),
    )
    return entry, stop


def load_s12_replay_trade_rows(
    *,
    run_date: str,
    lookback_days: int = 180,
    limit: int = 5000,
    query_fn: QueryFn | None = None,
) -> list[dict[str, Any]]:
    """Load historical verified S12-style trade outcomes strictly before run_date."""

    safe_limit = max(1, min(int(limit or 5000), 20000))
    start_date = _fallback_start_date(run_date, lookback_days)
    query = query_fn or d1_client.query
    return query(
        """
        SELECT p.stock_id,
               s.symbol,
               s.market,
               p.prediction_date,
               p.trade_signal,
               p.trade_outcome,
               p.trade_pnl_pct,
               p.trade_pnl_r,
               p.max_favorable_pct,
               p.max_adverse_pct,
               p.entry_price,
               p.stop_loss,
               p.forecast_data
          FROM predictions p
          LEFT JOIN stocks s ON s.id = p.stock_id
         WHERE p.model_name = 'ensemble'
           AND p.prediction_date IS NOT NULL
           AND date(p.prediction_date) < date(?)
           AND date(p.prediction_date) >= date(?)
           AND (p.trade_pnl_pct IS NOT NULL OR p.trade_pnl_r IS NOT NULL)
         ORDER BY date(p.prediction_date) DESC, p.id DESC
         LIMIT ?
        """.strip(),
        [run_date, start_date, safe_limit],
    )


@dataclass(frozen=True)
class _ReplayBucket:
    scope: str
    key: str
    rows: list[dict[str, Any]]


class S12TradeEvBootstrapProvider:
    """Build per-candidate S12 trade EV from historical trade outcomes.

    This is intentionally a producer for allocator expected edge, not a forecast
    calibration fallback. It only uses rows dated before the requested run_date.
    """

    def __init__(
        self,
        rows: list[dict[str, Any]],
        *,
        run_date: str,
        min_samples: int = 30,
        roundtrip_cost_bps: float = 18.0,
    ) -> None:
        self.run_date = str(run_date)[:10]
        self.min_samples = max(1, int(min_samples or 30))
        self.roundtrip_cost_bps = max(0.0, float(roundtrip_cost_bps or 0.0))
        self.rows = [dict(row) for row in rows or [] if _date_key(row.get("prediction_date")) < self.run_date]
        self.by_symbol: dict[str, list[dict[str, Any]]] = {}
        self.by_market_bucket: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self.by_market: dict[str, list[dict[str, Any]]] = {}
        self._index_rows()

    @classmethod
    def for_run_date(
        cls,
        run_date: str,
        *,
        query_fn: QueryFn | None = None,
        lookback_days: int | None = None,
        limit: int | None = None,
        min_samples: int | None = None,
        roundtrip_cost_bps: float | None = None,
    ) -> "S12TradeEvBootstrapProvider":
        rows = load_s12_replay_trade_rows(
            run_date=run_date,
            lookback_days=int(lookback_days or os.getenv("S12_TRADE_EV_BOOTSTRAP_LOOKBACK_DAYS", "180")),
            limit=int(limit or os.getenv("S12_TRADE_EV_BOOTSTRAP_LIMIT", "5000")),
            query_fn=query_fn,
        )
        return cls(
            rows,
            run_date=run_date,
            min_samples=int(min_samples or os.getenv("S12_TRADE_EV_BOOTSTRAP_MIN_SAMPLES", "30")),
            roundtrip_cost_bps=float(roundtrip_cost_bps or os.getenv("S12_TRADE_EV_ROUNDTRIP_COST_BPS", "18")),
        )

    def _index_rows(self) -> None:
        for row in self.rows:
            symbol = _symbol_from_row(row)
            fd = _json_obj(row.get("forecast_data"))
            segment = _market_segment_from_payloads(row, fd)
            bucket = _alpha_bucket_from_payloads(row, fd)
            if symbol:
                self.by_symbol.setdefault(symbol, []).append(row)
            if segment != "UNKNOWN" and bucket != "UNKNOWN":
                self.by_market_bucket.setdefault((segment, bucket), []).append(row)
            if segment != "UNKNOWN":
                self.by_market.setdefault(segment, []).append(row)

    def _candidate_buckets(
        self,
        row: dict[str, Any],
        prediction: dict[str, Any] | None,
    ) -> list[_ReplayBucket]:
        pred = prediction if isinstance(prediction, dict) else {}
        symbol = _symbol_from_row(row) or _symbol_from_row(pred)
        segment = _market_segment_from_payloads(row, pred)
        bucket = _alpha_bucket_from_payloads(row, pred)
        buckets: list[_ReplayBucket] = []
        if symbol:
            buckets.append(_ReplayBucket("symbol", symbol, self.by_symbol.get(symbol) or []))
        if segment != "UNKNOWN" and bucket != "UNKNOWN":
            buckets.append(_ReplayBucket("market_segment_alpha_bucket", f"{segment}:{bucket}", self.by_market_bucket.get((segment, bucket)) or []))
        if segment != "UNKNOWN":
            buckets.append(_ReplayBucket("market_segment", segment, self.by_market.get(segment) or []))
        buckets.append(_ReplayBucket("global", "ALL", self.rows))
        return buckets

    def _select_bucket(
        self,
        row: dict[str, Any],
        prediction: dict[str, Any] | None,
    ) -> _ReplayBucket:
        buckets = self._candidate_buckets(row, prediction)
        for bucket in buckets:
            if len(bucket.rows) >= self.min_samples:
                return bucket
        return max(buckets, key=lambda bucket: len(bucket.rows))

    def build_for_row(
        self,
        row: dict[str, Any],
        *,
        prediction: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        bucket = self._select_bucket(row, prediction)
        entry, stop = _entry_stop_from_row(row, prediction)
        symbol = _symbol_from_row(row) or _symbol_from_row(prediction or {})
        source = f"s12_replay_trade_outcomes:{bucket.scope}"
        samples = [
            {
                "return_pct": item.get("trade_pnl_pct"),
                "trade_pnl_r": item.get("trade_pnl_r"),
                "mfe_pct": item.get("max_favorable_pct"),
                "mae_pct": item.get("max_adverse_pct"),
                "exit_reason": item.get("trade_outcome") or "unknown",
            }
            for item in bucket.rows
        ]
        ev = build_s12_trade_ev_from_replay(
            symbol=symbol or None,
            entry_price=entry,
            stop_price=stop,
            samples=samples,
            min_samples=self.min_samples,
            roundtrip_cost_bps=self.roundtrip_cost_bps,
            source=source,
        )
        dates = sorted({_date_key(item.get("prediction_date")) for item in bucket.rows if _date_key(item.get("prediction_date"))})
        ev.update({
            "bootstrap_scope": bucket.scope,
            "bootstrap_key": bucket.key,
            "bootstrap_run_date": self.run_date,
            "as_of_guard": "prediction_date_strictly_before_run_date",
            "sample_date_min": dates[0] if dates else None,
            "sample_date_max": dates[-1] if dates else None,
            "candidate_market_segment": _market_segment_from_payloads(row, prediction or {}),
            "candidate_alpha_bucket": _alpha_bucket_from_payloads(row, prediction or {}),
        })
        return ev

    def summary(self) -> dict[str, Any]:
        return {
            "schema_version": "s12-trade-ev-bootstrap-summary-v1",
            "run_date": self.run_date,
            "sample_rows": len(self.rows),
            "min_samples": self.min_samples,
            "symbol_buckets": len(self.by_symbol),
            "market_segment_buckets": len(self.by_market),
            "market_segment_alpha_buckets": len(self.by_market_bucket),
        }
