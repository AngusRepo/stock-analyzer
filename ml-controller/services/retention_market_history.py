"""Bounded cold market history using original SQL and natural-key hot precedence."""
import hashlib
import json
import sqlite3
from contextlib import closing
from services.retention_history_keys import history_keys
from services.d1_domain_client import client_proxy_for_domain
from services.retention_archive import (verify_archive, download_archive,
    create_history_projection_table, insert_history_projection_row)
from services.retention_history import source_release_verified

TABLES = {
 'stock_prices': ('date', ('stock_id','date')),
 'technical_indicators': ('date', ('stock_id','date')),
 'chip_data': ('date', ('symbol','date')),
 'margin_data': ('date', ('stock_id','date')),
 'canonical_fundamental_features': ('available_date', ('stock_id','period','source')),
}


def archived_market_projection(table, sql, params, start_date, end_date, *, query_hot=None, query_ops=None, download=None):
    """Single-table SELECT projection; caller combines with its existing hot query.

    Never shorten dates, impute missing prices, hide lost release ACKs, or choose
    silently between conflicting archive revisions. One <=1MiB chunk in memory.
    """
    if table not in TABLES or not sql.lstrip().upper().startswith('SELECT '):
        raise ValueError('retention_market_projection_contract_invalid')
    hot=query_hot or client_proxy_for_domain('market').query
    ops=query_ops or client_proxy_for_domain('ops').query
    fetch=download or (lambda m: download_archive(m, require_restore_schema=False))
    date_column, keys=TABLES[table];cursor=''
    domain='retention_canonical_market_hot_v1_'+table
    with history_keys() as remember:
        while True:
            manifests=ops("""SELECT a.artifact_id,a.domain,a.schema_version,a.checksum,a.row_count,a.metadata_json,
              (SELECT MAX(i.completed_at) FROM data_retention_run_items i WHERE i.status='success'
               AND i.deleted_rows=a.row_count AND CASE WHEN json_valid(i.evidence_json)
               THEN json_extract(i.evidence_json,'$.artifact_id') END=a.artifact_id
               AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.checksum') END=a.checksum) release_verified_at
              FROM run_artifacts a WHERE a.domain=? AND a.schema_version='d1-retention-hot-window-drain-v1'
              AND a.retention_class='ten_year_cold_archive' AND a.status='ready'
              AND a.payload_deleted_at IS NULL AND a.artifact_id>?
              AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_end') END,'9999-12-31')>=?
              AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_start') END,'0000-01-01')<=?
              ORDER BY a.artifact_id LIMIT 100""",[domain,cursor,start_date,end_date])
            if not manifests:return
            for manifest in manifests:
                cursor=manifest['artifact_id'];meta=json.loads(manifest.get('metadata_json') or '{}')
                if (meta.get('coverage_start') or '')>end_date or (meta.get('coverage_end') or '9999')<start_date:continue
                payload=verify_archive(fetch(manifest),manifest,require_restore_schema=False)
                if payload['dataset_id']!=table or payload['source_domain']!='market':
                    raise ValueError('retention_market_source_mismatch')
                rows=[r for r in payload['rows'] if start_date<=str(r.get(date_column) or '')<=end_date]
                if not rows:continue
                predicate = ' AND '.join("t.\"{}\" IS json_extract(j.value, '$.{}')".format(k,k) for k in keys)
                key_rows=[{k:r[k] for k in keys} for r in rows]
                present={tuple(r[k] for k in keys) for r in hot(
                    f'SELECT '+','.join('t."'+k+'"' for k in keys)+f' FROM "{table}" t JOIN json_each(?) j ON {predicate}',
                    [json.dumps(key_rows,ensure_ascii=False)])}
                missing=[r for r in rows if tuple(r[k] for k in keys) not in present]
                if not missing:continue
                if not manifest.get('release_verified_at') and not source_release_verified(hot,manifest,'market',table):
                    raise RuntimeError('retention_market_release_receipt_incomplete:'+cursor)
                with closing(sqlite3.connect(':memory:')) as db:
                    db.row_factory=sqlite3.Row
                    create_history_projection_table(db,payload,hot)
                    for r in missing:
                        clean={k:v for k,v in r.items() if k not in {'__cursor_key','__archive_date'}}
                        key=tuple(clean[k] for k in keys)
                        h=hashlib.sha256(json.dumps(clean,sort_keys=True,ensure_ascii=False).encode()).digest()
                        if not remember(key,h):continue
                        insert_history_projection_row(db,table,clean)
                    for row in db.execute(sql,params):yield dict(row)
            if len(manifests)<100:return
