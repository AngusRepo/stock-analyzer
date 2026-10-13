import hashlib
import io
import json
from pathlib import Path

import polars as pl
import pytest
from google.api_core.exceptions import PreconditionFailed

from services.daily_inference_composition import SCHEMA, load_composition, read_frame


def test_delayed_weekly_holding_observation_is_added_without_changing_known_cells():
    from services.daily_inference_producer import append_holding_observations
    prior = pl.DataFrame({'symbol':['2330','2317'],'date':['2026-10-02','2026-10-02'],
                          'retail_pct':[0.,None]})
    observed = pl.DataFrame({'symbol':['2330','2317','2330','2330'],
                             'date':['2026-10-02','2026-10-02','2026-10-09','2026-10-16'],
                             'retail_pct':[99.,99.,2.,3.]})
    # The composition baseline is 10/12, while its last original holding capture
    # was 10/02. A newly observed 10/09 row must not disappear behind that date.
    actual = append_holding_observations(prior,observed,run_date='2026-10-13')
    assert actual.filter(pl.col('date')=='2026-10-02').equals(prior.sort('symbol','date'))
    assert actual.filter(pl.col('date')=='2026-10-09')['retail_pct'].to_list() == [2.]
    assert '2026-10-16' not in actual['date'].to_list()
from services.daily_inference_producer import (
    HEAD_PREFIX, _baseline, produce_daily_inference_composition, publish_daily_inference_head,
)
from services.monthly_availability import LOCKED_NOTE
from services.training_auxiliary_capture import DAILY_FIELDS, FIELDS, load_training_auxiliary_capture


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value).encode()


def parquet(frame):
    stream = io.BytesIO()
    frame.write_parquet(stream)
    return stream.getvalue()


class Bucket:
    name = 'test'
    def __init__(self):
        self.files = {}

    def blob(self, path):
        files = self.files
        class Blob:
            name = path
            def exists(self):
                return path in files
            def download_as_bytes(self):
                return files[path]
            def download_as_text(self):
                return files[path].decode()
            def upload_from_string(self, raw, **kwargs):
                if kwargs.get('if_generation_match') == 0 and path in files:
                    raise PreconditionFailed('exists')
                files[path] = raw
        return Blob()

    def list_blobs(self, prefix):
        return [self.blob(p) for p in self.files if p.startswith(prefix)]

    def put(self, path, raw):
        self.files[path] = raw
        return {'path': path, 'sha256': sha(raw)}


def item(bucket, path, frame, **extra):
    ref = bucket.put(path, parquet(frame))
    return {**ref, 'rows': frame.height, 'columns': frame.columns,
            'inputs': [ref], 'availability': 'vendor_date_index', **extra}


def baseline(bucket):
    frame = pl.DataFrame({'date': ['2026-10-08', '2026-10-12'], '2330': [0., None], '0050': [1., 2.]})
    value = {'schema_version': SCHEMA, 'business_date': '2026-10-12',
             'price_capture_id': 'base', 'price_manifest_sha256': 'a' * 64,
             'training_admitted': False, 'auxiliary': {}, 'long': {},
             'input_manifests': [bucket.put('base/input.json', b'{}')]}
    for field in FIELDS:
        extra = {'monthly_contract': {'policy': 'vendor_locked_key_date_next_observed_session',
                                     'vendor_declaration': {'note': LOCKED_NOTE}}} if field.startswith('revenue') else {}
        value['auxiliary'][field] = item(bucket, 'base/' + field, frame, **extra)
    value['long']['holding'] = item(bucket, 'base/holding', pl.DataFrame(
        {'date': ['2026-10-08'], 'symbol': ['2330'], 'retail_pct': [0.]}))
    value['long']['broker'] = item(bucket, 'base/broker', pl.DataFrame(
        {'date': ['2026-10-12'], 'symbol': ['2330'], 'broker_net_lots': [2.]}))
    ref = bucket.put('baseline/manifest.json', encoded(value))
    bucket.put(HEAD_PREFIX + '2026-10-12.json', encoded({**ref, 'business_date': '2026-10-12'}))
    return value


def write(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)


