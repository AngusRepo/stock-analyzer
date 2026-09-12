import asyncio

import pytest

from services import debate_service, debate_ab
from services.debate_execution_scope import DebateExecutionPorts, private_debate_execution, current_debate_execution


def test_original_debate_uses_private_inference_and_audit_without_formal_cache_or_logs(monkeypatch):
    async def forbidden(*args, **kwargs):
        raise AssertionError('Private debate reached a formal capability')
    for name in ('_kv_read', '_kv_write', '_read_max_rounds', 'call_llm'):
        monkeypatch.setattr(debate_service, name, forbidden)
    monkeypatch.setattr(debate_ab, 'log_debate', forbidden)
    calls, audits = [], []
    async def infer(system, user, **kwargs):
        calls.append((system, user))
        return ('VERDICT: APPROVE | CONVICTION: 70\nEvidence verified.' if len(calls) == 3
                else 'The supplied evidence supports a balanced assessment.', 'gemini_api')
    async def audit(**kwargs):
        audits.append(kwargs)
    async def execute():
        with private_debate_execution(DebateExecutionPorts(1, infer, audit)):
            result = await debate_service.run_buy_debate_cached(symbol='2330', stock_name='fixture',
                signal='BUY', confidence=.7, reasoning='Frozen input', cache_key_date='2026-09-07')
            assert result.terminal_status == 'completed'
            assert result.verdict == 'APPROVE'
    asyncio.run(execute())
    assert len(calls) == 3 and len(audits) == 1
    assert current_debate_execution() is None


def test_debate_scope_restores_on_failure_and_rejects_nesting():
    async def noop(*args, **kwargs):
        return None
    with pytest.raises(RuntimeError):
        with private_debate_execution(DebateExecutionPorts(1, noop, noop)):
            with pytest.raises(ValueError, match='nested_scope'):
                with private_debate_execution(DebateExecutionPorts(1, noop, noop)):
                    pass
            raise RuntimeError('test')
    assert current_debate_execution() is None
