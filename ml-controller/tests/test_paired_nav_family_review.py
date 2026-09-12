"""Real denominator/ledger source; injected p-values test governance only, not ROI."""
from dataclasses import asdict

import pytest

from services import paired_nav_family_review as review
from services.paired_nav_effect_inference import NavEffectPolicy
from test_paired_nav_lifecycle import environment, registered_old, successor_context, collect, register_successors, commit

EFFECT = NavEffectPolicy('test-review-only', 10, .05, 3, 1999)
BUDGET = review.NavReviewBudget('test-protocol-not-production', .05, (('first', .025), ('final', .025)))


def run(db, *, page_size=50):
    return review.review_nav_families(business_date='2026-09-08', query=db.query,
        effect_policy=EFFECT, budget=BUDGET, review_id='first', page_size=page_size)


def stub_numerical_effect(monkeypatch, p=.02):
    # Only numerical effect is stubbed. Original population, snapshot, receipt,
    # accounting and comparison verification still run against isolated SQLite.
    monkeypatch.setattr(review, '_evaluate_pair', lambda pair, policy: {
        **pair.summary(), 'inference_status': 'evaluated_fixed_sample',
        'bootstrap_positive_tail_p': p, 'mean_daily_nav_delta': .001})


def test_holm_counts_unavailable_hypotheses_and_stepdown_is_monotone():
    values = {'candidate-a': .01, 'candidate-b': .025, 'candidate-missing': None}
    result = review.holm_adjust(values)
    assert result == {'candidate-a': pytest.approx(.03), 'candidate-b': pytest.approx(.05), 'candidate-missing': None}
    assert review.holm_adjust(dict(reversed(list(values.items())))) == result
    assert review.holm_adjust({'a': .04, 'b': .04, 'c': 1.}) == {'a': .12, 'b': .12, 'c': 1.}
    assert review.holm_adjust({}) == {}
    assert review.holm_adjust({'a': None, 'b': None}) == {'a': None, 'b': None}


@pytest.mark.parametrize('value', [True, -.1, 1.1, float('nan'), float('inf'), '0.05'])
def test_holm_rejects_invalid_numerical_claims(value):
    with pytest.raises(ValueError, match='invalid_p_value'):
        review.holm_adjust({'bad': value})


def test_budget_requires_known_review_and_cannot_allocate_full_alpha_each_day():
    assert BUDGET.allocation('first') == BUDGET.allocation('final') == .025
    for key in ('tomorrow', '', None, []):
        with pytest.raises(ValueError, match='unallocated_review'):
            BUDGET.allocation(key)
    with pytest.raises(ValueError, match='budget_exceeded'):
        review.NavReviewBudget('daily-reset', .05, (('day1', .05), ('day2', .05)))
    with pytest.raises(ValueError, match='unallocated_review'):
        review.review_nav_families(business_date='2026-09-08',
            query=lambda *args: pytest.fail('unknown review must fail before source reads'),
            effect_policy=EFFECT, budget=BUDGET, review_id='unallocated')


@pytest.mark.parametrize('field,value', [
    ('protocol_id', ''), ('family_alpha', True), ('family_alpha', .5),
    ('review_alphas', []), ('review_alphas', ()),
    ('review_alphas', (('first', .02), ('first', .02))),
    ('review_alphas', (('first', True),)),
    ('review_alphas', (('first', .025), ('final', .02500000000000001))),
])
def test_invalid_or_mutable_budget_is_rejected(field, value):
    with pytest.raises(ValueError, match='nav_review_'):
        review.NavReviewBudget(**{**asdict(BUDGET), field: value})


def test_new_unmature_candidates_do_not_disappear_from_the_denominator(environment, monkeypatch):
    db, *_ = environment
    registered_old(environment)
    stub_numerical_effect(monkeypatch)
    before = run(db)
    assert all(f['hypothesis_count'] == 1 for f in before['families'])
    assert all(f['hypotheses'][0]['numerical_support'] for f in before['families'])
    collect(environment, successor_context(environment, monkeypatch))
    after = run(db)
    assert all(f['hypothesis_count'] == 2 for f in after['families'])
    for family in after['families']:
        known = [p for p in family['hypotheses'] if p['raw_positive_tail_p'] is not None]
        absent = [p for p in family['hypotheses'] if p['raw_positive_tail_p'] is None]
        assert len(known) == len(absent) == 1
        assert known[0]['holm_adjusted_p'] == pytest.approx(.04)
        assert not known[0]['numerical_support']
        assert absent[0]['availability_reason'] == 'nav_evidence_missing'
        assert absent[0]['holm_adjusted_p'] is None
    db.conn.execute('DELETE FROM model_artifact_registry')
    assert run(db, page_size=1) == after
    assert after['budget_status'] == 'calculated_not_durably_reserved'
    assert after['promotion_allowed'] is False


