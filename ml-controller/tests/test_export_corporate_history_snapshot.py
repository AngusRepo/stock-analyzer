"""Operator export of a ga_research_dataset carrying the compiled history: dry run writes nothing."""
import hashlib
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

import export_corporate_history_snapshot as export  # noqa: E402
from test_compile_corporate_history import DAYS, spec_fixture  # noqa: E402


@pytest.fixture
def artifact(tmp_path):
    from compile_corporate_history import compile_history
    frame, _, _, _ = compile_history(spec_fixture(tmp_path), base=tmp_path, captured_at='2026-10-03T01:00:00+00:00')
    path = tmp_path / 'history.parquet'
    frame.write_parquet(path)
    (tmp_path / 'days.json').write_text(json.dumps([*DAYS, '2026-10-05']))
    return path


def args(artifact, end=DAYS[-1], *extra, sha=None):
    sha = sha or hashlib.sha256(artifact.read_bytes()).hexdigest()
    return [str(artifact), '--business-date', end, '--start-date', DAYS[0], '--end-date', end,
            '--calendar', str(artifact.parent / 'days.json'), '--expected-sha256', sha, *extra]


ROUTED = {'MULTI_D1_ACTIVE_DOMAINS': ','.join(export.EXPORT_DOMAINS),
          **{f'CF_D1_{d.upper()}_DB_ID': f'id-{d}' for d in export.EXPORT_DOMAINS}}


def test_dry_run_checks_the_artifact_and_writes_nothing(artifact, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, 'services.dataset_snapshot_exporter', None)  # importing it would fail
    monkeypatch.setenv('CF_API_TOKEN', 'secret-value-123')
    before = sorted(p.name for p in artifact.parent.iterdir())
    assert export.main(args(artifact, DAYS[-1], '--dry-run')) == 0
    out = capsys.readouterr().out
    report = json.loads(out)
    assert report['artifact_sha256'] == hashlib.sha256(artifact.read_bytes()).hexdigest()
    assert report['request']['kind'] == 'ga_research_dataset' and report['window_sessions'] == len(DAYS)
    assert 'CF_API_TOKEN' in report['env_present'] and 'secret-value-123' not in out
    assert sorted(p.name for p in artifact.parent.iterdir()) == before


def test_a_window_past_the_history_or_calendar_is_refused(artifact):
    with pytest.raises(ValueError, match='corporate_history_sessions_missing:2026-10-05'):
        export.main(args(artifact, '2026-10-05', '--dry-run'))
    with pytest.raises(SystemExit, match='not_a_calendar_session'):
        export.main(args(artifact, '2026-11-06', '--dry-run'))


def test_a_real_export_needs_confirmation_and_env(artifact, monkeypatch):
    with pytest.raises(SystemExit, match='confirm-write'):
        export.main(args(artifact))
    for name in export.REQUIRED_ENV:
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(SystemExit, match='export_env_missing'):
        export.main(args(artifact, DAYS[-1], '--confirm-write'))


def test_the_artifact_must_be_the_one_compile_reported(artifact):
    with pytest.raises(SystemExit, match='sha256_mismatch'):
        export.main(args(artifact, DAYS[-1], '--dry-run', sha='0' * 64))


def test_every_domain_must_route_to_its_own_database(artifact, monkeypatch, capsys):
    for name in export.REQUIRED_ENV:
        monkeypatch.setenv(name, 'x')
    monkeypatch.setenv('CF_D1_DB_ID', 'legacy-db')
    monkeypatch.delenv('MULTI_D1_ACTIVE_DOMAINS')
    assert export.main(args(artifact, DAYS[-1], '--dry-run')) == 0
    out = capsys.readouterr().out
    routing = json.loads(out)['d1_routing']
    assert set(routing.values()) == {'legacy_fallback'} and 'legacy-db' not in out
    monkeypatch.setenv('MULTI_D1_ACTIVE_DOMAINS', 'core,market')
    with pytest.raises(SystemExit, match='export_d1_domain_not_routed:learning,ops,paper'):
        export.main(args(artifact, DAYS[-1], '--confirm-write'))
    for name, value in ROUTED.items():
        monkeypatch.setenv(name, value)
    seen = {}
    def fake_export(req):
        seen['req'] = req
        return {'status': 'ready', 'snapshot': {'snapshot_id': 'ga', 'kind': req.kind}}
    import types
    monkeypatch.setitem(sys.modules, 'services.dataset_snapshot_exporter', types.SimpleNamespace(
        DatasetSnapshotExportRequest=_Req, export_backtest_dataset_snapshot=fake_export))
    assert export.main(args(artifact, DAYS[-1], '--confirm-write')) == 0
    assert seen['req'].producer_run_id.startswith(f'corporate-history-{DAYS[-1]}-')
    assert seen['req'].corporate_history_checksum == hashlib.sha256(artifact.read_bytes()).hexdigest()


class _Req:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
        self.kind = 'ga_research_dataset'
