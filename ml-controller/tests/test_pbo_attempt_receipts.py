from __future__ import annotations

import json
import types

import pytest

from services import pbo_service


class _FakeAsyncClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


@pytest.mark.asyncio
async def test_insufficient_pbo_persists_attempt_without_numeric_result(monkeypatch):
    run_date = pbo_service.datetime.now(pbo_service.ZoneInfo("Asia/Taipei")).strftime("%Y-%m-%d")
    evidence_clock = {
        "schema_version": "weekly-evidence-clock-v1",
        "as_of_date": run_date,
        "data_end_date": run_date,
        "snapshot_business_date": run_date,
        "mode": "B",
        "research_data_source": "snapshot",
        "evidence_scope": "canonical_current",
        "production_effect": True,
        "look_ahead_check": "PASS",
    }
    raw = {
        "strategy_lab_record": {"evidence_clock": evidence_clock},
        "summary": {"total_trades": 5},
        "trades": [
            {
                "exit_date": run_date,
                "profit_ratio": 0.01,
                "holding_period_days": 1,
                "entry_regime": "range",
            }
            for _ in range(5)
        ],
    }
    persisted: dict[str, object] = {}
    executed_sql: list[str] = []

    async def fake_query(_client, sql, params=None, *, domain):
        assert domain is pbo_service.D1DataDomain.RESEARCH
        if "FROM backtest_results" in sql:
            return [{
                "id": 41,
                "run_date": run_date,
                "created_at": f"{run_date} 06:00:00",
                "raw_results": json.dumps(raw),
            }]
        if "FROM pbo_attempt_receipts" in sql:
            assert params == [persisted["attempt_id"]]
            return [persisted]
        raise AssertionError(f"numeric PBO must not be read for insufficient evidence: {sql}")

    async def fake_exec(_client, sql, params=None, *, domain):
        assert domain is pbo_service.D1DataDomain.RESEARCH
        executed_sql.append(sql)
        assert "INSERT OR IGNORE INTO pbo_attempt_receipts" in sql
        persisted.update({
            "attempt_id": params[0],
            "run_date": params[1],
            "source": params[2],
            "status": params[3],
            "n_partitions": params[4],
            "observed_trades": params[5],
            "required_trades": params[6],
            "source_provenance_json": params[7],
            "pbo_result_id": params[8],
            "production_effect": 0,
        })
        return True

    monkeypatch.setattr(pbo_service, "CF_API_TOKEN", "test")
    monkeypatch.setattr(pbo_service, "httpx", types.SimpleNamespace(AsyncClient=_FakeAsyncClient))
    monkeypatch.setattr(pbo_service, "_d1_query", fake_query)
    monkeypatch.setattr(pbo_service, "_d1_exec", fake_exec)

    result = await pbo_service.run_pbo_analysis(
        n_partitions=10,
        source="backtest",
        expected_run_date=run_date,
        persist=True,
        evidence_scope="canonical_current",
    )

    assert result["status"] == "insufficient_evidence"
    assert result["run_date"] == run_date
    assert result["observed_trades"] == 5
    assert result["required_trades"] == 30
    assert result["pbo"] is None
    assert result["pbo_result_id"] is None
    assert result["attempt_receipt_persisted"] is True
    assert result["production_effect"] is False
    assert persisted["status"] == "insufficient_evidence"
    assert persisted["pbo_result_id"] is None
    assert len(executed_sql) == 1
