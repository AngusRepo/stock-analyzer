"""Test-only read adapter; original Python verifiers, private SQLite, no network."""
import json
import sqlite3
import sys
from contextlib import ExitStack
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

from services import active8_nav_adoption as authority
from services.active8_nav_baseline import read_committed_nav_baseline
from services.opb_nav_control import capture_nav_control
from services import model_artifact_registry as registry, model_serving_resolver as resolver

request = json.load(sys.stdin)
with sqlite3.connect('file:' + request['database'].replace('\\', '/') + '?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    ev_state_reads = 0
    def query(sql, params=None):
        global ev_state_reads
        rows = [dict(row) for row in db.execute(sql, params or [])]
        # Test-only inconsistent read. No DB mutation and no runtime verifier
        # replacement: the original source fence must detect this race.
        if (request.get('readFault') == 'ev_state_after_first_read'
                and sql.startswith('SELECT * FROM expected_return_owner_state_v2')
                and params == ['l4_alpha_ev']):
            ev_state_reads += 1
            if ev_state_reads > 1:
                for row in rows:
                    row['reason_code'] = 'concurrent-source-change'
        return rows
    clock = datetime.fromisoformat(request['now'])
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.astimezone(tz) if tz else clock.replace(tzinfo=None)
    with ExitStack() as scope:
        scope.enter_context(patch.object(authority, 'current_execution_configuration', return_value=request['current']))
        scope.enter_context(patch.object(authority, 'datetime', Clock))
        scope.enter_context(patch.object(registry, 'd1_client', SimpleNamespace(query=query)))
        scope.enter_context(patch('socket.socket.connect', side_effect=AssertionError('private verifier cannot access network')))
        if request['mode'] == 'baseline':
            result = read_committed_nav_baseline(formal=request['formal'], query=query, now=clock)
        elif request['mode'] == 'serving':
            # Actual production-path readers, not merely existence of a grant.
            pool = resolver.load_d1_champion_pool(sidecar_models=())
            bundle = registry.load_active8_ensemble_serving_bundle()
            eligible = [name for name in bundle['selected_models'] if pool['models'][name]['serving_eligible']]
            result = {'verified': bundle['status'] == 'production' and len(eligible) == len(bundle['selected_models']) > 0,
                'bundle_status': bundle['status'], 'eligible_model_count': len(eligible)}
        else:
            context, grant = capture_nav_control(query=query, trading_config=request['current']['trading_config'],
                risk_config=request['current']['risk_config'], now=clock)
            result = {'verified': grant is not None, 'context': context}
    print(json.dumps(result))
