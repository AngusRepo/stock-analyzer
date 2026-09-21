"""The real Worker/KV boundary must preserve checksum-bearing Python model JSON."""
import json
from copy import deepcopy
import httpx
import pytest
from services import kv_client, worker_config_client as client
from services.paired_nav_journal import digest


def setup(monkeypatch, projected, raw):
    monkeypatch.setenv(client.WORKER_URL_ENV, 'https://worker.invalid')
    monkeypatch.setenv(client.WORKER_AUTH_TOKEN_ENV, 'test-token')
    calls = []
    def get(url, **kwargs):
        calls.append(url)
        return httpx.Response(200, json=projected)
    monkeypatch.setattr(httpx, 'get', get)
    monkeypatch.setattr(kv_client, 'get_json', lambda *a, **k: deepcopy(raw))
    return calls


def policy():
    model = {'beta': [0.0, 1.0, -0.0, 1.25], 'enabled': True, 'count': 8}
    return {'scope': 'paper', 'artifact': {'model': model, 'model_checksum': digest(model)},
            'constraints': {'alpha_strength': 1.0}}


def test_restores_exact_artifact_bytes_semantics_after_worker_number_roundtrip(monkeypatch):
    raw = {'l4Distribution': policy()}
    projected = json.loads(json.dumps(raw).replace('0.0', '0').replace('1.0', '1'))
    projected['worker_default'] = 5
    assert digest(projected['l4Distribution']['artifact']['model']) != raw['l4Distribution']['artifact']['model_checksum']
    calls = setup(monkeypatch, projected, raw)
    result = client.load_active_trading_config()
    assert digest(result['l4Distribution']) == digest(raw['l4Distribution'])
    assert digest(result['l4Distribution']['artifact']['model']) == result['l4Distribution']['artifact']['model_checksum']
    assert result['worker_default'] == 5
    assert calls == ['https://worker.invalid/api/admin/config?fresh=1']


@pytest.mark.parametrize('change', ['number', 'boolean', 'missing', 'string', 'extra', 'no_raw'])
def test_rejects_real_projection_drift_instead_of_substituting_raw_policy(monkeypatch, change):
    raw = {'l4Distribution': policy()}; projected = deepcopy(raw)
    if change == 'number': projected['l4Distribution']['constraints']['alpha_strength'] = 0.99
    elif change == 'boolean': projected['l4Distribution']['artifact']['model']['enabled'] = 1
    elif change == 'missing': projected['l4Distribution']['artifact']['model'].pop('count')
    elif change == 'string': projected['l4Distribution']['artifact']['model']['count'] = '8'
    elif change == 'extra': projected['l4Distribution']['unexpected'] = True
    elif change == 'no_raw': raw = None
    setup(monkeypatch, projected, raw)
    with pytest.raises(client.WorkerConfigClientError, match='Worker/KV L4 configuration mismatch'):
        client.load_active_trading_config()


def test_no_l4_keeps_worker_config_without_extra_kv_request(monkeypatch):
    setup(monkeypatch, {'capital': 800000}, None)
    def denied(*a, **k): raise AssertionError('unnecessary KV read')
    monkeypatch.setattr(kv_client, 'get_json', denied)
    assert client.load_active_trading_config() == {'capital': 800000}
