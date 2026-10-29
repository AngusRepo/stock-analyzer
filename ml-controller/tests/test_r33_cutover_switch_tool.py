"""tools/r33_cutover_switch.py over in-memory KV and D1: order, rechecks, readback, rollback. No network."""
from argparse import Namespace
from copy import deepcopy
import json
from pathlib import Path
import sys
import types

import pytest

ROOT = Path(__file__).resolve().parents[2]
for entry in (str(ROOT / 'tools'), str(ROOT / 'tools' / 'release')):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import r33_cutover_switch as tool  # noqa: E402
from services import r33_switch  # noqa: E402
from test_r33_switch import _inputs  # noqa: E402


class Learning:
    def __init__(self, pointer):
        self.rows, self.pointer = {}, dict(pointer)

    def query(self, sql, params):
        if 'active8_ensemble_pointer_v1' in sql:
            return [dict(self.pointer)]
        row = self.rows.get(params[0])
        return [dict(row)] if row else []

    def execute(self, sql, params):
        if sql.startswith('INSERT'):
            columns = sql[sql.index('(') + 1:sql.index(')')].split(',')[:-2]
            self.rows.setdefault(params[0], {**dict(zip(columns, params)), 'state': 'candidate'})
        elif sql.startswith('DELETE') and self.rows.get(params[0], {}).get('state') == 'candidate':
            del self.rows[params[0]]


@pytest.fixture
def world(monkeypatch, tmp_path):
    inputs = _inputs()
    packet = r33_switch.prepare(**inputs)
    packet.update(controller_source_sha='s' * 40, serving_table_stored=False)
    (tmp_path / 'packet.json').write_text(json.dumps(packet))
    kv = {w['key']: deepcopy(w['before']) for w in packet['writes'].values()}
    learning = Learning(inputs['pointer'])
    writes = []

    def kv_write(key, value):
        writes.append(key)
        if value is None:
            kv.pop(key, None)
        else:
            kv[key] = deepcopy(value)

    monkeypatch.setattr(tool, '_kv_read', lambda key: deepcopy(kv.get(key)))
    monkeypatch.setattr(tool, '_kv_write', kv_write)
    monkeypatch.setattr(tool, '_snapshot_config', lambda *a: 'snapshot-1')
    monkeypatch.setattr(tool, '_learning', lambda: learning)
    blobs = {}

    class Blob:
        def __init__(self, name): self.name = name
        def upload_from_string(self, body, **kw): blobs.setdefault(self.name, body)
        def download_as_bytes(self): return blobs[self.name]
    monkeypatch.setattr(tool, '_bucket', lambda: types.SimpleNamespace(blob=Blob, name='b'))
    monkeypatch.setitem(sys.modules, 'runtime_context', types.SimpleNamespace(load_environment=lambda: {'source_sha': 's'}))
    from services import active8_paper_admission, worker_config_client
    granted = packet['approval']['configuration']['trading_config']
    live = {'config': inputs['merged_config']}
    monkeypatch.setattr(worker_config_client, 'load_active_trading_config',
                        lambda: deepcopy(granted if kv['trading:config'] == packet['writes']['kv-config']['after']
                                         else live['config']))
    monkeypatch.setattr(active8_paper_admission, 'verify_active_approval',
                        lambda admission, **kw: deepcopy(kv[packet['writes']['grant']['key']]
                                                         if admission == kv.get(active8_paper_admission.KEY) else None))

    def promote(packet, *, confirm):
        if confirm:
            learning.pointer.update({k: packet['ensemble_row'][k] for k in r33_switch.IDENTITY_KEYS})
        return {'status': 'ok' if confirm else 'dry_run'}
    monkeypatch.setattr(tool, '_promote', promote)
    run = lambda command, step, execute=False: tool.activate(
        Namespace(out=tmp_path, step=step, execute=execute), undo=command == 'rollback')
    return types.SimpleNamespace(packet=packet, kv=kv, learning=learning, writes=writes, run=run, live=live,
                                 out=tmp_path, blobs=blobs)


