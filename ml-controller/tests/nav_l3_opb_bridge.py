"""Test-only read adapter; original Python verifiers, private SQLite, no network.

One request on stdin by default. With --serve it answers one JSON request per
stdin line, so a test pays the interpreter start and imports once instead of
on every read. Each request still opens its own read-only connection and
applies its own patches; nothing read is kept between requests.
"""
import json
import sqlite3
import sys
import traceback
from contextlib import ExitStack, closing
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

from services import active8_nav_adoption as authority
from services.active8_nav_baseline import read_committed_nav_baseline
from services.opb_nav_control import capture_nav_control
from services import model_artifact_registry as registry, model_serving_resolver as resolver


def handle(request):
    database = 'file:' + request['database'].replace('\\', '/') + '?mode=ro'
    with closing(sqlite3.connect(database, uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        ev_state_reads = 0
        def query(sql, params=None):
            nonlocal ev_state_reads
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
                return read_committed_nav_baseline(formal=request['formal'], query=query, now=clock)
            if request['mode'] == 'serving':
                # Actual production-path readers, not merely existence of a grant.
                pool = resolver.load_d1_champion_pool(sidecar_models=())
                bundle = registry.load_active8_ensemble_serving_bundle()
                eligible = [name for name in bundle['selected_models'] if pool['models'][name]['serving_eligible']]
                return {'verified': bundle['status'] == 'production' and len(eligible) == len(bundle['selected_models']) > 0,
                    'bundle_status': bundle['status'], 'eligible_model_count': len(eligible)}
            context, grant = capture_nav_control(query=query, trading_config=request['current']['trading_config'],
                risk_config=request['current']['risk_config'], now=clock)
            return {'verified': grant is not None, 'context': context}


def serve():
    # Replies own stdout; anything the verifiers print goes to stderr.
    replies, sys.stdout = sys.stdout, sys.stderr
    for line in sys.stdin:
        message = json.loads(line)
        try:
            reply = json.dumps({'id': message['id'], 'result': handle(message['request'])})
        except Exception:
            reply = json.dumps({'id': message['id'], 'error': traceback.format_exc()})
        replies.write(reply + '\n')
        replies.flush()


if __name__ == '__main__':
    if sys.argv[1:] == ['--serve']:
        serve()
    else:
        print(json.dumps(handle(json.load(sys.stdin))))
