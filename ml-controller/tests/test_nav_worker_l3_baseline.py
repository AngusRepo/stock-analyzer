"""Original L3 NAV publication -> Worker baseline checks; synthetic, NOT ROI."""
import os
from pathlib import Path
import sqlite3
import subprocess
import json
from datetime import datetime

from test_nav_l3_adoption import ready, publish
from test_paired_nav_l3_candidate import prepared
from test_paired_nav_candidate_collection import environment


def test_worker_accepts_original_nav_commit_without_forging_offline_pass(ready, tmp_path):
    client, candidate, *_ = ready
    assert publish(ready)['readback_verified']
    assert client.query('SELECT validation_decision FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?',
                        [candidate['artifact_id']])[0]['validation_decision'] == 'FAIL'
    target = tmp_path / 'original-l3-nav.sqlite'
    with sqlite3.connect(target) as saved:
        client.conn.backup(saved)
    from services.active8_nav_baseline import read_committed_nav_baseline
    formal = client.query('SELECT * FROM active8_ensemble_pointer_v1', [])[0]
    before = client.conn.total_changes
    bridge = read_committed_nav_baseline(formal=formal, query=client.query,
        now=datetime.fromisoformat('2026-09-22T14:00:00+00:00'))
    assert client.conn.total_changes == before
    exported = tmp_path / 'original-committed-baseline.json'
    exported.write_text(json.dumps(bridge, ensure_ascii=False), encoding='utf-8')
    child_env = {**os.environ, 'NAV_L3_SQLITE': str(target), 'NAV_L3_NOW': '2026-09-22T14:00:00Z',
        'NAV_L3_BASELINE': str(exported)}
    child_env.pop('NODE_TEST_CONTEXT', None)
    checked = subprocess.run(['node', '--import', 'tsx', '--test', 'src/lib/active8NavBaseline.test.ts'],
        cwd=Path(__file__).parents[2] / 'worker', env=child_env,
        capture_output=True, text=True, encoding='utf-8', timeout=90)
    assert checked.returncode == 0, checked.stdout + checked.stderr
