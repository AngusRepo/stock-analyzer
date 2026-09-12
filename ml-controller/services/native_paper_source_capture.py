"""Durable, bounded, read-only source collection for native private execution.

Inputs are sealed before the native engine receives them. A retry reuses the
first delivery, including failures/outages; it never fetches a newer quote for
an old frame. No orders, training, or production configuration writes exist here.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from typing import Any

from services.paired_nav_journal import _timestamp, digest, encode
from services.native_paper_sandbox import _TOKENS, clock_sql
from services.native_paper_time import frame_capture_deadline


class ImmutableNativeObjects:
    PREFIX = 'shadow/paired-native/v1/objects/'
    DELIVERY_PREFIX = 'shadow/paired-native/v1/deliveries/'

    def __init__(self, bucket):
        self.bucket = bucket

    def put(self, payload: dict) -> str:
        key = self.PREFIX + digest(payload) + '.json'
        blob = self.bucket.blob(key)
        raw = encode(payload)
        try:
            blob.upload_from_string(raw, content_type='application/json', if_generation_match=0)
        except Exception:
            # Successful write + lost acknowledgement and competing identical
            # writers are equivalent only after exact content is read back.
            if blob.download_as_text() != raw:
                raise
        if blob.download_as_text() != raw:
            raise RuntimeError('native_source_object_readback_mismatch')
        return key

    def get(self, key: str) -> dict:
        if not key.startswith(self.PREFIX) or len(key) != len(self.PREFIX) + 69:
            raise ValueError('native_source_object_key_invalid')
        expected = key[len(self.PREFIX):-5]
        if any(char not in '0123456789abcdef' for char in expected):
            raise ValueError('native_source_object_key_invalid')
        result = json.loads(self.bucket.blob(key).download_as_text())
        if digest(result) != expected:
            raise ValueError('native_source_object_checksum_mismatch')
        return result

    def lookup_delivery(self, delivery_id: str) -> str | None:
        from google.api_core.exceptions import NotFound
        if len(delivery_id) != 64 or any(c not in '0123456789abcdef' for c in delivery_id):
            raise ValueError('native_source_delivery_id_invalid')
        blob = self.bucket.blob(self.DELIVERY_PREFIX + delivery_id + '.json')
        try:
            value = json.loads(blob.download_as_text())
        except NotFound:
            return None
        record = self.get(value['object_key'])
        if digest(record['identity']) != delivery_id:
            raise ValueError('native_source_delivery_identity_mismatch')
        return value['object_key']

    def publish_delivery(self, delivery_id: str, object_key: str) -> str:
        record = self.get(object_key)
        if digest(record['identity']) != delivery_id:
            raise ValueError('native_source_delivery_identity_mismatch')
        blob = self.bucket.blob(self.DELIVERY_PREFIX + delivery_id + '.json')
        try:
            blob.upload_from_string(encode({'object_key': object_key}), content_type='application/json', if_generation_match=0)
        except Exception:
            existing = self.lookup_delivery(delivery_id)
            if existing is None:
                raise
            return existing
        existing = self.lookup_delivery(delivery_id)
        if existing is None:
            raise RuntimeError('native_source_delivery_readback_missing')
        return existing


def read_only_sql(sql: str) -> str:
    tokens = [token for token in _TOKENS.findall(sql)
              if not token.isspace() and not token.startswith(('--', '/*'))]
    words = [token.lower() for token in tokens if token[0].isalpha() or token[0] == '_']
    forbidden = {'insert', 'update', 'delete', 'replace', 'create', 'alter', 'drop', 'attach',
                 'detach', 'vacuum', 'pragma', 'reindex', 'analyze', 'load_extension',
                 'readfile', 'writefile'}
    if not words or words[0] not in {'select', 'with'} or forbidden & set(words) or ';' in tokens:
        raise ValueError('native_source_mutating_or_multi_sql_forbidden')
    # SQLite accepts quoted function identifiers. Literal data remains opaque,
    # but an identifier followed by '(' cannot conceal a forbidden capability.
    for token, following in zip(tokens, tokens[1:]):
        if following != '(':
            continue
        if token.startswith('[') and token.endswith(']'):
            name = token[1:-1]
        elif len(token) >= 2 and token[0] in ('"', "'", '`') and token[-1] == token[0]:
            name = token[1:-1].replace(token[0] * 2, token[0])
        else:
            name = token
        if name.lower() in forbidden:
            raise ValueError('native_source_mutating_or_multi_sql_forbidden')
    return sql


class NativeSourceCapture:
    """Capabilities are injected by the authenticated collector, never Node.

    ``deliveries`` is the shared immutable inbox for BOTH arms of one frame.
    ``publish`` must persist and read back the address before acknowledging it.
    Already-published receipts are replayable even after the capture window ends.
    """
    def __init__(self, *, objects: ImmutableNativeObjects, deliveries: dict[str, str] | None = None, publish=None,
                 domain_queries: dict[str, Any], inference_reads: dict[str, Any] | None = None,
                 clock=None):
        self.objects = objects
        self.deliveries = deliveries if deliveries is not None else {}
        self.publish = publish or objects.publish_delivery
        self.domain_queries = domain_queries
        self.inference_reads = inference_reads or {}
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def read(self, operation: str, request: dict, frame: dict) -> dict:
        reader = self.inference_reads.get(operation)
        owner = getattr(reader, '__self__', reader)
        context = getattr(owner, 'source_identity', None)
        identity = {'frame_id': frame['input_id'], 'observed_at': frame['observed_at'],
                    'operation': operation, 'request': request, 'source_context': context}
        delivery_id = digest(identity)
        old_key = self.deliveries.get(delivery_id) or self.objects.lookup_delivery(delivery_id)
        if old_key:
            record = self.objects.get(old_key)
            if record.get('identity') != identity:
                raise ValueError('native_source_delivery_identity_mismatch')
            return record
        start = self.clock()
        due = _timestamp(frame['observed_at'])
        deadline = frame_capture_deadline(frame)
        if start.tzinfo is None or not due <= start < deadline:
            raise ValueError('native_source_historical_or_future_capture_forbidden')
        if operation == 'source_sql':
            query = self.domain_queries.get(request.get('domain'))
            if query is None:
                raise ValueError('native_source_domain_capability_missing')
            sql = clock_sql(read_only_sql(request['sql']))
            # Only our generated clock function is substituted. The frame time
            # is validated and rendered locally, never obtained from user SQL.
            stamp = start.astimezone(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
            tokens = _TOKENS.findall(sql)
            rendered, index = [], 0
            while index < len(tokens):
                if tokens[index:index + 3] == ['native_now', '(', ')']:
                    rendered.append("'" + stamp + "'")
                    index += 3
                else:
                    rendered.append(tokens[index])
                    index += 1
            rows = query(''.join(rendered), request.get('args') or [])
            if not isinstance(rows, list):
                raise ValueError('native_source_rows_missing')
            response = {'success': True, 'results': rows, 'meta': {'changes': 0}}
        else:
            # Exact read-only capabilities are registered by source identity.
            # No child-supplied URL is converted into a general network client.
            reader = self.inference_reads.get(operation)
            if reader is None:
                raise ValueError('native_source_read_capability_missing:' + operation)
            scoped_reader = getattr(reader, 'read_native', None)
            response = scoped_reader(request, frame) if callable(scoped_reader) else reader(request)
        closed = self.clock()
        if closed.tzinfo is None or not start <= closed < deadline:
            raise ValueError('native_source_capture_missed_frame_deadline')
        record = {'identity': identity, 'request': request, 'response': response,
                  'captured_at': closed.isoformat()}
        key = self.objects.put(record)
        acknowledged = self.publish(delivery_id, key)
        if not acknowledged:
            raise RuntimeError('native_source_delivery_publish_not_verified')
        authoritative = self.objects.get(acknowledged)
        if authoritative['identity'] != identity:
            raise RuntimeError('native_source_delivery_identity_mismatch')
        self.deliveries[delivery_id] = acknowledged
        return authoritative