def test_steps_run_one_at_a_time_and_only_in_order(world):
    with pytest.raises(SystemExit, match='not the next step'):
        world.run('activate', 'admission', execute=True)
    world.run('activate', 'kv-config')
    assert world.writes == [] and (world.out / 'activate-kv-config-dry-run.json').exists()
    for step in r33_switch.STEPS:
        world.run('activate', step, execute=True)
    assert world.writes == ['trading:config', 'ml:active8:paper_admission:v1', world.packet['writes']['grant']['key']]
    assert world.kv['trading:config'] == world.packet['writes']['kv-config']['after']
    assert world.learning.rows[world.packet['ensemble_row']['artifact_id']]['knowledge_cutoff_date'] == '2026-10-26'
    assert list(world.blobs) == ['r33/monthly_candidates/c1/crossfit_serving_table.json']
    receipt = json.loads((world.out / 'activate-promotion-01-receipt.json').read_text())
    assert receipt['status'] == 'written_readback_verified'


def test_kv_config_refuses_when_the_live_grant_or_config_moved(world):
    world.live['config'] = {**world.live['config'], 'fees': {'commission': 0, 'tax': 0}}
    with pytest.raises(RuntimeError, match='prior_config_not_live_config'):
        world.run('activate', 'kv-config', execute=True)
    assert world.writes == []


def test_a_foreign_value_between_steps_is_drift_and_nothing_is_written(world):
    world.run('activate', 'kv-config', execute=True)
    world.kv['ml:active8:paper_admission:v1'] = {'someone': 'else'}
    with pytest.raises(RuntimeError, match='admission=drift'):
        world.run('activate', 'admission', execute=True)
    assert world.writes == ['trading:config']


def test_rollback_undoes_the_last_done_step_and_never_republishes_a_pointer(world):
    for step in r33_switch.STEPS[:4]:
        world.run('activate', step, execute=True)
    with pytest.raises(SystemExit, match='not the last done step'):
        world.run('rollback', 'grant', execute=True)
    world.run('rollback', 'r33-row', execute=True)
    assert world.learning.rows == {}
    for step in ('grant', 'admission', 'kv-config'):
        world.run('rollback', step, execute=True)
    assert world.kv == {w['key']: w['before'] for w in world.packet['writes'].values()}
    for step in r33_switch.STEPS:
        world.run('activate', step, execute=True)
    with pytest.raises(SystemExit, match='promotion rollback'):
        world.run('rollback', 'promotion', execute=True)


def test_a_tampered_packet_is_refused(world):
    packet = json.loads((world.out / 'packet.json').read_text())
    packet['writes']['kv-config']['after']['exit']['swingHardStopPct'] = -.5
    (world.out / 'packet.json').write_text(json.dumps(packet))
    with pytest.raises(RuntimeError, match='packet_checksum_mismatch'):
        world.run('activate', 'kv-config', execute=True)


def test_readbacks_must_show_the_granted_config_and_the_cutover_grant(world, monkeypatch):
    from services import active8_paper_admission, worker_config_client
    stale, original = world.live['config'], worker_config_client.load_active_trading_config
    monkeypatch.setattr(worker_config_client, 'load_active_trading_config', lambda: deepcopy(stale))
    # check_prior passes on the live config; the post-write merged readback still shows the old one.
    with pytest.raises(RuntimeError, match='worker_merged_config_not_the_granted_config'):
        world.run('activate', 'kv-config', execute=True)
    world.kv['trading:config'] = deepcopy(world.packet['writes']['kv-config']['before'])
    monkeypatch.setattr(worker_config_client, 'load_active_trading_config', original)
    world.run('activate', 'kv-config', execute=True)
    world.run('activate', 'admission', execute=True)
    monkeypatch.setattr(active8_paper_admission, 'verify_active_approval', lambda admission, **kw: {'other': True})
    with pytest.raises(RuntimeError, match='active_grant_not_the_cutover_grant'):
        world.run('activate', 'grant', execute=True)