def test_source_gaps_block_numerical_support_without_suppressing_original_evidence(environment, monkeypatch):
    from services import paired_nav_candidate_collection as collection
    from test_paired_nav_ev_selection import add_new_cohort
    db, bucket, *_ = environment
    registered_old(environment)
    stub_numerical_effect(monkeypatch, p=.0001)
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    add_new_cohort(db, bucket)
    context = successor_context(environment, monkeypatch, changed=False)
    original, calls = collection.freeze_snapshot, 0
    def interrupted(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError('fixture_unpublished_family_member')
        return original(**kwargs)
    monkeypatch.setattr(collection, 'freeze_snapshot', interrupted)
    collect(environment, context)
    result = run(db)
    assert result['candidate_population']['unmaterialized_selections']
    for family in result['families']:
        if family['unmaterialized_selections']:
            assert family['denominator_status'] == 'unresolved'
            assert not any(h['numerical_support'] for h in family['hypotheses'])
    assert len(result['effects']) == 2
    monkeypatch.setattr(collection, 'freeze_snapshot', original)
    collect(environment, context)
    assert all(f['denominator_status'] == 'materialized_hypotheses_complete' for f in run(db)['families'])


def test_closed_comparison_cannot_reenter_and_successor_has_no_inherited_evidence(environment, monkeypatch):
    db, *_ = environment
    registered_old(environment)
    new = collect(environment, successor_context(environment, monkeypatch))
    register_successors(db, new['plans'])
    commit(db, new)
    stub_numerical_effect(monkeypatch, p=.0001)
    result = run(db)
    reasons = [p['availability_reason'] for f in result['families'] for p in f['hypotheses']]
    assert reasons.count('comparison_closed') == 2 and reasons.count('nav_evidence_missing') == 2
    assert not any(p['numerical_support'] for f in result['families'] for p in f['hypotheses'])
    assert len(result['effects']) == 2


def test_original_effect_reader_is_used_when_not_stubbed(environment):
    db, *_ = environment
    registered_old(environment)
    result = run(db)
    assert all(p['availability_reason'] == 'nav_sessions_incomplete'
        for f in result['families'] for p in f['hypotheses'])
    assert result['promotion_allowed'] is False


def test_missing_next_day_receipt_cannot_reuse_yesterdays_positive_effect(environment, monkeypatch):
    db, *_ = environment
    registered_old(environment)
    next_day = collect(environment, successor_context(environment, monkeypatch, changed=False))
    register_successors(db, next_day['plans'])
    stub_numerical_effect(monkeypatch, p=.0001)
    result = review.review_nav_families(business_date='2026-09-09', query=db.query,
        effect_policy=EFFECT, budget=BUDGET, review_id='first')
    assert all(h['availability_reason'] == 'registered_evidence_missing'
        for family in result['families'] for h in family['hypotheses'])
    assert not any(h['numerical_support'] for family in result['families'] for h in family['hypotheses'])


def test_numerical_resolution_limit_is_visible_not_mislabeled_weak_performance(environment, monkeypatch):
    db, *_ = environment
    registered_old(environment)
    stub_numerical_effect(monkeypatch, p=.0001)
    short = NavEffectPolicy('test-low-resolution', 10, .05, 3, 20)
    result = review.review_nav_families(business_date='2026-09-08', query=db.query,
        effect_policy=short, budget=BUDGET, review_id='first')
    assert all(not f['tail_resolution_sufficient'] for f in result['families'])
    assert all(f['minimum_resolvable_holm_p'] == pytest.approx(1 / 21) for f in result['families'])
    assert not any(h['numerical_support'] for f in result['families'] for h in f['hypotheses'])


def test_alias_does_not_inflate_count_or_select_the_best_of_two_executions(environment, monkeypatch):
    from services.paired_nav_journal import freeze_snapshot, read_snapshot, stage_execution_receipt, mature_staged_pairs
    from test_paired_nav_lifecycle import stamp
    from test_paired_nav_journal import receipt
    db, *_ = environment
    plans, registrations = registered_old(environment)
    plan_ref = next(p for p in plans['plans'] if p['owner'] == 'allocator_ev_fusion')
    plan = read_snapshot(db.query, plan_ref['snapshot_id'])['payload']['content']
    alias = {**plan, 'pair_id': 'alias-same-economic-hypothesis'}
    sealed = freeze_snapshot(signal_date='2026-09-07', source_run_id=alias['pair_id'],
        snapshot_kind='allocation_pair', content=alias, query=db.query, writer=db.writer, now=stamp('2026-09-07'))
    stub_numerical_effect(monkeypatch)
    first = run(db)
    family = next(f for f in first['families'] if f['owner'] == 'allocator_ev_fusion')
    assert family['hypothesis_count'] == 1 and len(family['hypotheses'][0]['pair_ids']) == 2
    assert family['hypotheses'][0]['numerical_support']
    packets = [read_snapshot(db.query, r['snapshot_id'])['payload']['content'] for r in registrations]
    old = next(p for p in packets if p['owner'] == 'allocator_ev_fusion')
    packet = {**old, 'pair_id': alias['pair_id'], 'allocation_snapshot_id': sealed['snapshot_id']}
    execution = freeze_snapshot(signal_date='2026-09-07', source_run_id=alias['pair_id'],
        snapshot_kind='execution_pair', content=packet, query=db.query, writer=db.writer, now=stamp('2026-09-07'))
    stage_execution_receipt(execution=receipt(packet, execution), query=db.query, writer=db.writer, now=stamp('2026-09-08'))
    mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer, now=stamp('2026-09-08'))
    final = run(db)
    family = next(f for f in final['families'] if f['owner'] == 'allocator_ev_fusion')
    assert family['hypothesis_count'] == 1
    assert family['hypotheses'][0]['availability_reason'] == 'multiple_executions_for_same_hypothesis'
    assert family['hypotheses'][0]['raw_positive_tail_p'] is None
    assert not family['hypotheses'][0]['numerical_support']