def current_capture(tmp_path, day, *, omit_session=False):
    root = tmp_path / ('daily-' + day)
    sessions = ['2026-10-08', '2026-10-12', '2026-10-13']
    if day == '2026-10-14': sessions.append(day)
    prices = pl.DataFrame({'date': sessions, '2330': [1.] * len(sessions), '0050': [0.] * len(sessions)})
    raw = parquet(prices)
    price_fields = ('open', 'high', 'low', 'close', 'volume', 'value', 'adj_close', 'adj_open', 'market_value')
    for field in price_fields:
        write(root / ('raw/daily_price_full_vintage/' + field + '.parquet'), raw)
    write(root / 'raw/daily_price_full_vintage/manifest.json', encoded(
        {'schema_version': 'finlab-adjusted-price-single-capture-v1', 'capture_id': root.name,
         'end_date': day, 'checksums': {f: sha(raw) for f in price_fields}}))
    for filename in ('training_calendar.json', 'training_breadth.json'):
        write(root / ('raw/daily_price_full_vintage/' + filename), b'{}')
    institution_fields = ('foreign_net', 'trust_net', 'dealer_self_net', 'dealer_hedge_net')
    for field in institution_fields:
        write(root / ('raw/chip_diversity_full_vintage/' + field + '.parquet'), raw)
    write(root / 'raw/chip_diversity_full_vintage/manifest.json', encoded(
        {'schema_version': 'finlab-institutional-single-capture-v1', 'capture_id': root.name,
         'end_date': day, 'checksums': {f: sha(raw) for f in institution_fields}}))
    auxiliary = {'capture_id': root.name, 'end_date': day, 'fields': {}}
    for field in ('margin_balance', 'short_balance', 'pe', 'pb'):
        delta = prices.with_columns(pl.lit(99.).alias('2330'))
        if omit_session: delta = delta.filter(pl.col('date') != '2026-10-13')
        raw = parquet(delta)
        write(root / ('raw/training_auxiliary_full_vintage/' + field + '.parquet'), raw)
        auxiliary['fields'][field] = {'sha256': sha(raw)}
    write(root / 'raw/training_auxiliary_full_vintage/manifest.json', encoded(auxiliary))
    broker = pl.DataFrame({'date': [day], 'symbol': ['2330'], 'broker_net_lots': [1.],
                          'buy_lots': [2.], 'sell_lots': [1.], 'broker_count': [1], 'broker_concentration': [1.]})
    raw = parquet(broker)
    write(root / 'raw/training_long_full_vintage/broker.parquet', raw)
    write(root / 'raw/training_long_full_vintage/broker.json', encoded(
        {'capture_id': root.name, 'end': day, 'source': 'broker', 'sha256': sha(raw),
         'availability_policy': 'capture_observed'}))
    return root, prices


def vendor_factory(day, *, missing=False, native_quarter_dates=False):
    class Vendor:
        def __init__(self, root, *, roster):
            self.root = root
            sessions = ['2026-10-08', '2026-10-12', '2026-10-13']
            if day == '2026-10-14': sessions.append(day)
            daily = pl.DataFrame({'date': sessions, '2330': [3.] * len(sessions), '0050': [0.] * len(sessions)}).with_columns(pl.col('date').str.to_date())
            quarterly = pl.DataFrame({'date': ['2026-Q3'], '2330': [7.], '0050': [0.]})
            owners = pl.DataFrame({'date': ['2026-Q3'], '2330': [day], '0050': [day]}).with_columns(pl.exclude('date').str.to_date())
            if native_quarter_dates:
                quarterly = quarterly.with_columns(pl.lit('2026-08-14').str.to_date().alias('date'))
                owners = owners.with_columns(pl.lit('2026-Q2').alias('date'))
            self.frames = {'dividend_yield': daily, 'revenue': daily, 'revenue_yoy': daily,
                           'revenue_mom': daily, 'eps': quarterly, 'roe': quarterly,
                           'revenue_growth_yoy': quarterly, 'disclosure': owners, 'deadline': owners,
                           'holding': pl.DataFrame({'date': [day], 'symbol': ['2330'], '持股分級': [1], '占集保庫存數比例': [2.]})}
            receipt = {'datasets': {}}
            for field, frame in self.frames.items():
                raw = frame.write_ipc(None).getvalue()
                path = 'sealed/' + field + '.feather'
                write(root / path, raw)
                receipt['datasets'][field] = {'path': path, 'sha256': sha(raw)}
            write(root / 'capture.json', encoded(receipt))
            self.receipt = receipt

        def read(self, field):
            if missing and field == 'dividend_yield':
                raise ValueError('missing original vendor observation')
            return self.frames[field], {'raw_sha256': self.receipt['datasets'][field]['sha256']}
    return Vendor


