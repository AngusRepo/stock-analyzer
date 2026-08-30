from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from services import pit_residual_shadow_service as service


def test_residual_formula_matches_exact_pit_bakeoff() -> None:
    index = pd.date_range("2026-01-05", periods=12, freq="B")
    factor = np.linspace(-0.03, 0.04, len(index))
    sample = pd.DataFrame(
        {
            "y": 0.001
            + 1.4 * factor
            + np.array(
                [0.03, -0.02, 0.01, -0.01, 0.02, -0.03, 0.01, 0.00, 0.04, 0.02, -0.01, 0.01]
            ),
            "mkt": factor,
        },
        index=index,
    )
    service_config = service.PitResidualConfig(
        regression_sessions=12,
        formation_sessions=5,
        skip_sessions=1,
        min_regression_obs=10,
        min_score_obs=4,
    )
    actual = service._standardized_formation_residual(
        sample,
        index[-5:-1],
        service_config,
    )
    y_values = sample["y"].to_numpy(dtype=float)
    x_values = np.column_stack(
        [np.ones(len(sample)), sample.drop(columns="y").to_numpy(dtype=float)]
    )
    beta, *_ = np.linalg.lstsq(x_values, y_values, rcond=None)
    residual = pd.Series(y_values - x_values @ beta, index=index).reindex(index[-5:-1])
    expected_score = float(
        residual.sum()
        / (residual.std(ddof=1) * np.sqrt(len(residual)))
    )
    expected = (expected_score, len(sample), len(residual))

    assert actual == pytest.approx(expected)


def test_diagnostic_nulls_do_not_gate_residual_rows(monkeypatch) -> None:
    index = pd.date_range("2023-01-02", periods=12, freq="B")
    columns = ["A", "B"]
    frames = {
        "adjusted_close": pd.DataFrame(100.0, index=index, columns=columns),
        "tradable": pd.DataFrame(True, index=index, columns=columns),
    }
    monkeypatch.setattr(service, "_base_score", lambda _frames: pd.Series({"A": 0.8, "B": 0.6}))
    monkeypatch.setattr(
        service,
        "_residual_momentum",
        lambda _frames, _groups, _config: (pd.Series({"A": 0.9, "B": 0.1}), {"regressions": 2}),
    )
    monkeypatch.setattr(service, "_breadth", lambda _frames, _groups, _config: pd.Series({"A": np.nan, "B": 0.4}))
    monkeypatch.setattr(service, "_flow_diffusion", lambda _frames, _groups, _config: pd.Series({"A": 0.7, "B": np.nan}))
    rows, _ = service.compute_factor_rows_from_frames(
        frames,
        {"A": "電子", "B": "電子"},
        {"snapshot_date": "2023-01-17", "membership_checksum": "x"},
        service.PitResidualConfig(min_sector_members=1),
    )
    assert len(rows) == 2
    by_symbol = {row["symbol"]: row for row in rows}
    assert by_symbol["A"]["breadth_rank"] is None
    assert by_symbol["B"]["flow_diffusion_rank"] is None


def test_write_contract_has_no_decision_authority(monkeypatch) -> None:
    captured = {}

    def fake_batch_execute(statements, timeout, chunk_size):
        captured["statements"] = statements
        captured["timeout"] = timeout
        captured["chunk_size"] = chunk_size
        return {"success_count": len(statements), "error_count": 0}

    monkeypatch.setattr(
        service,
        "learning_d1",
        SimpleNamespace(batch_execute=fake_batch_execute),
    )
    written = service._write_rows(
        [
            {
                "signal_date": date(2026, 8, 28).isoformat(),
                "symbol": "2330",
                "industry": "半導體業",
                "taxonomy_snapshot_date": "2026-08-28",
                "taxonomy_checksum": "checksum",
                "residual_momentum_rank": 0.9,
                "breadth_rank": 0.7,
                "flow_diffusion_rank": 0.6,
                "research_base_score": 0.8,
                "research_shadow_score": 0.81,
                "diagnostics_json": "{}",
            }
        ]
    )

    assert written == 1
    sql, params = captured["statements"][0]
    assert "decision_effect = 'none'" in sql
    assert "ON CONFLICT(signal_date, symbol)" in sql
    assert params[10] == service.RESIDUAL_WEIGHT == 0.10
    assert params[11] == service.PRIMARY_HORIZON_SESSIONS == 10
    assert service.FACTOR_CONTRACT_VERSION == "pit-residual-momentum-w10-v1"


def test_taxonomy_is_latest_snapshot_not_current_static_tags(monkeypatch) -> None:
    calls = []

    def fake_query(sql, params=None):
        calls.append((sql, params))
        if "GROUP BY snapshot_date" in sql:
            return [{"snapshot_date": "2026-08-28", "membership_checksum": "checksum"}]
        return [
            {"symbol": "2330", "tag": "半導體業"},
            {"symbol": "2317", "tag": "電子工業"},
        ]

    monkeypatch.setattr(service, "market_d1", SimpleNamespace(query=fake_query))

    membership, taxonomy = service._load_pit_membership("2026-08-29")

    assert membership == {"2330": "半導體業", "2317": "電子工業"}
    assert taxonomy == {
        "snapshot_date": "2026-08-28",
        "membership_checksum": "checksum",
    }
    assert "snapshot_date <= ?" in calls[0][0]
    assert "finlab.security_categories" in calls[0][0]
