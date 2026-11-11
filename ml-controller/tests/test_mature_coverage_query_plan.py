"""The indexed join must preserve every coverage count on mixed lineage data."""
from pathlib import Path
import random
import re
import sqlite3


ORIGINAL_MATRIX_COUNTS='''matrix_counts AS (
        SELECT m.signal_date, m.producer_run_id, m.labeler_version,
               m.reference_contract_version, COUNT(*) matrix_rows
          FROM strategy_label_matrix_v4 m
          JOIN target_heads t
            ON t.signal_date=m.signal_date
           AND t.producer_run_id=m.producer_run_id
         GROUP BY m.signal_date, m.producer_run_id, m.labeler_version, m.reference_contract_version
      )
'''


def test_indexed_coverage_matches_original_join_with_missing_and_duplicate_lineage():
    source=Path(__file__).resolve().parents[2].joinpath('worker/src/lib/matureSelectionEvidenceRecovery.ts').read_text(encoding='utf-8')
    start=source.index('WITH target_heads(signal_date, producer_run_id)')
    sql=source[start:source.index('`).bind(',start)].replace('${targetRows}','(?, ?), (?, ?), (?, ?), (?, ?)')
    original=sql.replace('formal_runs AS MATERIALIZED (','formal_runs AS (').replace(
        'FROM target_heads t\n        CROSS JOIN selection_reference_snapshots_v1 r',
        'FROM selection_reference_snapshots_v1 r\n        JOIN target_heads t')
    # The per-lineage matrix probe must count exactly what the grouped join counted.
    original,probes=re.subn(r'matrix_counts AS MATERIALIZED \([\s\S]*?\n      \)\n',ORIGINAL_MATRIX_COUNTS,original)
    assert probes==1
    db=sqlite3.connect(':memory:')
    db.executescript("""
      CREATE TABLE strategy_label_matrix_runs_v4(producer_run_id,signal_date,expected_cell_count,persisted_cell_count,labeler_version,reference_contract_version,status);
      CREATE TABLE price_horizon_labels_v1(price_date,stock_id,projection_version);
      CREATE TABLE price_horizon_label_rejections_v1(price_date,stock_id,projection_version);
      CREATE TABLE canonical_selection_labels_v4(signal_date,symbol,producer_run_id,reference_contract_version,label_schema_version,adjustment_source);
      CREATE TABLE canonical_selection_label_rejections_v4(signal_date,symbol,producer_run_id);
      CREATE TABLE strategy_label_matrix_v4(signal_date,producer_run_id,labeler_version,reference_contract_version);
      CREATE TABLE selection_reference_snapshots_v1(signal_date,producer_run_id,stock_id,symbol,strategy_labeler_version,feature_contract_version,hard_gate_passed);
      CREATE INDEX refs_date ON selection_reference_snapshots_v1(signal_date,hard_gate_passed);
    """)
    rng=random.Random(24)
    for date,producer in [('2026-09-01','a'),('2026-09-02','b'),('2026-09-03','outside'),('2026-09-01','noncanonical')]:
        for labeler,reference in [('label1','current'),('label2','current'),('legacy-label','legacy'),('wrong','current')]:
            db.execute('INSERT INTO strategy_label_matrix_runs_v4 VALUES (?,?,?,?,?,?,?)',(producer,date,100,90,labeler,reference,'ready'))
            for stock in range(12):
                symbol=str(stock)
                db.execute('INSERT INTO selection_reference_snapshots_v1 VALUES (?,?,?,?,?,?,?)',
                    (date,producer,stock if stock%5 else None,symbol,labeler,reference,int(stock%7!=0)))
                for _ in range(rng.randrange(3)):
                    db.execute('INSERT INTO strategy_label_matrix_v4 VALUES (?,?,?,?)',(date,producer,labeler,reference))
                if stock%3:
                    db.execute('INSERT INTO canonical_selection_labels_v4 VALUES (?,?,?,?,?,?)',(date,symbol,producer,reference,'schema','adjusted'))
                else:
                    db.execute('INSERT INTO canonical_selection_label_rejections_v4 VALUES (?,?,?)',(date,symbol,producer))
        for stock in range(12):
            table='price_horizon_labels_v1' if stock%3 else 'price_horizon_label_rejections_v1'
            for _ in range(2):db.execute(f'INSERT INTO {table} VALUES (?,?,?)',(date,stock,'projection'))
    # A formal lineage with no matrix rows: probed as 0 where the grouped join had no row.
    db.execute("DELETE FROM strategy_label_matrix_v4 WHERE signal_date='2026-09-02' AND labeler_version='label2'")
    # Single-lineage producers, so no other lineage's MAX hides the probe: 'c' has
    # no matrix rows for its formal lineage, 'd' has some; both also carry rows of
    # the same labeler under a non-formal reference contract.
    for date,producer,own_rows in [('2026-09-04','c',0),('2026-09-05','d',5)]:
        db.execute('INSERT INTO strategy_label_matrix_runs_v4 VALUES (?,?,?,?,?,?,?)',(producer,date,100,90,'label1','current','ready'))
        for stock in range(6):
            db.execute('INSERT INTO selection_reference_snapshots_v1 VALUES (?,?,?,?,?,?,?)',(date,producer,stock,str(stock),'label1','current',1))
        for _ in range(own_rows):db.execute('INSERT INTO strategy_label_matrix_v4 VALUES (?,?,?,?)',(date,producer,'label1','current'))
        for _ in range(3):db.execute('INSERT INTO strategy_label_matrix_v4 VALUES (?,?,?,?)',(date,producer,'label1','legacy'))
    params=['2026-09-01','a','2026-09-02','b','2026-09-04','c','2026-09-05','d',
            'current','label1','label2','legacy','legacy-label','label2','projection','projection','schema','adjusted']
    before=db.execute(original,params).fetchall()
    after=db.execute(sql,params).fetchall()
    assert len(before)==4 and before==after
    matrix_rows={row[1]:row[7] for row in before}
    assert matrix_rows['c']==0 and matrix_rows['d']==5
    # Both mutants of the probe must change the result.
    probe_count='(SELECT COUNT(*) FROM strategy_label_matrix_v4 m'
    contract='\n                   AND m.reference_contract_version=k.reference_contract_version'
    assert sql.count(probe_count)==1 and sql.count(contract)==1
    for mutant in [sql.replace(probe_count,'(SELECT COUNT(*)+(COUNT(*)=0) FROM strategy_label_matrix_v4 m'),
                   sql.replace(contract,'')]:
        assert db.execute(mutant,params).fetchall()!=before
    plans=[r[3] for r in db.execute('EXPLAIN QUERY PLAN '+sql,params)]
    assert any('SEARCH r USING INDEX refs_date' in row for row in plans)
    db.close()
