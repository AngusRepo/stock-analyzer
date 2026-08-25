from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path

if "httpx" not in sys.modules:
    httpx_stub = types.ModuleType("httpx")
    httpx_stub.AsyncClient = object
    sys.modules["httpx"] = httpx_stub

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services import debate_service as debate


def test_strict_verdict_and_conviction_parser_fail_closed():
    assert debate._parse_verdict('VERDICT: APPROVE CONVICTION: 82\n理由') == 'APPROVE'
    assert debate._parse_conviction('VERDICT: APPROVE CONVICTION: 82\n理由') == 82
    assert debate._parse_verdict('Reason first\nVERDICT: APPROVE CONVICTION: 90') is None
    assert debate._parse_verdict('maybe APPROVE') is None
    assert debate._parse_conviction('VERDICT: APPROVE') is None
    assert debate._parse_conviction('VERDICT: REJECT CONVICTION: 101') is None


def test_legacy_or_retryable_cache_is_not_authoritative(monkeypatch):
    reads = [
        json.dumps({'verdict': 'APPROVE', 'conviction_score': 75}),
        json.dumps({
            'verdict': 'APPROVE',
            'conviction_score': 75,
            'terminal_status': 'retryable_error',
            'contract_version': debate.DEBATE_RESULT_CONTRACT_VERSION,
        }),
    ]
    calls = {'run': 0, 'writes': 0}

    async def fake_read(_client, _key):
        return reads.pop(0)

    async def fake_write(*_args, **_kwargs):
        calls['writes'] += 1

    async def fake_run(**_kwargs):
        calls['run'] += 1
        return debate.DebateResult(
            verdict='REJECT', rounds=0, summary='retry', llm_source='test', conviction_score=0,
            terminal_status='retryable_error', retryable=True, error_code='test_retry',
        )

    monkeypatch.setattr(debate, '_kv_read', fake_read)
    monkeypatch.setattr(debate, '_kv_write', fake_write)
    monkeypatch.setattr(debate, 'run_buy_debate', fake_run)

    async def scenario():
        for symbol in ('A', 'B'):
            result = await debate.run_buy_debate_cached(
                symbol=symbol, stock_name=symbol, signal='BUY', confidence=0.5, reasoning='x', client=object(),
            )
            assert result.terminal_status == 'retryable_error'

    asyncio.run(scenario())
    assert calls == {'run': 2, 'writes': 0}
