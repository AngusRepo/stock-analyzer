import asyncio
from unittest.mock import AsyncMock
import pytest
from services import obsidian_writer as writer


def test_missing_config_fails_before_queries(monkeypatch):
    monkeypatch.setattr(writer, 'GITHUB_TOKEN', '')
    query = AsyncMock()
    monkeypatch.setattr(writer, '_d1_query', query)
    with pytest.raises(RuntimeError, match='configuration_missing'):
        asyncio.run(writer.ObsidianWriter().generate_daily('2026-09-24'))
    query.assert_not_called()


@pytest.mark.parametrize('push_ok', [True, False])
def test_bounded_parallel_reads_one_vault_commit_and_truthful_result(monkeypatch, push_ok):
    monkeypatch.setattr(writer, 'GITHUB_TOKEN', 'test-only')
    monkeypatch.setattr(writer, 'GITHUB_REPO_VAULT', 'test/vault')
    monkeypatch.setattr(writer, 'GITHUB_REPO_MAIN', '')
    active = peak = 0
    async def query(*args, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return []
    monkeypatch.setattr(writer, '_d1_query', query)
    monkeypatch.setattr(writer, 'hydrate_position_valuations', AsyncMock(return_value=[]))
    monkeypatch.setattr(writer, 'read_model_pool_health_rows', lambda: [])
    monkeypatch.setattr(writer, '_render', lambda *args, **kwargs: 'rendered')
    push = AsyncMock(return_value=push_ok)
    monkeypatch.setattr(writer, '_push_to_github', push)
    if push_ok:
        result = asyncio.run(writer.ObsidianWriter().generate_daily('2026-09-24'))
        assert result['vault_pushed'] is result['progress_synced'] is True
    else:
        with pytest.raises(RuntimeError, match='sync_incomplete'):
            asyncio.run(writer.ObsidianWriter().generate_daily('2026-09-24'))
    assert peak == 3
    assert push.await_count == 1
    assert [item['path'] for item in push.call_args.args[2]] == [
        'Daily/2026-09-24.md', 'Pipeline/2026-09-24.md', 'Current-State.md']
