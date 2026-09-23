import sqlite3
from pathlib import Path
import pytest
from services.retention_prediction_projection import read_latest_prediction_projection


def fixture():
    db = sqlite3.connect(':memory:'); db.row_factory = sqlite3.Row
    schema = (Path(__file__).resolve().parents[2] / 'worker/domain-schemas/learning.sql').read_text(encoding='utf-8')
    ddl = schema[schema.index('CREATE TABLE IF NOT EXISTS predictions ('):].split(';',1)[0]
    db.execute(ddl)
    rows = [dict(id=i,stock_id=1,model_name='ensemble',generated_at=f'2020-01-{i:02} 00:00:00',
                forecast_data='ALPHA_CONTEXT' if i%2 else 'unrelated',actual_return_pct=-0.01*i,
                direction_correct=None) for i in range(1,10)]
    for row in rows:
        db.execute('INSERT INTO predictions('+','.join(row)+') VALUES('+','.join('?' for _ in row)+')',list(row.values()))
    return db, ddl, rows


def test_projection_equals_original_sql_before_and_after_storage_move():
    db,ddl,rows=fixture()
    sql="""SELECT generated_at,forecast_data,actual_return_pct FROM predictions WHERE model_name='ensemble'
      AND forecast_data LIKE '%alpha_context%' AND actual_return_pct IS NOT NULL ORDER BY generated_at DESC LIMIT ?"""
    query=lambda sql,args:[dict(r) for r in db.execute(sql,args)]
    expected=query(sql,[4])
    cold_rows=rows[:7]
    db.execute('DELETE FROM predictions WHERE id<=7')
    calls=[]
    def cold(start,end,**kwargs):
        calls.append((start,end))
        yield from reversed(cold_rows)
    try:
        actual=read_latest_prediction_projection(sql,[4],query_hot=query,cold_reader=cold)
        assert actual==expected
        assert len(calls)==1 and calls[0][0]=='0000-01-01'
    finally: db.close()


def test_full_hot_result_bounds_cold_scan_without_changing_ties_or_projection():
    db,ddl,rows=fixture()
    sql="SELECT generated_at FROM predictions WHERE model_name='ensemble' ORDER BY generated_at DESC LIMIT ?"
    calls=[]
    def cold(start,end,**kwargs):
        calls.append(start)
        if False: yield
    query=lambda sql,args:[dict(r) for r in db.execute(sql,args)]
    try:
        assert read_latest_prediction_projection(sql,[2],query_hot=query,cold_reader=cold)==query(sql,[2])
        assert calls==['2020-01-08 00:00:00']
    finally:db.close()


def test_cold_failure_is_not_silently_replaced_with_short_hot_history():
    db,ddl,rows=fixture()
    sql="SELECT generated_at FROM predictions WHERE model_name='ensemble' ORDER BY generated_at DESC LIMIT ?"
    def cold(*a,**k):
        yield rows[0]
        raise RuntimeError('checksum_mismatch')
    try:
        with pytest.raises(RuntimeError,match='checksum_mismatch'):
            read_latest_prediction_projection(sql,[20],query_hot=lambda s,p:[dict(r) for r in db.execute(s,p)],cold_reader=cold)
    finally:db.close()
