"""Prospective PIT residual-momentum challenger for StockVision.

The only candidate factor is 10% residual momentum. Industry breadth and
institutional-flow diffusion are persisted beside it as diagnostics and never
enter the shadow score, production score, debate context, sizing, or orders.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import logging
import math
from typing import Any, Iterable

import numpy as np
import pandas as pd

from services import d1_domain_client


logger = logging.getLogger(__name__)

FACTOR_CONTRACT_VERSION = "pit-residual-momentum-w10-v1"
RESIDUAL_WEIGHT = 0.10
PRIMARY_HORIZON_SESSIONS = 10

market_d1 = d1_domain_client.client_for_domain("market")
learning_d1 = d1_domain_client.client_for_domain("learning")


@dataclass(frozen=True)
class PitResidualConfig:
    min_sector_members: int = 5
    min_price: float = 5.0
    min_adv20_twd: float = 5_000_000.0
    min_market_value: float = 300_000_000.0
    formation_sessions: int = 252
    skip_sessions: int = 21
    regression_sessions: int = 756
    min_regression_obs: int = 630
    min_score_obs: int = 189


def _frame(value: Any) -> pd.DataFrame:
    frame = pd.DataFrame(value).copy()
    frame.index = pd.to_datetime(frame.index)
    frame = frame.sort_index()
    frame.columns = [str(column).strip() for column in frame.columns]
    return frame


def _align(
    value: Any,
    index: pd.Index,
    symbols: list[str],
    *,
    fill: str | None = None,
) -> pd.DataFrame:
    frame = _frame(value).reindex(index=index, columns=symbols)
    if fill == "ffill":
        frame = frame.ffill()
    elif fill == "zero":
        frame = frame.fillna(0.0)
    return frame


def _rank_series(series: pd.Series) -> pd.Series:
    return series.rank(pct=True, method="average")


def _cross_rank(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.rank(axis=1, pct=True, method="average")


def _groups(membership: dict[str, str], symbols: Iterable[str]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for symbol in symbols:
        industry = membership.get(symbol)
        if industry:
            groups.setdefault(industry, []).append(symbol)
    return {industry: sorted(members) for industry, members in groups.items()}


def _loo_fraction(
    positive: pd.Series,
    groups: dict[str, list[str]],
    *,
    min_other_members: int,
) -> pd.Series:
    result = pd.Series(np.nan, index=positive.index, dtype=float)
    for members in groups.values():
        sample = positive.reindex(members).dropna()
        if len(sample) - 1 < min_other_members:
            continue
        result.loc[sample.index] = (
            float(sample.sum()) - sample.astype(float)
        ) / (len(sample) - 1)
    return result


def _load_pit_membership(as_of_date: str) -> tuple[dict[str, str], dict[str, str]]:
    snapshot = market_d1.query(
        """
        SELECT snapshot_date, membership_checksum
          FROM sector_taxonomy_membership_snapshots_v1
         WHERE snapshot_date = (
           SELECT MAX(snapshot_date)
             FROM sector_taxonomy_membership_snapshots_v1
            WHERE snapshot_date <= ?
              AND tag_type = 'industry'
              AND source = 'finlab.security_categories'
         )
           AND tag_type = 'industry'
           AND source = 'finlab.security_categories'
         GROUP BY snapshot_date, membership_checksum
         ORDER BY membership_checksum
        """,
        [as_of_date],
    )
    if len(snapshot) != 1:
        raise RuntimeError(
            f"pit_residual_taxonomy_snapshot_invalid:as_of={as_of_date}:rows={len(snapshot)}"
        )
    snapshot_date = str(snapshot[0].get("snapshot_date") or "")
    checksum = str(snapshot[0].get("membership_checksum") or "")
    rows = market_d1.query(
        """
        SELECT symbol, tag
          FROM sector_taxonomy_membership_snapshots_v1
         WHERE snapshot_date = ?
           AND tag_type = 'industry'
           AND source = 'finlab.security_categories'
           AND tag IS NOT NULL
           AND TRIM(tag) NOT IN ('', 'nan', 'None')
         ORDER BY symbol, tag
        """,
        [snapshot_date],
    )
    by_symbol: dict[str, set[str]] = {}
    for row in rows:
        symbol = str(row.get("symbol") or "").strip()
        industry = str(row.get("tag") or "").strip()
        if symbol and industry:
            by_symbol.setdefault(symbol, set()).add(industry)
    membership = {
        symbol: next(iter(industries))
        for symbol, industries in by_symbol.items()
        if len(industries) == 1
    }
    if not membership:
        raise RuntimeError(f"pit_residual_taxonomy_membership_empty:{snapshot_date}")
    return membership, {
        "snapshot_date": snapshot_date,
        "membership_checksum": checksum,
    }


def _load_finlab_frames(
    membership: dict[str, str],
    as_of_date: str,
    config: PitResidualConfig,
) -> dict[str, pd.DataFrame]:
    from finlab import data

    adjusted_close_all = _frame(data.get("etl:adj_close"))
    adjusted_close_all = adjusted_close_all.loc[:pd.Timestamp(as_of_date)]
    if adjusted_close_all.empty:
        raise RuntimeError(f"pit_residual_adjusted_close_empty:{as_of_date}")
    signal_date = adjusted_close_all.index[-1].date().isoformat()
    if signal_date != as_of_date:
        raise RuntimeError(
            f"pit_residual_signal_date_mismatch:requested={as_of_date}:available={signal_date}"
        )
    keep_sessions = max(config.regression_sessions + 2, config.formation_sessions + 2)
    adjusted_close_all = adjusted_close_all.tail(keep_sessions)
    symbols = sorted(set(adjusted_close_all.columns) & set(membership))
    if not symbols:
        raise RuntimeError("pit_residual_finlab_taxonomy_intersection_empty")
    index = adjusted_close_all.index
    adjusted_close = adjusted_close_all.reindex(columns=symbols)
    raw_close = _align(data.get("price:收盤價"), index, symbols)
    volume = _align(data.get("price:成交股數"), index, symbols)
    market_value = _align(data.get("etl:market_value"), index, symbols, fill="ffill")
    pb = _align(data.get("price_earning_ratio:股價淨值比"), index, symbols, fill="ffill")
    benchmark_raw = _frame(data.get("benchmark_return:發行量加權股價報酬指數"))
    benchmark = benchmark_raw.iloc[:, 0].reindex(index).ffill().rename("twii_total_return")
    flow_fields = (
        "institutional_investors_trading_summary:外陸資買賣超股數(不含外資自營商)",
        "institutional_investors_trading_summary:投信買賣超股數",
        "institutional_investors_trading_summary:自營商買賣超股數(自行買賣)",
    )
    flow_shares = sum(
        (_align(data.get(field), index, symbols, fill="zero") for field in flow_fields),
        pd.DataFrame(0.0, index=index, columns=symbols),
    )
    returns = adjusted_close.pct_change(fill_method=None).where(lambda value: value.abs() <= 0.35)
    benchmark_returns = benchmark.pct_change(fill_method=None).where(lambda value: value.abs() <= 0.20)
    adv20 = (raw_close * volume).rolling(20, min_periods=15).mean()
    tradable = (
        adjusted_close.notna()
        & (raw_close >= config.min_price)
        & (adv20 >= config.min_adv20_twd)
        & (market_value >= config.min_market_value)
    )
    return {
        "adjusted_close": adjusted_close,
        "raw_close": raw_close,
        "volume": volume,
        "market_value": market_value,
        "pb": pb,
        "benchmark": benchmark.to_frame(),
        "benchmark_returns": benchmark_returns.to_frame(),
        "flow_shares": flow_shares,
        "returns": returns,
        "tradable": tradable,
    }


def _factor_returns(frames: dict[str, pd.DataFrame]) -> pd.DataFrame:
    returns = frames["returns"]
    cap_lag = frames["market_value"].shift(1)
    pb_lag = frames["pb"].shift(1).where(lambda value: value > 0)
    book_to_market_lag = 1.0 / pb_lag
    size_pct = cap_lag.rank(axis=1, pct=True, method="average")
    value_pct = book_to_market_lag.rank(axis=1, pct=True, method="average")
    return pd.DataFrame(
        {
            "mkt": frames["benchmark_returns"].iloc[:, 0],
            "smb": returns.where(size_pct <= 0.30).mean(axis=1)
            - returns.where(size_pct >= 0.70).mean(axis=1),
            "hml": returns.where(value_pct >= 0.70).mean(axis=1)
            - returns.where(value_pct <= 0.30).mean(axis=1),
        },
        index=returns.index,
    ).replace([np.inf, -np.inf], np.nan)


def _base_score(frames: dict[str, pd.DataFrame]) -> pd.Series:
    close = frames["adjusted_close"]
    benchmark = frames["benchmark"].iloc[:, 0]
    mom_12_1 = close.shift(21) / close.shift(252) - 1.0
    close_to_high = close / close.rolling(252, min_periods=200).max()
    benchmark_126 = benchmark / benchmark.shift(126) - 1.0
    relative_126 = (close / close.shift(126) - 1.0).sub(benchmark_126, axis=0)
    combined = (
        0.50 * _cross_rank(mom_12_1)
        + 0.30 * _cross_rank(close_to_high)
        + 0.20 * _cross_rank(relative_126)
    )
    return combined.iloc[-1]


def _standardized_formation_residual(
    sample: pd.DataFrame,
    formation_index: pd.Index,
    config: PitResidualConfig,
) -> tuple[float | None, int, int]:
    if len(sample) < config.min_regression_obs:
        return None, len(sample), 0
    y_values = sample["y"].to_numpy(dtype=float)
    x_values = sample.drop(columns="y").to_numpy(dtype=float)
    x_values = np.column_stack([np.ones(len(x_values)), x_values])
    beta, *_ = np.linalg.lstsq(x_values, y_values, rcond=None)
    residual = pd.Series(y_values - x_values @ beta, index=sample.index)
    scoring = residual.reindex(formation_index).dropna()
    if len(scoring) < config.min_score_obs:
        return None, len(sample), len(scoring)
    volatility = float(np.std(scoring.to_numpy(dtype=float), ddof=1))
    if not math.isfinite(volatility) or volatility <= 0:
        return None, len(sample), len(scoring)
    score = float(scoring.sum() / (volatility * math.sqrt(len(scoring))))
    return (score if math.isfinite(score) else None), len(sample), len(scoring)


def _residual_momentum(
    frames: dict[str, pd.DataFrame],
    groups: dict[str, list[str]],
    config: PitResidualConfig,
) -> tuple[pd.Series, dict[str, Any]]:
    returns = frames["returns"]
    factors = _factor_returns(frames)
    position = len(returns.index) - 1
    regression_start = position - config.regression_sessions + 1
    formation_start = position - config.formation_sessions + 1
    formation_stop = position - config.skip_sessions + 1
    result = pd.Series(np.nan, index=returns.columns, dtype=float)
    if regression_start < 0 or formation_start < 0 or formation_stop <= formation_start:
        return result, {"regressions": 0, "fit_min_obs": None, "score_min_obs": None}
    regression_index = returns.index[regression_start : position + 1]
    formation_index = returns.index[formation_start:formation_stop]
    base_factors = factors.reindex(regression_index)
    fit_counts: list[int] = []
    score_counts: list[int] = []
    for members in groups.values():
        sector_returns = returns.loc[regression_index, members]
        count = sector_returns.notna().sum(axis=1)
        sector_sum = sector_returns.sum(axis=1, min_count=1)
        for symbol in members:
            y = sector_returns[symbol]
            denominator = count - y.notna().astype(int)
            industry_loo = (sector_sum - y.fillna(0.0)) / denominator.replace(0, np.nan)
            sample = pd.concat(
                [y.rename("y"), base_factors, industry_loo.rename("industry_loo")],
                axis=1,
            ).replace([np.inf, -np.inf], np.nan).dropna()
            score, fit_obs, score_obs = _standardized_formation_residual(
                sample,
                formation_index,
                config,
            )
            if score is None:
                continue
            result.loc[symbol] = score
            fit_counts.append(fit_obs)
            score_counts.append(score_obs)
    ranked = pd.Series(np.nan, index=result.index, dtype=float)
    for members in groups.values():
        ranked.loc[members] = _rank_series(result.reindex(members))
    return ranked, {
        "regressions": len(fit_counts),
        "fit_min_obs": min(fit_counts) if fit_counts else None,
        "fit_median_obs": float(np.median(fit_counts)) if fit_counts else None,
        "score_min_obs": min(score_counts) if score_counts else None,
        "score_median_obs": float(np.median(score_counts)) if score_counts else None,
    }


def _breadth(
    frames: dict[str, pd.DataFrame],
    groups: dict[str, list[str]],
    config: PitResidualConfig,
) -> pd.Series:
    close = frames["adjusted_close"]
    benchmark = frames["benchmark"].iloc[:, 0]
    stock_5d = close.iloc[-1] / close.iloc[-6] - 1.0
    benchmark_5d = float(benchmark.iloc[-1] / benchmark.iloc[-6] - 1.0)
    valid = stock_5d.where(stock_5d.abs() <= 0.70)
    raw = _loo_fraction(
        (valid > benchmark_5d).where(valid.notna()),
        groups,
        min_other_members=config.min_sector_members,
    )
    return _rank_series(raw)


def _flow_diffusion(
    frames: dict[str, pd.DataFrame],
    groups: dict[str, list[str]],
    config: PitResidualConfig,
) -> pd.Series:
    raw_close = frames["raw_close"]
    flow_value = frames["flow_shares"] * raw_close
    traded_value = frames["volume"] * raw_close
    intensity = (
        flow_value.rolling(5, min_periods=5).sum()
        / traded_value.rolling(5, min_periods=5).sum().replace(0, np.nan)
    ).iloc[-1].replace([np.inf, -np.inf], np.nan)
    raw = _loo_fraction(
        (intensity > 0).where(intensity.notna()),
        groups,
        min_other_members=config.min_sector_members,
    )
    return _rank_series(raw)


def compute_factor_rows_from_frames(
    frames: dict[str, pd.DataFrame],
    membership: dict[str, str],
    taxonomy: dict[str, str],
    config: PitResidualConfig | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    config = config or PitResidualConfig()
    symbols = frames["adjusted_close"].columns.tolist()
    groups = {
        industry: members
        for industry, members in _groups(membership, symbols).items()
        if len(members) >= config.min_sector_members + 1
    }
    allowed = sorted(symbol for members in groups.values() for symbol in members)
    residual, residual_diagnostics = _residual_momentum(frames, groups, config)
    component_frame = pd.DataFrame(
        {
            "research_base_score": _base_score(frames),
            "residual_momentum_rank": residual,
            "breadth_rank": _breadth(frames, groups, config),
            "flow_diffusion_rank": _flow_diffusion(frames, groups, config),
            "tradable": frames["tradable"].iloc[-1],
        }
    ).reindex(allowed)
    common = component_frame.dropna(
        subset=[
            "research_base_score",
            "residual_momentum_rank",
        ]
    )
    common = common[common["tradable"].fillna(False)]
    signal_date = frames["adjusted_close"].index[-1].date().isoformat()
    diagnostics = {
        "factor_contract_version": FACTOR_CONTRACT_VERSION,
        "authority": "shadow_only",
        "decision_effect": "none",
        "candidate_set_mutation_allowed": False,
        "debate_visibility": False,
        "residual_weight": RESIDUAL_WEIGHT,
        "primary_horizon_sessions": PRIMARY_HORIZON_SESSIONS,
        "auxiliary_features": {
            "breadth": "diagnostic_only",
            "flow_diffusion_5d": "diagnostic_only",
        },
        "config": asdict(config),
        "residual": residual_diagnostics,
    }
    diagnostics_json = json.dumps(diagnostics, ensure_ascii=False, sort_keys=True)
    rows: list[dict[str, Any]] = []
    for symbol, values in common.iterrows():
        base_score = float(values["research_base_score"])
        residual_rank = float(values["residual_momentum_rank"])
        breadth_rank = (
            None if pd.isna(values["breadth_rank"]) else float(values["breadth_rank"])
        )
        flow_diffusion_rank = (
            None
            if pd.isna(values["flow_diffusion_rank"])
            else float(values["flow_diffusion_rank"])
        )
        rows.append(
            {
                "signal_date": signal_date,
                "symbol": str(symbol),
                "industry": membership[str(symbol)],
                "taxonomy_snapshot_date": taxonomy["snapshot_date"],
                "taxonomy_checksum": taxonomy["membership_checksum"],
                "residual_momentum_rank": residual_rank,
                "breadth_rank": breadth_rank,
                "flow_diffusion_rank": flow_diffusion_rank,
                "research_base_score": base_score,
                "research_shadow_score": (1.0 - RESIDUAL_WEIGHT) * base_score
                + RESIDUAL_WEIGHT * residual_rank,
                "diagnostics_json": diagnostics_json,
            }
        )
    return rows, {
        "signal_date": signal_date,
        "rows": len(rows),
        "industries": len(groups),
        "taxonomy": taxonomy,
        **diagnostics,
    }


def _write_rows(rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    sql = """
        INSERT INTO pit_factor_shadow_daily_v1 (
          signal_date, symbol, industry, taxonomy_snapshot_date, taxonomy_checksum,
          residual_momentum_rank, breadth_rank, flow_diffusion_rank,
          research_base_score, research_shadow_score, residual_weight,
          primary_horizon_sessions, decision_effect, factor_contract_version,
          diagnostics_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(signal_date, symbol) DO UPDATE SET
          industry = excluded.industry,
          taxonomy_snapshot_date = excluded.taxonomy_snapshot_date,
          taxonomy_checksum = excluded.taxonomy_checksum,
          residual_momentum_rank = excluded.residual_momentum_rank,
          breadth_rank = excluded.breadth_rank,
          flow_diffusion_rank = excluded.flow_diffusion_rank,
          research_base_score = excluded.research_base_score,
          research_shadow_score = excluded.research_shadow_score,
          residual_weight = excluded.residual_weight,
          primary_horizon_sessions = excluded.primary_horizon_sessions,
          decision_effect = 'none',
          factor_contract_version = excluded.factor_contract_version,
          diagnostics_json = excluded.diagnostics_json,
          updated_at = CURRENT_TIMESTAMP
    """.strip()
    statements = [
        (
            sql,
            [
                row["signal_date"],
                row["symbol"],
                row["industry"],
                row["taxonomy_snapshot_date"],
                row["taxonomy_checksum"],
                row["residual_momentum_rank"],
                row["breadth_rank"],
                row["flow_diffusion_rank"],
                row["research_base_score"],
                row["research_shadow_score"],
                RESIDUAL_WEIGHT,
                PRIMARY_HORIZON_SESSIONS,
                FACTOR_CONTRACT_VERSION,
                row["diagnostics_json"],
            ],
        )
        for row in rows
    ]
    result = learning_d1.batch_execute(statements, timeout=60.0, chunk_size=200)
    if int(result.get("error_count") or 0) > 0:
        raise RuntimeError(f"pit_residual_shadow_write_failed:{result}")
    return int(result.get("success_count") or result.get("total") or 0)


def run_pit_residual_shadow(as_of_date: str) -> dict[str, Any]:
    membership, taxonomy = _load_pit_membership(as_of_date)
    frames = _load_finlab_frames(membership, as_of_date, PitResidualConfig())
    rows, summary = compute_factor_rows_from_frames(
        frames,
        membership,
        taxonomy,
        PitResidualConfig(),
    )
    written = _write_rows(rows)
    logger.info(
        "[pit_residual_shadow] date=%s rows=%s written=%s industries=%s authority=none",
        summary["signal_date"],
        len(rows),
        written,
        summary["industries"],
    )
    return {**summary, "written": written}
