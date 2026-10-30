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


def args(artifact, end=DAYS[-1], *extra):
    return [str(artifact), '--business-date', end, '--start-date', DAYS[0], '--end-date', end,
            '--calendar', str(artifact.parent / 'days.json'), *extra]


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