def upload(bucket, root, prefix=None):
    for path in root.rglob('*'):
        if path.is_file(): bucket.put((prefix or root.name) + '/' + path.relative_to(root).as_posix(), path.read_bytes())


def produce(bucket, root, day, **kwargs):
    return produce_daily_inference_composition(run_dir=root, bucket=bucket, capture_prefix=root.name,
                                               vendor_factory=vendor_factory(day, **kwargs))


def test_native_financial_dates_bind_to_quarter_owners_before_availability(tmp_path):
    bucket = Bucket()
    baseline(bucket)
    root, _ = current_capture(tmp_path, '2026-10-13')
    reference = produce(bucket, root, '2026-10-13', native_quarter_dates=True)
    upload(bucket, root)
    value = json.loads(bucket.files[reference['path']])
    for field in ('eps', 'roe', 'revenue_growth_yoy'):
        frame = read_frame(bucket, value['auxiliary'][field], run_date='2026-10-13')
        assert frame.filter(pl.col('date') == '2026-10-13')['2330'].to_list() == [7.]
        events = value['auxiliary'][field]['financial_events']
        assert pl.read_parquet(io.BytesIO(bucket.files[events['path']]))['quarter'].to_list() == ['2026-Q2', '2026-Q2']


def test_two_new_days_producer_to_consumer_and_real_auxiliary_reader_preserve_history(tmp_path):
    bucket = Bucket()
    baseline(bucket)
    previous = None
    for day in ('2026-10-13', '2026-10-14'):
        root, prices = current_capture(tmp_path, day)
        reference = produce(bucket, root, day)
        upload(bucket, root)
        publish_daily_inference_head(bucket, reference)
        price_path = root.name + '/raw/daily_price_full_vintage/manifest.json'
        price_capture = {'capture_id': root.name, 'capture_manifest_path': price_path,
                         'capture_manifest_sha256': sha(bucket.files[price_path])}
        result = load_composition(bucket, price_capture=price_capture, run_date=day)
        assert result['baseline_business_date'] == ('2026-10-12' if previous is None else '2026-10-13')
        for field in FIELDS:
            frame = read_frame(bucket, result['auxiliary'][field], run_date=day)
            if previous is not None:
                prior = read_frame(bucket, previous['auxiliary'][field], run_date='2026-10-13')
                assert frame.filter(pl.col('date') <= '2026-10-13').select(prior.columns).equals(prior)
            assert frame.filter(pl.col('date') == '2026-10-08')['2330'][0] == 0.
            assert frame.filter(pl.col('date') == '2026-10-12')['2330'][0] is None
        dates, _, proof = load_training_auxiliary_capture(bucket, price_capture=price_capture,
            stock_rows=[{'id': 'id2330', 'symbol': '2330'}, {'id': 'id0050', 'symbol': '0050'}],
            prices_map={'id2330': [{'date': d} for d in prices['date'].to_list()]},
            prior_ts={}, prior_chips={}, run_date=day, inference_composition=result)
        assert dates['id2330'][day]['pe'] == 99.
        assert proof['schema_version'] == 'inference-auxiliary-composition-binding-v1'
        assert result['training_admitted'] is False
        from services.capture_inventory import inspect_capture_inventory
        checksums = json.loads(bucket.files[price_path])['checksums']
        seq = {'status': 'ready', 'output_gcs_prefix': 'seq', 'lane_reports': [{'lane': 'daily_price',
            'source_uri': {'capture_id': root.name, 'close': 'gs://test/' + root.name + '/raw/daily_price_full_vintage/close.parquet',
                           'checksums': checksums}}]}
        seq['manifest_checksum'] = sha(json.dumps(seq, sort_keys=True, separators=(',', ':')).encode())
        bucket.put('seq/prep/sequence_manifest.json', encoded(seq))
        inventory = inspect_capture_inventory(bucket, sequence_gcs_prefix='seq', run_date=day, inference_only=True)
        assert inventory['status'] == 'inventory_ready' and not inventory['issues']
        # New inference composition does not relax the separate training inventory.
        assert inspect_capture_inventory(bucket, sequence_gcs_prefix='seq', run_date=day)['status'] == 'blocked'
        previous = result


def test_skipped_day_uses_full_delta_history(tmp_path):
    bucket = Bucket()
    baseline(bucket)
    root, _ = current_capture(tmp_path, '2026-10-14')
    ref = produce(bucket, root, '2026-10-14')
    upload(bucket, root)
    value = json.loads(bucket.files[ref['path']])
    for field in DAILY_FIELDS:
        assert '2026-10-13' in read_frame(bucket, value['auxiliary'][field], run_date='2026-10-14')['date']


