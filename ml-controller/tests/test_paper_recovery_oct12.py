from datetime import datetime, timezone
import pytest
from services import premarket_pipeline as p
from services.pipeline_canonical_window import assert_canonical_window_open


def test_oct12_paper_cutoff_keeps_date_checksum_and_freshness(monkeypatch):
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER', 'premarket_once_v1')
    now = datetime(2026, 10, 12, 4, 0, tzinfo=timezone.utc)
    context = {'trade_date': '2026-10-12', 'cutoff': now.isoformat()}
    context['checksum'] = p.digest(context)
    receipt = {'run_date': '2026-10-08'}
    p.validate_context(receipt, context, now=now)
    for wrong in ({'run_date': '2026-10-07'}, {'run_date': '2026-10-12'}):
        with pytest.raises(ValueError, match='cutoff'):
            p.validate_context(wrong, context, now=now)
    with pytest.raises(ValueError, match='stale'):
        p.validate_context(receipt, context, now=datetime(2026, 10, 12, 6, 0, tzinfo=timezone.utc))
    context['checksum'] = '0' * 64
    with pytest.raises(ValueError, match='checksum'):
        p.validate_context(receipt, context, now=now)
    monkeypatch.delenv('PIPELINE_DAILY_PLAN_OWNER')
    with pytest.raises(ValueError, match='cutoff'):
        p.validate_context(receipt, context, now=now)


def test_canonical_window_requires_worker_paper_admission_and_exact_date(monkeypatch):
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER', 'premarket_once_v1')
    monkeypatch.setenv('STOCKVISION_WORKER_URL', 'https://worker.example')
    monkeypatch.setenv('STOCKVISION_AUTH_TOKEN', 'fixture')
    boundary = {'signalDate': '2026-10-08', 'nextSessionDate': '2026-10-12', 'scope': 'paper',
                'allowed': True, 'reason': 'authorized_paper_recovery_20261012'}
    class Response:
        status_code = 200
        def json(self):
            return {'schema_version': 'historical-learning-lineage-boundary-v1',
                    'calendar_owner': 'worker.schedulerPolicy.nextTwTradingDate', 'boundary': boundary}
    def check(now=datetime(2026, 10, 12, 4, 0, tzinfo=timezone.utc)):
        assert_canonical_window_open('2026-10-08', now=now, http_get=lambda *a, **k: Response())
    check()
    for key, value in [('scope','live'), ('allowed',False), ('nextSessionDate','2026-10-13')]:
        old = boundary[key]; boundary[key] = value
        with pytest.raises(RuntimeError, match='closed'): check()
        boundary[key] = old
    with pytest.raises(RuntimeError, match='closed'):
        check(datetime(2026, 10, 13, 4, 0, tzinfo=timezone.utc))
