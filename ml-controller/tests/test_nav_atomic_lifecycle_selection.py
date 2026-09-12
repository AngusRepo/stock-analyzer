"""Selection/lifecycle contracts only; no numerical qualification or I/O."""
from copy import deepcopy
import pytest
from test_nav_daily_adoption import entry
from services.paired_nav_daily_adoption import select_daily_adoption_requests


@pytest.mark.parametrize('state', ['published', 'published_superseded', 'baseline_changed', 'awaiting_current_source', 'observing'])
def test_closed_or_changed_atomic_comparator_cannot_starve_next_ready_candidate(state):
    old = entry(owner='atomic_strategy', state=state, day='2026-08-25')
    new = entry(owner='atomic_strategy', state='candidate', day='2026-09-23', token='b')
    old['payload']['prospective_validation']['mean_return'] = 100
    new['payload']['prospective_validation']['mean_return'] = -1
    original = deepcopy([old, new])
    requests, waiting = select_daily_adoption_requests([old, new])
    assert requests['atomic_strategy'] == new['payload'] and not waiting
    assert [old, new] == original
    assert select_daily_adoption_requests([old])[0] == {}
