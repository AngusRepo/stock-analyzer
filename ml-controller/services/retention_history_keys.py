"""Bounded duplicate detection; spill large scans without slowing small reads with disk I/O."""
from contextlib import contextmanager, closing, ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import sqlite3

MEMORY_KEY_LIMIT = 16384


@contextmanager
def history_keys():
    with ExitStack() as stack:
        memory = {}
        db = None
        def remember(key, digest):
            nonlocal db
            if db is None:
                previous = memory.get(key)
                if previous is not None:
                    if previous != digest:
                        raise RuntimeError('retention_archive_revision_conflict')
                    return False
                if len(memory) < MEMORY_KEY_LIMIT:
                    memory[key] = digest
                    return True
                directory = stack.enter_context(TemporaryDirectory(prefix='stockvision-cold-read-'))
                db = stack.enter_context(closing(sqlite3.connect(str(Path(directory) / 'keys.sqlite'))))
                db.execute('PRAGMA cache_size=-2048')
                db.execute('PRAGMA journal_mode=OFF')
                db.execute('CREATE TABLE seen (key TEXT PRIMARY KEY, digest BLOB NOT NULL) WITHOUT ROWID')
                db.executemany('INSERT INTO seen VALUES (?,?)',
                    ((json.dumps(k, ensure_ascii=False, separators=(',', ':')), v) for k, v in memory.items()))
                memory.clear()
            encoded = json.dumps(key, ensure_ascii=False, separators=(',', ':'))
            inserted = db.execute('INSERT OR IGNORE INTO seen VALUES (?,?)', (encoded, digest))
            if inserted.rowcount == 1:
                return True
            previous = db.execute('SELECT digest FROM seen WHERE key=?', (encoded,)).fetchone()
            if previous is None or previous[0] != digest:
                raise RuntimeError('retention_archive_revision_conflict')
            return False
        yield remember
