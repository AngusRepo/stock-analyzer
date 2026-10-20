import asyncio
from copy import deepcopy

import pytest

from services import paired_nav_cold as cold
from services.paired_nav_journal import read_snapshot, reuse_published_allocation
from test_paired_nav_cold import env, freeze


STATE = {'run_date': '2026-09-09', 'producer_run_id': 'fixture'}


def test_fresh_seal_reuses_producer_after_thread_handoff_without_second_decode(env, monkeypatch):
    db, _ = env
    content = {'history': [{'date': str(i), 'value': float(i)} for i in range(1000)]}

    @reuse_published_allocation
    async def node(state):
        manifest = await asyncio.to_thread(freeze, db, content)
        def forbidden(*a, **kw):
            pytest.fail('published parent was decoded again')
        with monkeypatch.context() as patch:
            patch.setattr(cold, 'parse_file', forbidden)
            saved = await asyncio.to_thread(read_snapshot, db.query, manifest['snapshot_id'])
        assert saved['payload']['content'] is content
        return manifest, saved

    manifest, saved = asyncio.run(node(STATE))
    independent = read_snapshot(db.query, manifest['snapshot_id'])
    assert independent == saved
    assert independent['payload']['content'] is not content


@pytest.mark.parametrize('changed', ['producer', 'manifest', 'cold'])
def test_reuse_does_not_hide_changed_inputs_metadata_or_cold_bytes(env, changed):
    db, objects = env
    content = {'history': [1, 2, 3]}

    @reuse_published_allocation
    async def node(state):
        manifest = freeze(db, content)
        query = db.query
        if changed == 'producer':
            content['history'].append(4)
        elif changed == 'manifest':
            def query(sql, params):
                return [{**row, 'prospective': 0} for row in db.query(sql, params)]
        else:
            objects.data[next(iter(objects.data))] = b'corrupt'
        with pytest.raises((RuntimeError, OSError, EOFError)):
            read_snapshot(query, manifest['snapshot_id'])

    asyncio.run(node(STATE))


def test_non_normalized_keys_keep_the_original_json_decoding_semantics(env):
    db, _ = env

    @reuse_published_allocation
    async def node(state):
        manifest = freeze(db, {'history': {1: 'one'}})
        return read_snapshot(db.query, manifest['snapshot_id'])

    result = asyncio.run(node(STATE))
    assert result['payload']['content'] == {'history': {'1': 'one'}}


def test_idempotent_same_seal_keeps_original_manifest_and_scope_is_exception_safe(env):
    db, _ = env
    content = {'history': [1, 2, 3]}
    original = freeze(db, deepcopy(content))

    @reuse_published_allocation
    async def node(state):
        manifest = freeze(db, content)
        assert manifest == original
        assert read_snapshot(db.query, manifest['snapshot_id'])['payload']['content'] is content
        raise ValueError('fixture failure')

    with pytest.raises(ValueError, match='fixture failure'):
        asyncio.run(node(STATE))
    assert read_snapshot(db.query, original['snapshot_id'])['payload']['content'] is not content
