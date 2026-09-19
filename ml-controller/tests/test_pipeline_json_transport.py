from datetime import date
import gzip
import hashlib
import json
import ast
import sys
import types
from pathlib import Path

import pytest

from services.pipeline_json_transport import compress_json, iter_json_bytes
from services.pipeline_async_state_transport import (
    STATE_SCHEMA_V2, build_pipeline_payload_identity, decode_pipeline_state_envelope,
    encode_pipeline_state_envelope,
)


@pytest.mark.parametrize('sort_keys', [False, True])
@pytest.mark.parametrize('value', [
    {'中文': 'emoji😀\\\n', 'b': [-0.0, 1e-17, 3.141592653589793, None, True]},
    {'nested': {'z': [], 'a': {}}, 'records': [{'v': i / 7, 'date': date(2026, 9, 14)} for i in range(99)]},
    {2: 'two', 1: 'one'},
    {'nan': float('nan'), 'inf': float('inf'), 'date': date(2026, 9, 14)},
    [[], {}, [1,2], ('x', 'y')],
])
def test_wire_bytes_and_checksum_match_stdlib(value, sort_keys):
    expected = json.dumps(value, ensure_ascii=False, sort_keys=sort_keys,
                          separators=(',', ':'), default=str).encode()
    assert b''.join(iter_json_bytes(value, sort_keys=sort_keys)) == expected
    compressed, size, sha = compress_json(value, sort_keys=sort_keys)
    assert gzip.decompress(compressed) == expected
    assert compressed == gzip.compress(expected, compresslevel=6, mtime=0)
    assert size == len(expected)
    assert sha == hashlib.sha256(expected).hexdigest()


def test_shared_history_remains_complete_and_encoding_does_not_mutate_source():
    histories = [{'symbol': str(i), 'prices': list(range(1800))} for i in range(70)]
    value = {'source': histories, 'models': {n: histories for n in ['DLinear', 'PatchTST', 'iTransformer']}}
    encoded, _, _ = compress_json(value, sort_keys=True)
    restored = json.loads(gzip.decompress(encoded))
    assert restored == value
    assert all(value['models'][n] is histories for n in value['models'])
    restored['models']['DLinear'][0]['prices'][0] = -1
    assert histories[0]['prices'][0] == 0
    assert restored['models']['PatchTST'][0]['prices'][0] == 0


def test_capacity_fails_before_visiting_unneeded_later_data():
    class MustNotEncode:
        def __str__(self):
            raise AssertionError('stream did not stop at budget')
    with pytest.raises(ValueError, match='pipeline_modal_request_bytes_exceeded'):
        compress_json({'first': 'x' * 100, 'later': MustNotEncode()}, max_raw_bytes=50,
                      error_prefix='pipeline_modal_request')
    with pytest.raises(ValueError, match='compressed_bytes_exceeded'):
        compress_json({'x': list(range(100))}, max_compressed_bytes=5)


@pytest.mark.parametrize('kind', ['dict', 'list'])
def test_cycles_rejected(kind):
    value = {} if kind == 'dict' else []
    if kind == 'dict': value['cycle'] = value
    else: value.append(value)
    with pytest.raises(ValueError, match='Circular reference'):
        compress_json(value)


def test_real_state_writer_roundtrip_preserves_input_and_omits_unused_alias(monkeypatch):
    root = Path(__file__).resolve().parents[2]
    tree = ast.parse((root/'ml-controller/graphs/daily_pipeline_v2.py').read_text(encoding='utf-8'))
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name=='_write_pipeline_async_state_artifact')
    from datetime import datetime, timezone
    class Blob:
        def upload_from_string(self, data, *, content_type):
            assert content_type == 'application/gzip'
            self.data = data
    blob = Blob()
    class Bucket:
        def blob(self, name):return blob
    class Client:
        def bucket(self, name):return Bucket()
    storage = types.ModuleType('google.cloud.storage');storage.Client = Client
    cloud = types.ModuleType('google.cloud');cloud.storage = storage
    google = types.ModuleType('google');google.cloud = cloud
    for name, mod in [('google', google), ('google.cloud', cloud), ('google.cloud.storage', storage)]:
        monkeypatch.setitem(sys.modules, name, mod)
    ns = dict(PipelineStateV2=dict,datetime=datetime,timezone=timezone,STATE_SCHEMA_V2=STATE_SCHEMA_V2,
              build_pipeline_payload_identity=build_pipeline_payload_identity,
              encode_pipeline_state_envelope=encode_pipeline_state_envelope,
              _pipeline_async_bucket_and_blob=lambda **kwargs: ('bucket','state'))
    exec(compile(ast.Module(body=[fn],type_ignores=[]),'daily_pipeline_v2.py','exec'),ns)
    # An unused alias must be removed BEFORE touching or serializing it.
    class Unused:
        def __str__(self):raise AssertionError('unused alias serialized')
    rows=[{'symbol':'2330', 'prices':[{'date':date(2026,9,14),'close':1.0}]}]
    state={'run_date':'2026-09-14','payloads':rows,'l3_payloads':Unused(),'evidence':{'kept':True}}
    assert ns['_write_pipeline_async_state_artifact'](state)=='gs://bucket/state'
    restored=decode_pipeline_state_envelope(blob.data)['state']
    assert 'l3_payloads' not in restored
    assert restored['evidence']==state['evidence']
    assert restored['payloads'][0]['prices'][0]['date']=='2026-09-14'
    assert state['payloads'] is rows and isinstance(rows[0]['prices'][0]['date'],date)
    assert 'pipeline_payload_identity' not in state


def test_compressed_wire_parity_across_multiple_large_batches():
    value = [{'symbol': str(i), 'history': [{'date': str(j), 'v': (i * 997 + j) / 13}
              for j in range(200)]} for i in range(97)]
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':'), default=str).encode()
    compressed, _, _ = compress_json(value)
    assert compressed == gzip.compress(raw, compresslevel=6, mtime=0)


@pytest.mark.parametrize('compressed',[False,True])
@pytest.mark.parametrize('bom',[False,True])
def test_state_decoder_preserves_unicode_and_legacy_utf8_bom(compressed,bom):
    rows=[{'symbol':'2330','name':'台積電'}]
    envelope={'schema_version':STATE_SCHEMA_V2,'state':{'payloads':rows,
        'pipeline_payload_identity':build_pipeline_payload_identity(rows)}}
    raw=json.dumps(envelope,ensure_ascii=False).encode('utf-8')
    if bom:raw=b'\xef\xbb\xbf'+raw
    if compressed:raw=gzip.compress(raw)
    assert decode_pipeline_state_envelope(raw)==envelope
