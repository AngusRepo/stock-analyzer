from datetime import datetime
import hashlib
import json
import sys
from types import SimpleNamespace

import polars as pl
import pytest

from test_finlab_remote_backfill_tool_contract import _load_tool_module


def seal(root, required, *, fault=None):
    root.mkdir()
    (root / 'sealed').mkdir()
    receipt = {'schema_version': 'full-raw-local-capture-v1', 'capture_id': root.name,
        'status': 'raw_complete_not_formal_admitted', 'formal_admission_passed': False,
        'required': required, 'roster': ['0050', '3004', '9998'], 'datasets': {}}
    for field, dataset in required.items():
        dates = ['2026-Q1', '2026-Q2'] if fault == 'native_index' else [datetime(2026, 9, 28), datetime(2026, 9, 29)]
        values = [0., None] if field == 'dealer_hedge_net' else [100., 101.]
        frame = pl.DataFrame({'date': dates, **{str(i): values for i in range(3000, 3100)},
            '0050 A': [50., None], '0050 B': [99. if fault == 'alias' else 50., 51.]})
        path = root / 'sealed' / f'{field}.feather'
        frame.write_ipc(path)
        raw = path.read_bytes()
        receipt['datasets'][field] = {'dataset': dataset, 'path': f'sealed/{field}.feather',
            'status': 'raw_verified', 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
    path = root / 'capture.json'
    path.write_text(json.dumps(receipt), encoding='utf8')
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def setup(monkeypatch, tmp_path):
    tool = _load_tool_module()
    fields = {'daily_price': {'open', 'high', 'low', 'close', 'volume', 'value', 'adj_open', 'adj_close', 'market_value'},
        'chip_diversity': {'foreign_net', 'trust_net', 'dealer_self_net', 'dealer_hedge_net'}}
    required = {field: spec.keys[field] for spec in tool.CORE_SPECS
                for field in fields.get(spec.lane, set())}
    def no_sdk(*args, **kwargs):
        pytest.fail('sealed path must never call SDK login/get')
    monkeypatch.setitem(sys.modules, 'finlab', SimpleNamespace(data=SimpleNamespace(get=no_sdk), login=no_sdk))
    monkeypatch.setattr(tool, 'login_finlab_sdk', no_sdk)
    counts = []
    monkeypatch.setattr(tool, 'd1_counts', lambda start: counts.append(start) or {})
    monkeypatch.setattr(tool, 'start_date_for_years', lambda years: '2026-09-01')
    # Official external sources are independently tested; no network in this boundary replay.
    monkeypatch.setattr(tool, 'write_official_training_calendar', lambda **kwargs: None)
    monkeypatch.setattr(tool, 'write_training_breadth_capture', lambda **kwargs: None)
    return tool, fields, required, counts


def materialize(tool, fields, raw, digest, output, **extra):
    return tool.materialize_specs(years=3, run_dir=output, lanes=list(fields), key_scope=fields,
        source_start_date='2026-09-29', source_end_date='2026-09-29',
        sealed_raw_root=raw, sealed_raw_receipt_sha256=digest, **extra)


def test_true_producer_then_root_reader_preserves_raw_identity(setup, tmp_path):
    tool, fields, required, counts = setup
    raw, output = tmp_path / 'raw-capture', tmp_path / 'derived'
    digest = seal(raw, required)
    materialize(tool, fields, raw, digest, output)
    manifest = json.loads((output / 'raw/daily_price_full_vintage/manifest.json').read_text())
    binding = manifest['sealed_raw_source']
    assert binding['raw_capture_id'] == raw.name and binding['raw_receipt_sha256'] == digest
    assert not binding['formal_admission_passed']
    assert binding['datasets'][required['close']]['vendor_absent_symbols'] == ['9998']
    from test_training_price_capture import fixture, load, load_chips
    bucket = fixture()
    for source in output.glob('raw/*_full_vintage/*'):
        if source.is_file():
            bucket.data['capture/' + source.relative_to(output).as_posix()] = source.read_bytes()
    path = 'seq/prep/sequence_manifest.json'
    seq = json.loads(bucket.data[path])
    seq['lane_reports'][0]['source_uri'].update(capture_id=output.name, checksums=manifest['checksums'])
    seq.pop('manifest_checksum')
    seq['manifest_checksum'] = hashlib.sha256(json.dumps(seq, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    bucket.data[path] = json.dumps(seq).encode()
    prices, indicators, proof = load(bucket)
    assert [row['close'] for row in prices[1]] == [100., 101.]
    chips, _ = load_chips(bucket, prices, proof)
    assert [row['dealer_hedge_net'] for row in chips['3004']] == [0., None]
    daily = pl.read_parquet(output / 'raw/daily_price/close.parquet')
    assert daily.height == 1 and daily['0050'].to_list() == [51.]
    assert len(counts) == 1 and indicators == {1: []}


@pytest.mark.parametrize('fault,reason', [
    ('alias', 'raw_alias_conflict'), ('native_index', 'sealed_daily_index_not_calendar_dates'),
    ('missing', 'sealed_requested_dataset_missing'), ('corrupt', 'raw_field_checksum_mismatch'),
    ('reuse', 'sealed_source_requires_explicit_scope_no_reuse'), ('prior_output', 'sealed_source_requires_fresh_output'),
    ('financial', 'sealed_publication_date_owner_required'), ('receipt', 'raw_receipt_checksum_mismatch'),
    ('unknown_field', 'sealed_source_unknown_scoped_field')])
def test_invalid_source_rejected_before_d1_or_output(setup, tmp_path, fault, reason):
    tool, fields, required, counts = setup
    if fault == 'missing':
        required.pop('value')
    if fault == 'financial':
        spec = next(spec for spec in tool.CORE_SPECS if spec.lane == 'fundamental_factor_diversity')
        fields['fundamental_factor_diversity'] = {'eps'}
        required['eps'] = spec.keys['eps']
    raw, output = tmp_path / 'raw-capture', tmp_path / 'derived'
    digest = seal(raw, required, fault=fault)
    if fault == 'corrupt':
        (raw / 'sealed/value.feather').write_bytes(b'corrupt')
    if fault == 'prior_output':
        (output / 'raw').mkdir(parents=True)
    if fault == 'receipt':
        digest = '0' * 64
    if fault == 'unknown_field':
        fields['daily_price'].add('misspelled_field')
    with pytest.raises(ValueError, match=reason):
        materialize(tool, fields, raw, digest, output, reuse_successful_artifacts=fault == 'reuse')
    assert counts == []
    assert not (output / 'sealed-raw-source.json').exists()
    assert not (output / 'raw/daily_price/close.parquet').exists()