@pytest.mark.parametrize('failure', ['missing', 'session', 'checksum'])
def test_missing_observation_calendar_gap_and_corruption_never_publish_ready_reference(tmp_path, failure):
    bucket = Bucket()
    baseline(bucket)
    root, _ = current_capture(tmp_path, '2026-10-14', omit_session=failure == 'session')
    if failure == 'checksum':
        (root / 'raw/training_auxiliary_full_vintage/pe.parquet').write_bytes(b'changed')
    with pytest.raises(ValueError):
        produce(bucket, root, '2026-10-14', missing=failure == 'missing')
    assert not (root / 'inference/reference.json').exists()
    assert HEAD_PREFIX + '2026-10-14.json' not in bucket.files


def test_broken_dynamic_reference_cannot_fall_back_to_legacy_registry(tmp_path):
    bucket = Bucket()
    path = 'daily/raw/daily_price_full_vintage/manifest.json'
    bucket.put('daily/inference/reference.json', encoded(
        {'capture_id': 'wrong', 'business_date': '2026-10-13', 'path': 'daily/inference/manifest.json', 'sha256': 'a' * 64}))
    with pytest.raises(ValueError, match='reference_identity_mismatch'):
        load_composition(bucket, price_capture={'capture_id': 'daily', 'capture_manifest_path': path,
                                               'capture_manifest_sha256': 'a' * 64}, run_date='2026-10-13')


def test_corrupt_latest_head_is_rejected_without_older_baseline_fallback():
    bucket = Bucket()
    baseline(bucket)
    bucket.put(HEAD_PREFIX + '2026-10-13.json', encoded(
        {'business_date': '2026-10-13', 'path': 'bad', 'sha256': 'a' * 64}))
    bucket.put('bad', b'corrupt')
    with pytest.raises(ValueError, match='source_checksum'):
        _baseline(bucket, '2026-10-14')


def test_daily_cli_entry_builds_and_publishes_composition_before_ready_result(monkeypatch, tmp_path):
    from test_finlab_remote_backfill_tool_contract import _load_tool_module
    from services import daily_vendor_capture
    from google.cloud import storage
    import sys
    bucket = Bucket()
    baseline(bucket)
    root, _ = current_capture(tmp_path, '2026-10-13')
    tool = _load_tool_module()
    monkeypatch.setattr(tool, 'materialize_specs', lambda **kwargs: ([], [], [], []))
    monkeypatch.setattr(storage, 'Client', lambda: type('Client', (), {'bucket': lambda self, _: bucket})())
    monkeypatch.setattr(daily_vendor_capture, 'DailyVendorCapture', vendor_factory('2026-10-13'))
    monkeypatch.setattr(tool, 'upload_dir_to_gcs', lambda local_dir, **kwargs: upload(bucket, local_dir, kwargs['prefix']) or {'objects': len(bucket.files)})
    for name in ('FINLAB_API_KEY', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_D1_DB_ID'):
        monkeypatch.setenv(name, 'offline-fixture')
    monkeypatch.setattr(sys, 'argv', ['tool', '--years', '3', '--run-id', root.name, '--output-dir', str(tmp_path),
        '--daily-refresh', '--gcs-bucket', 'test', '--source-end-date', '2026-10-13'])
    assert tool.main() == 0
    manifest = json.loads((root / 'manifest.json').read_bytes())
    assert manifest['backfill_status'] == 'ready'
    assert manifest['inference_composition']['capture_id'] == root.name
    assert HEAD_PREFIX + '2026-10-13.json' in bucket.files


def test_upload_publishes_consumer_reference_after_all_files(monkeypatch, tmp_path):
    from test_finlab_remote_backfill_tool_contract import _load_tool_module
    from google.cloud import storage
    tool = _load_tool_module()
    uploaded = []
    class UploadBucket:
        def blob(self, path):
            return type('Blob', (), {'upload_from_filename': lambda self, _: uploaded.append(path)})()
    monkeypatch.setattr(storage, 'Client', lambda: type('Client', (), {'bucket': lambda self, _: UploadBucket()})())
    for name in ('inference/reference.json', 'inference/manifest.json', 'inference-native/capture.json', 'raw/input.parquet'):
        write(tmp_path / name, b'bytes')
    tool.upload_dir_to_gcs(tmp_path, bucket_name='test', prefix='daily')
    assert uploaded[-1] == 'daily/inference/reference.json'
