"""Fixed synthetic L3 models -> original allocations, ledger and family review.

Prices and execution fills are synthetic transport fixtures, NOT investment ROI
or native execution-parity proof. The statistical reader/evaluator is unmocked.
"""
from copy import deepcopy
import asyncio
from datetime import datetime, timezone

import pytest

from services import paired_nav_l3_candidate as l3, paired_nav_collection as capture
from services import paired_nav_lifecycle as lifecycle
from services import paired_nav_daily_review as daily
from services.paired_nav_candidate_decision import read_nav_candidate_decision
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot, stage_execution_receipt, mature_staged_pairs
from services.active8_score_semantics import normalize_active8_challenger_scores
from test_paired_nav_l3_candidate import prepared
from test_paired_nav_candidate_collection import environment
import test_paired_nav_l3_candidate as source
from test_paired_nav_review_store import migrate
from test_paired_nav_journal import packet, receipt, buy, FEES


SESSIONS = ['2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-14',
            '2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-21']


def stamp(day):
    return datetime.fromisoformat(day + 'T14:00:00+00:00')


def build_mature_l3(prepared, monkeypatch, *, days=10, with_environment=False, with_all_owners=False,
                    start_day=0, stage_only=False):
    db, bucket, manifest, original_inputs, _ = prepared
    migrate(db)
    signal = SESSIONS[start_day - 1] if start_day else '2026-09-07'
    previous = signal if start_day else None
    original_capture = capture.run_and_capture_allocation
    for index, session in enumerate(SESSIONS[start_day:days], start=start_day):
        clock = stamp(signal)
        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return clock.astimezone(tz) if tz else clock.replace(tzinfo=None)
        monkeypatch.setattr(lifecycle, 'datetime', Clock)
        for module in (capture, l3):
            monkeypatch.setattr(module, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=clock))
        monkeypatch.setattr(source, 'DAY', signal)
        inputs = deepcopy(original_inputs)
        inputs['filter_options']['run_date'] = signal
        for row in inputs['screener_recs']:
            row['date'] = signal
        # Fixed values observed anew on each synthetic day, never actual history.
        for payload in inputs['payloads']:
            for field in ('prices', 'indicators', 'chips'):
                for row in payload[field]:
                    row['date'] = signal
        candidate_rows = {row['model']: row for row in manifest['active8_shadow_candidates']}
        normalize_active8_challenger_scores(inputs['predictions'], candidate_rows=candidate_rows, run_date=signal)
        selection = l3.load_candidate_ensembles(manifest=manifest, signal_date=signal,
            decision_cutoff=signal + 'T10:00:00Z', query=db.query)
        if with_environment:
            from test_paired_nav_execution_environment import environment_packet
            execution_environment = environment_packet(day=signal)
            def capture_with_environment(**kwargs):
                return original_capture(**kwargs, execution_environment_reader=lambda: deepcopy(execution_environment))
            monkeypatch.setattr(source, 'run_and_capture_allocation', capture_with_environment)
        captured = source.seal((db, bucket, manifest, inputs, selection))
        ev_plans = []
        if with_all_owners:
            from services import paired_nav_candidate_collection as ev
            monkeypatch.setattr(ev, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=clock))
            all_plans = ev.collect_candidate_allocations(snapshot_id=captured['snapshot_id'],
                query=db.query, writer=db.writer, bucket=bucket)['plans']
            assert {item['owner'] for item in all_plans} == {'ensemble', 'l4_alpha_ev', 'allocator_ev_fusion'}
            ev_plans = [item for item in all_plans if item['owner'] != 'ensemble']
            assert len(ev_plans) == 2
        planned = l3.collect_ensemble_allocations(snapshot_id=captured['snapshot_id'], query=db.query, writer=db.writer)
        assert len(planned['plans']) == 1
        item = planned['plans'][0]
        plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
        p = packet(session, previous)
        p.update({key: plan[key] for key in ('pair_id','owner','candidate_checksum','baseline_checksum')})
        p.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
                 schedule=[{'observed_at': session + 'T00:00:00Z'}])
        p['configuration_checksum'] = digest(p['configuration'])
        if with_environment:
            p.update(execution_owner_version=execution_environment['execution_owner_version'],
                account_id=execution_environment['account_id'], kv_read_policy=execution_environment['kv_read_policy'],
                source_context=execution_environment['source_context'], variables=execution_environment['source_context']['variables'])
        saved = freeze_snapshot(signal_date=signal, source_run_id=p['pair_id'], snapshot_kind='execution_pair',
            content=p, query=db.query, writer=db.writer, now=clock)
        result = receipt(p, saved, marks={'2330': 100, '2317': 108 + index*8})
        if index == 0:
            result['arms']['baseline']['fills'] = [buy(session)]
            result['arms']['candidate']['fills'] = [{**buy(session), 'symbol': '2317'}]
        stage_execution_receipt(execution=result, query=db.query, writer=db.writer, now=stamp(session))
        # Full-job fixture must account for every admitted owner. EV arms use
        # identical flat marks/fills: legitimate no-improvement HOLD, not PASS.
        for ev_item in ev_plans:
            ev_plan = read_snapshot(db.query, ev_item['snapshot_id'])['payload']['content']
            ep = packet(session, previous)
            ep.update({key: ev_plan[key] for key in ('pair_id','owner','candidate_checksum','baseline_checksum')})
            ep.update(allocation_snapshot_id=ev_item['snapshot_id'],
                configuration={**ev_plan['configuration'], 'fees': FEES},
                schedule=[{'observed_at': session + 'T00:00:00Z'}])
            ep['configuration_checksum'] = digest(ep['configuration'])
            if with_environment:
                ep.update(execution_owner_version=execution_environment['execution_owner_version'],
                    account_id=execution_environment['account_id'], kv_read_policy=execution_environment['kv_read_policy'],
                    source_context=execution_environment['source_context'], variables=execution_environment['source_context']['variables'])
            es = freeze_snapshot(signal_date=signal, source_run_id=ep['pair_id'], snapshot_kind='execution_pair',
                content=ep, query=db.query, writer=db.writer, now=clock)
            er = receipt(ep, es, marks={'2330': 100, '2317': 100})
            if index == 0:
                for arm in ('baseline', 'candidate'):
                    er['arms'][arm]['fills'] = [buy(session)]
            stage_execution_receipt(execution=er, query=db.query, writer=db.writer, now=stamp(session))
        if not stage_only:
            mature_staged_pairs(business_date=session, query=db.query, writer=db.writer, now=stamp(session))
        signal, previous = session, session
    if stage_only:
        return None, None, plan
    day = SESSIONS[days-1]
    reviewed = daily.run_daily_nav_reviews(business_date=day, query=db.query, writer=db.writer, now=stamp(day))
    candidate = selection['candidates'][0]['registry']
    nav = read_nav_candidate_decision(owner='ensemble', candidate_checksum=candidate['payload_checksum'],
        candidate_artifact_id=candidate['artifact_id'], business_date=day, query=db.query, now=stamp(day))
    return nav, reviewed, plan


