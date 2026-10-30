"""One-off Modal fetch: own app name, existing secret, no secret leaves the function."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

import modal_fetch_corporate_history as entry  # noqa: E402
from test_fetch_corporate_history_sources import DAYS, SECRET, chatty_get, clock, vendor  # noqa: E402

SOURCE = (Path(__file__).resolve().parent.parent / 'scripts' / 'modal_fetch_corporate_history.py').read_text()
ENV = {'FINLAB_API_KEY': SECRET, 'FINLAB_REFRESH_TOKEN': SECRET + 'r', 'FINLAB_SESSION_ID': SECRET + 's'}


def loader(role='vip', get=None):
    def load(env, fetcher):
        print('logged in with', env['FINLAB_API_KEY'])  # SDK chatter stays inside
        return 'session_env', get or chatty_get([]), lambda: role
    return load


def test_app_is_its_own_ephemeral_name_with_the_existing_secret():
    assert entry.APP_NAME == 'sv-adhoc-corp-history-fetch-20261030' and 'stockvision-ml' not in entry.APP_NAME
    assert "modal.Secret.from_name('stockvision-finlab')" in SOURCE
    assert 'retries=0' in SOURCE and 'timeout=TIMEOUT_S' in SOURCE and entry.TIMEOUT_S <= 900
    assert 'gpu' not in SOURCE.split('@app.function')[1].split('\n')[0]


def test_remote_returns_data_and_env_names_only(capsys):
    result = entry.remote_fetch(ENV, sdk_loader=loader(), clock=clock())
    assert result['ok'] and result['finlab_calls'] == 7 and result['role'] == 'vip'
    assert result['env_names_present'] == ['FINLAB_API_KEY', 'FINLAB_REFRESH_TOKEN', 'FINLAB_SESSION_ID']
    blob = json.dumps({k: v for k, v in result.items() if k != 'blobs'}) + ''.join(
        b.decode('latin-1') for b in result['blobs'].values())
    assert SECRET not in blob
    captured = capsys.readouterr()
    assert SECRET not in captured.out + captured.err


@pytest.mark.parametrize('fail', ['vendor', 'role', 'auth'])
def test_errors_come_back_scrubbed_without_a_traceback(fail, capsys):
    def get(key):
        raise RuntimeError(f'refresh failed for key={SECRET} session={SECRET}s')
    if fail == 'auth':
        def bad(env, fetcher):
            raise RuntimeError('token ' + env['FINLAB_REFRESH_TOKEN'] + ' rejected')
        result = entry.remote_fetch(ENV, sdk_loader=bad)
    else:
        result = entry.remote_fetch(ENV, sdk_loader=loader(role='free' if fail == 'role' else 'vip',
                                                           get=get if fail == 'vendor' else None))
    assert result['ok'] is False and 'blobs' not in result
    assert SECRET not in json.dumps(result)
    if fail == 'role':
        assert result['error_type'] == 'SystemExit' and 'finlab_role_insufficient:free' in result['error']
    captured = capsys.readouterr()
    assert SECRET not in captured.out + captured.err and 'Traceback' not in captured.out + captured.err


def test_local_side_seals_the_remote_bytes_with_the_registry(tmp_path):
    from compile_corporate_history import compile_history
    fetcher = entry._fetcher()
    (tmp_path / 'days.json').write_text(json.dumps([*DAYS, '2026-10-05']))
    (tmp_path / 'universe.json').write_text(json.dumps(['0056', '2330', '1101', '020000']))
    tick = clock()
    result = entry.remote_fetch(ENV, sdk_loader=loader(), clock=tick)
    report = fetcher.seal_fetch(tmp_path, result, days_path=tmp_path / 'days.json',
                                universe_path=tmp_path / 'universe.json', auth_mode='modal:' + result['auth_mode'],
                                http_get=lambda url: b'["0050","0056"]', clock=tick,
                                report_extra={'modal_app': entry.APP_NAME})
    assert report['finlab_calls'] == 7 and report['twse_calls'] == 1 and report['modal_app'] == entry.APP_NAME
    spec = json.loads((tmp_path / 'spec.json').read_text(encoding='utf-8'))
    _, days, scoped, _ = compile_history(spec, base=tmp_path)
    assert days == DAYS and scoped == ['1101', '2330', '0056']
    assert all(SECRET.encode() not in p.read_bytes() for p in tmp_path.iterdir())


def test_real_sdk_session_mode_checks_the_token_and_never_logs_in(monkeypatch):
    import types
    record = {}
    data = types.SimpleNamespace(CacheStorage=type('CacheStorage', (), {}), get_role=lambda: 'vip',
                                 set_storage=lambda storage: record.update(storage=storage),
                                 get=lambda key, **kwargs: record.update(get=(key, kwargs)))
    finlab = types.ModuleType('finlab'); finlab.data = data; finlab.login = lambda *a: pytest.fail('login')
    auth = types.ModuleType('finlab.auth'); auth.get_id_token = lambda: None
    monkeypatch.setitem(sys.modules, 'finlab', finlab)
    monkeypatch.setitem(sys.modules, 'finlab.data', data)
    monkeypatch.setitem(sys.modules, 'finlab.auth', auth)
    with pytest.raises(SystemExit, match='finlab_session_rejected'):
        entry._real_sdk(ENV, entry._fetcher())
    auth.get_id_token = lambda: 'id-token'
    mode, get, role = entry._real_sdk(ENV, entry._fetcher())
    get('dividend_announcement')
    assert mode == 'session_env' and record['get'] == ('dividend_announcement', {'force_download': True})
    with pytest.raises(SystemExit, match='server rejected'):
        finlab.login()
