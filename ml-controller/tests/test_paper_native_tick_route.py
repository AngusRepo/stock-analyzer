import asyncio
import pytest
from routers.paper_corporate import native_execution_tick, NativeTickRequest
from pydantic import ValidationError


def test_retired_tick_never_calls_historical_runtime(monkeypatch):
    def forbidden(**kwargs):
        pytest.fail('retired API must not enter replay or load production config')
    monkeypatch.setattr('services.paired_native_runtime.run_native_execution_tick', forbidden)
    result=asyncio.run(native_execution_tick(NativeTickRequest(session_date='2026-10-04')))
    assert result=={'status':'disabled_by_single_b_policy','pairs':[],'executed':0}


def test_retired_tick_does_not_accept_override():
    with pytest.raises(ValidationError):
        NativeTickRequest(session_date='2026-10-04',force=True)