def test_original_l3_ten_session_review_is_real_not_a_renamed_ev_gate(prepared, monkeypatch):
    nav, reviewed, _ = build_mature_l3(prepared, monkeypatch)
    assert nav['owner'] == 'ensemble' and nav['evaluable_date_count'] == 10
    assert nav['decision'] == 'PASS', nav
    assert nav['review_record_id'] and nav['review_record_checksum']
    assert nav['review_evidence_unit'] == 'original_costed_paired_daily_nav'
    assert nav['promotion_allowed'] is False
    from services.paired_nav_l3_daily import refresh_registered_l3_nav_decisions
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    candidates = []
    db = prepared[0]
    projected = refresh_registered_l3_nav_decisions(business_date=SESSIONS[-1], query=db.query,
        now=stamp(SESSIONS[-1]), adoption_candidates=candidates)
    assert projected['decisions'][0]['decision'] == 'PASS'
    assert candidates[0]['registry_state'] == 'candidate'
    from routers import model_pool
    from services import model_artifact_registry as registry
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', db)
    monkeypatch.setattr(registry, 'd1_client', db)
    result = asyncio.run(run_daily_ev_adoption(candidates=candidates, business_date=SESSIONS[-1]))
    assert result['status'] == 'incomplete', result
    # This fixture has no complete serving registry/pointers. It reaches the
    # original publisher, but must not manufacture a successful publication.
    assert result['stage'] == 'ensemble_publication'
