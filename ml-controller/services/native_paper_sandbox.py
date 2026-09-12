"""Run the existing Worker paper engine against a private SQLite capability host.

The child receives no credentials or production bindings. SQL, KV and artifacts
share one transaction. This is execution infrastructure, not an alternate fill
engine, a prospective-input attestor, or a statistical promotion owner.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timezone
from typing import Any

from services.paired_nav_journal import digest, encode

# Consume unquoted runs inside literals in one operation. Repeating an
# alternation for EACH character used ~124 MB of regex stack for a 1 MB sealed
# JSON value and exhausted memory restoring ordinary whole-session snapshots.
_TOKENS = re.compile(r"--[^\n]*|/\*[\s\S]*?\*/|'[^']*(?:''[^']*)*'|\"[^\"]*(?:\"\"[^\"]*)*\"|`[^`]*(?:``[^`]*)*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\s+|.")


def clock_sql(sql: str) -> str:
    """Redirect only SQL clock expressions, never quoted data or identifiers.

    Registering a real SQLite function also preserves dynamic schema defaults:
    an INSERT on a later frame receives that frame's clock, not bootstrap time.
    """
    prior: list[str] = []
    output = []
    for match in _TOKENS.finditer(sql):
        token = match.group()
        replacement = token
        if token.upper() == 'CURRENT_TIMESTAMP':
            replacement = '(native_now())'
        elif token.lower() == "'now'" and len(prior) >= 2 and prior[-1] == '(' and prior[-2].lower() in {
            'datetime', 'date', 'time', 'julianday', 'unixepoch',
        }:
            replacement = 'native_now()'
        elif token.lower() == "'now'" and len(prior) >= 4 and prior[-1] == ',' and prior[-3] == '(' and prior[-4].lower() == 'strftime':
            replacement = 'native_now()'
        output.append(replacement)
        if not token.isspace() and not token.startswith(('--', '/*')):
            prior.append(token)
            del prior[:-4]
    return ''.join(output)


class PrivatePaperStore:
    def __init__(self, state_sql: str, state_checksum: str, inputs: dict[str, Any], *, capture_source=None):
        if hashlib.sha256(state_sql.encode()).hexdigest() != state_checksum:
            raise ValueError('native_paper_state_checksum_mismatch')
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.now_ms: float | None = None
        self.current: dict[str, Any] | None = None
        self.inputs = json.loads(encode(inputs))
        self.capture_source = capture_source
        self.in_frame = False
        self.db.create_function('native_now', 0, self._clock)
        self.db.set_authorizer(self._authorize)
        try:
            self.db.executescript(clock_sql(state_sql))
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS _native_private_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_ms REAL,metadata TEXT);
                CREATE TABLE IF NOT EXISTS _native_private_artifacts(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS _native_private_kv_owned(key TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS _native_private_clock(id INTEGER PRIMARY KEY CHECK(id=1),now_ms REAL NOT NULL);
            ''')
            # Snapshot restore order is independent of table FK order. Enable
            # enforcement before executing any native frame; child SQL cannot
            # disable it through the restricted PRAGMA capability.
            self.db.set_authorizer(None)
            self.db.execute('PRAGMA foreign_keys=ON')
            self.db.set_authorizer(self._authorize)
            previous_clock = self.db.execute('SELECT now_ms FROM _native_private_clock WHERE id=1').fetchone()
            if previous_clock is not None:
                self.now_ms = previous_clock[0]
            self.db.execute('BEGIN')
        except BaseException:
            self.db.close()
            raise

    def _clock(self):
        if self.now_ms is None:
            raise ValueError('native_paper_clock_unset')
        return datetime.fromtimestamp(self.now_ms / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M:%S')

    @staticmethod
    def _authorize(action, first, second, database, trigger):
        if action in {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH}:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION and str(second).lower() in {'load_extension', 'readfile', 'writefile'}:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_PRAGMA and str(first).lower() not in {'table_info', 'index_info', 'index_list', 'foreign_key_list'}:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    def _sql(self, packet):
        statement = packet['sql']
        # Transaction control belongs to this host; a native .prepare() cannot
        # commit half a session or open a second database.
        first = next((m.group() for m in _TOKENS.finditer(statement)
                      if not m.group().isspace() and not m.group().startswith(('--', '/*'))), '')
        if first.upper() in {'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'}:
            raise ValueError('native_paper_transaction_control_forbidden')
        source_tables = (self.current or {}).get('source_tables') or {}
        if source_tables:
            reads, writes = set(), set()
            def inspect(action, first, second, database, trigger):
                result = self._authorize(action, first, second, database, trigger)
                if action == sqlite3.SQLITE_READ:
                    reads.add(first)
                if action in {sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE}:
                    writes.add(first)
                return result
            self.db.set_authorizer(inspect)
            try:
                # EXPLAIN compiles without executing; SQLite resolves aliases,
                # CTEs/subqueries and triggers instead of a regex SQL allowlist.
                self.db.execute('EXPLAIN ' + clock_sql(statement), packet.get('args') or []).fetchall()
            finally:
                self.db.set_authorizer(self._authorize)
            remote = reads & set(source_tables)
            if writes & set(source_tables):
                raise ValueError('native_paper_source_write_forbidden')
            if remote:
                if writes or reads - set(source_tables):
                    raise ValueError('native_paper_mixed_private_source_query')
                if {source_tables[table] for table in remote} != {packet.get('domain')}:
                    raise ValueError('native_paper_source_domain_mismatch')
                result = self._external('source_sql', packet)
                if result.get('success') is not True or not isinstance(result.get('results'), list):
                    raise ValueError('native_paper_source_query_incomplete')
                return result
        cursor = self.db.execute(clock_sql(statement), packet.get('args') or [])
        rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
        changes = self.db.execute('SELECT changes()').fetchone()[0]
        return {'success': True, 'results': rows, 'meta': {'changes': changes, 'last_row_id': cursor.lastrowid}}

    def _external(self, op, packet):
        field = {'frozen_fetch': 'responses', 'frozen_ai': 'ai_responses', 'source_sql': 'sql_responses',
                 'source_kv': 'kv_responses'}[op]
        matches = [row for row in self.current.get(field, []) if row['request'] == packet]
        if len(matches) > 1:
            raise ValueError('native_paper_frozen_response_missing_or_ambiguous')
        if matches:
            self._observe_source_clock(matches[0])
            return matches[0]['response']
        if self.capture_source is None:
            raise ValueError('native_paper_frozen_response_missing_or_ambiguous')
        # Capture implementations must durably seal the actual source response
        # before returning. Replay has no capture capability and cannot backfill
        # a missing intraday input with a newer value.
        record = self.capture_source.read(op, json.loads(encode(packet)), self.current)
        if record.get('request') != packet or 'response' not in record:
            raise ValueError('native_paper_source_record_invalid')
        self.current.setdefault(field, []).append(json.loads(encode(record)))
        self._observe_source_clock(record)
        return record['response']

    def _observe_source_clock(self, record):
        # Legacy synthetic frozen fixtures have no external capture timestamp.
        # Real source records always include it; their clock is replayed exactly.
        if 'captured_at' not in record:
            if 'identity' in record:
                raise ValueError('native_paper_source_capture_clock_missing')
            return
        stamp = datetime.fromisoformat(record['captured_at'].replace('Z', '+00:00'))
        due = datetime.fromisoformat(self.current['observed_at'].replace('Z', '+00:00'))
        from services.native_paper_time import frame_capture_deadline
        if stamp.tzinfo is None or not due <= stamp < frame_capture_deadline(self.current):
            raise ValueError('native_paper_source_capture_clock_invalid')
        self.now_ms = max(self.now_ms, int(stamp.timestamp() * 1000))

    def dispatch(self, op: str, packet: dict[str, Any]):
        if op == 'frame_input':
            if self.in_frame:
                raise ValueError('native_paper_frame_already_open')
            frame = self.inputs.get(packet['input_id'])
            if frame is None or frame['observed_at'] != packet['observed_at'] or frame['stage'] != packet['stage']:
                raise ValueError('native_paper_frozen_frame_missing')
            stamp = datetime.fromisoformat(frame['observed_at'].replace('Z', '+00:00'))
            if stamp.tzinfo is None:
                raise ValueError('native_paper_frame_clock_mismatch')
            elapsed = stamp.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
            milliseconds = elapsed.days * 86400000 + elapsed.seconds * 1000 + elapsed.microseconds // 1000
            if milliseconds != packet['now_ms']:
                raise ValueError('native_paper_frame_clock_mismatch')
            if frame.get('cron') != packet.get('cron'):
                raise ValueError('native_paper_frame_cron_mismatch')
            self.current = frame
            self.now_ms = max(self.now_ms or packet['now_ms'], packet['now_ms'])
            return None
        if op == 'frame_begin':
            if self.in_frame or self.current is None:
                raise ValueError('native_paper_frame_transaction_invalid')
            self.db.execute('SAVEPOINT native_frame')
            self.in_frame = True
            return None
        if op in {'frame_commit', 'frame_rollback'}:
            if not self.in_frame:
                raise ValueError('native_paper_frame_not_open')
            if op == 'frame_rollback':
                self.db.execute('ROLLBACK TO native_frame')
            else:
                self.db.execute('INSERT INTO _native_private_clock(id,now_ms) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET now_ms=excluded.now_ms', (self.now_ms,))
            self.db.execute('RELEASE native_frame')
            self.in_frame = False
            return None
        if not self.in_frame:
            raise ValueError('native_paper_operation_outside_frame')
        if op == 'sql':
            return self._sql(packet)
        if op == 'batch':
            self.db.execute('SAVEPOINT native_batch')
            try:
                result = [self._sql(statement) for statement in packet['statements']]
                self.db.execute('RELEASE native_batch')
                return result
            except BaseException:
                self.db.execute('ROLLBACK TO native_batch')
                self.db.execute('RELEASE native_batch')
                raise
        if op == 'kv_get':
            row = self.db.execute('SELECT value FROM _native_private_kv WHERE key=? AND (expires_ms IS NULL OR expires_ms>?)',
                                  (packet['key'], self.now_ms)).fetchone()
            if row:
                return row[0]
            owned = self.db.execute('SELECT 1 FROM _native_private_kv_owned WHERE key=?', (packet['key'],)).fetchone()
            if owned or not self.current.get('capture_kv_reads'):
                return None
            # Never import the formal account's pending buys, leases or warn
            # state by treating every missing private key as a shared source.
            key = packet['key']
            policy = self.current.get('kv_read_policy') or {}
            owners = [(len(prefix), owner) for owner in ('private', 'source')
                      for prefix in policy.get(owner, []) if isinstance(prefix, str) and prefix and key.startswith(prefix)]
            if not owners:
                raise ValueError('native_paper_kv_owner_unregistered')
            longest = max(length for length, _ in owners)
            chosen = {owner for length, owner in owners if length == longest}
            if len(chosen) != 1:
                raise ValueError('native_paper_kv_owner_ambiguous')
            if chosen == {'private'}:
                return None
            value = self._external('source_kv', {'key': packet['key']})
            if value is not None and not isinstance(value, str):
                raise ValueError('native_paper_source_kv_nontext')
            return value
        if op == 'kv_put':
            self.db.execute('INSERT OR IGNORE INTO _native_private_kv_owned VALUES(?)', (packet['key'],))
            options = packet.get('options') or {}
            expiry = options.get('expiration')
            ttl = options.get('expirationTtl')
            expires = expiry * 1000 if expiry is not None else self.now_ms + ttl * 1000 if ttl is not None else None
            if expires is not None and expires <= self.now_ms:
                raise ValueError('native_paper_expiry_invalid')
            self.db.execute('INSERT OR REPLACE INTO _native_private_kv VALUES(?,?,?,?)',
                            (packet['key'], packet['value'], expires, encode(options.get('metadata'))))
            return None
        if op == 'kv_delete':
            self.db.execute('INSERT OR IGNORE INTO _native_private_kv_owned VALUES(?)', (packet['key'],))
            self.db.execute('DELETE FROM _native_private_kv WHERE key=?', (packet['key'],))
            return None
        if op == 'kv_list':
            if self.current.get('capture_kv_reads'):
                raise ValueError('native_paper_source_kv_list_not_sealed')
            offset = int(packet.get('cursor') or 0)
            limit = max(1, min(1000, int(packet.get('limit') or 1000)))
            rows = self.db.execute('SELECT key FROM _native_private_kv WHERE substr(key,1,?)=? AND (expires_ms IS NULL OR expires_ms>?) ORDER BY key LIMIT ? OFFSET ?',
                (len(packet.get('prefix', '')), packet.get('prefix', ''), self.now_ms, limit + 1, offset)).fetchall()
            return {'keys': [{'name': row[0]} for row in rows[:limit]], 'list_complete': len(rows) <= limit,
                    'cursor': str(offset + limit) if len(rows) > limit else ''}
        if op in {'artifact_get', 'artifact_put'}:
            if op == 'artifact_put':
                self.db.execute('INSERT OR REPLACE INTO _native_private_artifacts VALUES(?,?)', (packet['key'], packet['value']))
                return None
            row = self.db.execute('SELECT value FROM _native_private_artifacts WHERE key=?', (packet['key'],)).fetchone()
            return row[0] if row else None
        if op in {'frozen_fetch', 'frozen_ai'}:
            return self._external(op, packet)
        raise ValueError('native_paper_unknown_operation')

    def export(self):
        if self.in_frame:
            raise ValueError('native_paper_unfinished_frame')
        self.db.execute('COMMIT')
        sql = '\n'.join(self.db.iterdump())
        return {'state_sql': sql, 'state_checksum': hashlib.sha256(sql.encode()).hexdigest()}


def native_execution_identity(runner: Path | None = None) -> str:
    entry = runner or Path('/app/worker-dist/native-paper.cjs')
    if not entry.is_file():
        raise ValueError('native_paper_runtime_missing')
    return 'native-paper-v1:' + digest({
        'bundle': hashlib.sha256(entry.read_bytes()).hexdigest(),
        'private_host': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'pipeline': {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in ('native_paper_source_capture.py', 'native_paper_bootstrap.py', 'native_paper_state.py',
                           'paired_native_session.py', 'paired_native_collector.py', 'paired_native_registration.py',
                           'paired_native_models.py',
                           'native_paper_read_capabilities.py', 'paired_nav_journal.py', 'paired_nav_schema.py',
                           'paired_nav_chain.py',
                           'paired_nav_execution_environment.py', 'adaptive.py',
                           'native_paper_debate.py', 'debate_execution_scope.py', 'debate_service.py',
                           'llm_debate_client.py', 'finlab_corporate_actions.py',
                           'mops_corporate_terms.py', 'native_paper_time.py', 'paper_corporate_source.py',
                           'paired_native_runtime.py', 'paired_native_sources.py', 'etf_corporate_source.py',
                           'capital_corporate_source.py', 'subscription_rights.py')},
        'rescore': hashlib.sha256(Path(__file__).parent.parent.joinpath('routers/intraday.py').read_bytes()).hexdigest(),
    })


def native_runtime_manifest(runner: Path | None = None) -> dict:
    entry = runner or Path('/app/worker-dist/native-paper.cjs')
    node = shutil.which('node')
    if not node or not entry.is_file():
        raise ValueError('native_paper_runtime_missing')
    clean_env = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR') if key in os.environ}
    result = subprocess.run([node, str(entry.resolve())], input=encode({'type': 'manifest'}) + '\n',
        capture_output=True, text=True, encoding='utf-8', env=clean_env, timeout=15, check=True,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    packet = json.loads(result.stdout)
    if packet.get('type') != 'manifest' or not packet.get('tables'):
        raise ValueError('native_paper_manifest_missing')
    return {**packet, 'execution_owner_version': native_execution_identity(entry)}


def run_native_paper_frames(*, state_sql: str, state_checksum: str, frame_inputs: dict[str, Any],
                            frames: list[dict[str, Any]], account_id: int, variables: dict[str, str],
                            runner: Path | None = None, node_binary: str | None = None,
                            expected_execution_owner_version: str | None = None,
                            capture_source=None,
                            timeout_seconds: float = 120) -> dict[str, Any]:
    """One private account, real native functions, no externally visible writes.

    Export occurs only after every requested frame succeeds. Consumers must still
    attest the full exchange session and BOTH arms before publishing a receipt.
    """
    entry = runner or Path('/app/worker-dist/native-paper.cjs')
    node = node_binary or shutil.which('node')
    if not node or not entry.is_file():
        raise ValueError('native_paper_runtime_missing')
    for key, value in variables.items():
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or not isinstance(value, str):
            raise ValueError('sealed_paper_variable_invalid')
        if re.search(r'TOKEN|SECRET|API_KEY|PASSWORD|WEBHOOK', key) and value and value != '__SEALED_CREDENTIAL__':
            raise ValueError('sealed_paper_credentials_forbidden')
    owner_version = native_execution_identity(entry)
    if expected_execution_owner_version is not None and owner_version != expected_execution_owner_version:
        raise ValueError('native_paper_execution_owner_changed')
    store = PrivatePaperStore(state_sql, state_checksum, frame_inputs, capture_source=capture_source)
    child = None
    inbox: queue.Queue = queue.Queue()
    failure_codes: list[str] = []
    try:
        # No CF/GCP/FinLab/ML credentials reach the subprocess. Windows needs its
        # OS directory for Node startup; it is not a trading capability.
        clean_env = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR') if key in os.environ}
        child = subprocess.Popen([str(node), str(entry.resolve())], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding='utf-8', env=clean_env, shell=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        def read_lines():
            try:
                for line in child.stdout:
                    inbox.put(line)
            finally:
                inbox.put(None)
        reader = threading.Thread(target=read_lines, daemon=True)
        reader.start()
        child.stdin.write(encode({'account_id': account_id, 'variables': variables, 'frames': frames}) + '\n')
        child.stdin.flush()
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                line = inbox.get(timeout=max(.001, deadline - time.monotonic()))
            except queue.Empty as exc:
                raise RuntimeError('native_paper_runtime_timeout') from exc
            if line is None:
                raise RuntimeError('native_paper_child_closed_without_completion')
            message = json.loads(line)
            if message['type'] == 'failed':
                raise RuntimeError(message['error'] + (':' + ','.join(failure_codes) if failure_codes else ''))
            if message['type'] == 'complete':
                child.stdin.close()
                if child.wait(timeout=max(.001, deadline - time.monotonic())) != 0:
                    raise RuntimeError('native_paper_child_exit_failed')
                return {**message['result'], **store.export(), 'input_checksum': digest(store.inputs),
                        'captured_inputs': store.inputs,
                        'execution_owner_version': owner_version, 'initial_state_checksum': state_checksum,
                        'production_effect': False, 'session_complete': False, 'nav_maturity_credit': 0}
            if message['type'] != 'request':
                raise RuntimeError('native_paper_protocol_invalid')
            try:
                response = {'id': message['id'], 'result': store.dispatch(message['op'], message['payload']),
                            'clock_ms': store.now_ms}
            except Exception as exc:
                # Preserve missing-schema root causes even when native helpers
                # catch a bridge exception. Never include SQL values or URLs.
                schema_error = re.search(r'(?:no such (?:table|column): |has no column named )([A-Za-z_][A-Za-z_0-9.]*)', str(exc))
                code = message['op'] + ':' + type(exc).__name__
                if schema_error:
                    code += ':schema:' + schema_error.group(1)
                if code not in failure_codes:
                    failure_codes.append(code)
                response = {'id': message['id'], 'error': 'native_paper_private_' + type(exc).__name__ + ':' + str(exc)}
            child.stdin.write(encode(response) + '\n')
            child.stdin.flush()
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            if child.stdin and not child.stdin.closed:
                child.stdin.close()
            if child.stdout:
                child.stdout.close()
        store.db.close()
