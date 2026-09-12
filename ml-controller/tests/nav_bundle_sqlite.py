"""Private SQLite transport for original bundle transaction tests; never production."""
import re
import sqlite3
from pathlib import Path


def ensure_prediction_schema(conn):
    root = Path(__file__).parents[2]
    schema = (root / 'worker/domain-schemas/learning.sql').read_text(encoding='utf-8')
    conn.executescript(re.search(r'CREATE TABLE IF NOT EXISTS predictions \([\s\S]*?\n\);', schema).group())
    if 'signal_raw' not in {row[1] for row in conn.execute('PRAGMA table_info(predictions)')}:
        conn.executescript((root / 'worker/migration_trade_signal_expand.sql').read_text(encoding='utf-8'))


class SQLiteBundle:
    def __init__(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        schema = (Path(__file__).parents[2] / 'worker/domain-schemas/learning.sql').read_text(encoding='utf-8')
        for table in ('model_artifact_registry', 'model_champion_pointers', 'model_champion_history',
                      'active8_ensemble_artifacts_v1', 'active8_ensemble_pointer_v1'):
            statement = re.search(r'CREATE TABLE IF NOT EXISTS ' + table + r' \([\s\S]*?\n\);', schema)
            assert statement, table
            self.conn.executescript(statement.group())
        self.conn.execute('PRAGMA foreign_keys=ON')
        self.before_batch = None
        self.fail_after = None
        self.fail_after_writes = None
        self.lose_ack = False
        self.batches = 0
        self.statements = []

    def insert(self, table, row):
        self.conn.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})", list(row.values()))

    def query(self, sql, params=None):
        return [dict(row) for row in self.conn.execute(sql, params or [])]

    def atomic_batch_execute(self, statements, timeout=0):
        self.batches += 1
        self.statements = statements
        if self.before_batch:
            self.before_batch(self.conn)
            self.conn.commit()  # Another writer completed before this transaction.
        try:
            self.conn.execute('BEGIN')
            writes = 0
            for index, (sql, params) in enumerate(statements):
                self.conn.execute(sql, params).fetchall()
                writes += int(sql.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')))
                if index == self.fail_after or writes == self.fail_after_writes:
                    raise RuntimeError('injected_mid_batch_failure')
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise
        if self.lose_ack:
            self.lose_ack = False
            raise TimeoutError('commit_ack_lost')
        return {'atomic': True, 'total': len(statements)}
