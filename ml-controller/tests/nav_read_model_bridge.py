"""Feed original persisted journals to the actual Worker reader, not a mock.

Synthetic execution fixtures prove accounting/transport only, never market ROI.
"""
import json
from pathlib import Path
import sqlite3
import subprocess


def assert_original_read_model(db, tmp_path, *, business_date, owner, sessions):
    target = tmp_path / ('original-nav-read-model-' + owner + '.sqlite')
    db.conn.commit()
    with sqlite3.connect(target) as saved:
        db.conn.backup(saved)
    script = """
import { DatabaseSync } from 'node:sqlite';
import reader from './src/lib/pairedNavReadModel.ts';
const sql=new DatabaseSync(process.argv[1],{readOnly:true});
class Statement {
 constructor(text,values=[]){this.text=text;this.values=values;}
 bind(...values){return new Statement(this.text,values);}
 async first(){return sql.prepare(this.text).get(...this.values)??null;}
 async all(){return {success:true,results:sql.prepare(this.text).all(...this.values)};}
}
try { console.log(JSON.stringify(await reader.readPairedNav({prepare:q=>new Statement(q)},process.argv[2]))); }
finally {sql.close();}
"""
    result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', script,
        str(target), business_date], cwd=Path(__file__).parents[2] / 'worker',
        capture_output=True, text=True, encoding='utf-8', timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    body = json.loads(result.stdout)
    assert body['status'] == 'observing', body
    found = [pair for pair in body['pairs'] if pair.get('comparison', {}).get('owner') == owner]
    assert found and all(pair['sessions'] == sessions for pair in found), body
    assert body['promotion_allowed'] is False and body['ev_prediction_dates_added'] == 0
    return body
