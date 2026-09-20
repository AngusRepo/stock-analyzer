"""Generate cross-language read-model fixture through native journal accounting."""
from pathlib import Path
import sys
import json
from copy import deepcopy
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'ml-controller'), str(ROOT/'ml-controller/tests')]
from test_paired_nav_journal import DB, packet, seal, receipt, buy, NOW
from services.paired_nav_journal import materialize_pair, stage_execution_receipt
from services.strategy_ab import SCHEMA, RECIPES, FEE_TERMS

def main():
    db = DB()
    tag = {'schema_version':SCHEMA,'experiment_id':'a'*64,'role':'A',
           'recipe':RECIPES['A'],'fee_terms':deepcopy(FEE_TERMS)}
    with patch('services.paired_nav_comparison.resolve_comparison', return_value={'strategy_ab':tag}):
        for day, previous in [('2026-09-08', None), ('2026-09-09', '2026-09-08')]:
            content = packet(day, previous)
            frozen = seal(db, content, previous or '2026-09-07')
            fills = [{**buy(day), 'shares':200, 'price':200, 'commission':57}] if previous is None else []
            execution = receipt(content, frozen, fills=fills, marks={'2330':200 if previous is None else 210})
            stage_execution_receipt(execution=execution, query=db.query, writer=db.writer, now=NOW)
            materialize_pair(snapshot_id=frozen['snapshot_id'],session_date=day, execution=execution,
                             query=db.query,writer=db.writer,now=NOW)
    payload = {table:db.query('SELECT * FROM '+table, []) for table in (
        'paired_nav_daily_journal_v1','paired_nav_frozen_manifests_v1','paired_nav_frozen_parts_v1')}
    target = ROOT/'worker/test-fixtures/strategy-ab-native-journal.json'
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
    print(target)
if __name__ == '__main__': main()
