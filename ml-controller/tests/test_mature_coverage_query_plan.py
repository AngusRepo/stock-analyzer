"""The indexed join must preserve every coverage count on mixed lineage data."""
from pathlib import Path
import random
import sqlite3


def test_indexed_coverage_matches_original_join_with_missing_and_duplicate_lineage():
    source=Path(__file__).resolve().parents[2].joinpath('worker/src/lib/matureSelectionEvidenceRecovery.ts').read_text(encoding='utf-8')
    start=source.index('WITH target_heads(signal_date, producer_run_id)')
    sql=source[start:source.index('`).bind(',start)].replace('${targetRows}','(?, ?), (?, ?)')
    original=sql.replace('formal_runs AS MATERIALIZED (','formal_runs AS (').replace(
        'FROM target_heads t\n        CROSS JOIN selection_reference_snapshots_v1 r',
        'FROM selection_reference_snapshots_v1 r\n        JOIN target_heads t')
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
    params=['2026-09-01','a','2026-09-02','b','current','label1','label2','legacy','legacy-label','label2','projection','projection','schema','adjusted']
    before=db.execute(original,params).fetchall()
    after=db.execute(sql,params).fetchall()
    assert len(before)==2 and before==after
    plans=[r[3] for r in db.execute('EXPLAIN QUERY PLAN '+sql,params)]
    assert any('SEARCH r USING INDEX refs_date' in row for row in plans)
    db.close()
