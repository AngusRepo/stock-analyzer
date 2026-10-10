"""Read sealed numeric raw bytes without SDK alias averaging or network access.

The caller supplies the accepted capture receipt hash. This reader does not
certify full source coverage, publication dates, PIT, or production readiness.
"""
import hashlib
import io
import json
from pathlib import Path
import re

import polars as pl

def audit_wide_raw(path, roster, *, date_values=False):
    frame=pl.read_ipc(path,memory_map=False)
    indices=[c for c in ('date','index','__index_level_0__') if c in frame.columns]
    if len(indices)!=1: raise ValueError('raw_index_missing_or_ambiguous')
    index=indices[0]
    if frame.height==0 or frame[index].null_count() or frame[index].is_duplicated().any():
        raise ValueError('raw_index_empty_null_or_duplicate')
    aliases={};unmapped=[]
    for col in frame.columns:
        if col==index:continue
        symbol=col.split(' ')[0]
        if not re.fullmatch(r'\d{4,6}(?:[A-Z][A-Z0-9]?)?',symbol) or len(symbol)>6:
            unmapped.append(col);continue
        if date_values:
            dtype=frame[col].dtype
            if dtype == pl.String:
                if frame[col].drop_nulls().str.contains(r'^\d{4}-\d{2}-\d{2}$').not_().any():
                    raise ValueError('raw_date_owner_ambiguous')
                frame=frame.with_columns(pl.col(col).str.to_date('%Y-%m-%d',strict=True))
            elif dtype == pl.Null:
                frame=frame.with_columns(pl.col(col).cast(pl.Date))
            elif isinstance(dtype,pl.Datetime):
                if dtype.time_zone is not None or (frame[col]!=frame[col].dt.truncate('1d')).any():
                    raise ValueError('raw_date_owner_ambiguous')
                frame=frame.with_columns(pl.col(col).cast(pl.Date))
            elif dtype != pl.Date:
                raise ValueError('raw_date_owner_ambiguous')
        else:
            if not frame[col].dtype.is_numeric():raise ValueError('raw_wide_nonnumeric_column')
            if frame[col].is_infinite().any():raise ValueError('raw_infinite_value')
        aliases.setdefault(symbol,[]).append(col)
    conflicts=[]
    for symbol,cols in aliases.items():
        if len(cols)<2:continue
        clean=frame.select(index,*[(pl.col(c) if date_values else pl.col(c).cast(pl.Float64).fill_nan(None)) for c in cols])
        bad=clean.filter(pl.max_horizontal(cols)!=pl.min_horizontal(cols))
        if bad.height:
            conflicts.append({'symbol':symbol,'aliases':cols,'rows':bad.height,
                              'first_index':str(bad[index][0])})
    return {'rows':frame.height,'raw_columns':frame.width-1,'index_column':index,
            'index_dtype':str(frame[index].dtype),'index_min':str(frame[index].min()),'index_max':str(frame[index].max()),
            'formal_present_symbols':sorted(set(roster)&set(aliases)),
            'formal_absent_symbols':sorted(set(roster)-set(aliases)),
            'duplicate_aliases':{s:c for s,c in aliases.items() if len(c)>1},
            'conflicts':conflicts,'unmapped_columns_preserved':unmapped,
            'normalization_performed':False}



DATE_OWNERS = {'etl:financial_statements_disclosure_dates', 'etl:financial_statements_deadline'}


def read_numeric_field(root, *, receipt_sha256, field, expected_dataset, _date_owner=False):
    if _date_owner and expected_dataset not in DATE_OWNERS:
        raise ValueError('raw_date_dataset_owner_invalid')
    root = Path(root).resolve()
    raw_receipt = (root/'capture.json').read_bytes()
    if hashlib.sha256(raw_receipt).hexdigest() != receipt_sha256:
        raise ValueError('raw_receipt_checksum_mismatch')
    receipt = json.loads(raw_receipt)
    if (receipt.get('schema_version') != 'full-raw-local-capture-v1'
            or receipt.get('status') != 'raw_complete_not_formal_admitted'
            or receipt.get('formal_admission_passed') is not False
            or receipt.get('capture_id') != root.name):
        raise ValueError('raw_capture_identity_or_status_invalid')
    required, datasets = receipt.get('required'), receipt.get('datasets')
    if not isinstance(required, dict) or not isinstance(datasets, dict) or set(required) != set(datasets):
        raise ValueError('raw_capture_inventory_incomplete')
    if required.get(field) != expected_dataset:
        raise ValueError('raw_dataset_owner_mismatch')
    # Reject corruption in any sibling, not just the currently requested field.
    verified = {}
    selected_payload = None
    for key, record in datasets.items():
        if not re.fullmatch(r'[a-z][a-z0-9_]*', key):
            raise ValueError('raw_field_invalid')
        if (record.get('path') not in (f'sealed/{key}.feather', f'sealed\\{key}.feather')
                or record.get('dataset') != required[key]
                or record.get('status') != 'raw_verified'):
            raise ValueError('raw_field_binding_invalid')
        path = (root/'sealed'/f'{key}.feather').resolve()
        if path.parent != (root/'sealed').resolve() or not path.is_relative_to(root):
            raise ValueError('raw_path_outside_capture')
        payload = path.read_bytes()
        if len(payload) != record['bytes'] or hashlib.sha256(payload).hexdigest() != record['sha256']:
            raise ValueError('raw_field_checksum_mismatch')
        verified[key] = record['sha256']
        if key == field:
            selected_payload = payload
    record = datasets[field]
    # Consume the very bytes whose checksum passed, never reopen a mutable path.
    inventory = audit_wide_raw(io.BytesIO(selected_payload), receipt['roster'], date_values=_date_owner)
    if inventory['conflicts']:
        raise ValueError('raw_alias_conflict')
    if inventory['unmapped_columns_preserved']:
        raise ValueError('raw_unmapped_columns_need_owner_review')
    frame = pl.read_ipc(io.BytesIO(selected_payload), memory_map=False)
    index = inventory['index_column']
    groups = {}
    for column in frame.columns:
        if column != index:
            groups.setdefault(column.split(' ')[0], []).append(column)
    # Conflicting simultaneous values were rejected above. Coalesce equal or
    # complementary aliases, retaining leading zeros, nulls, and exact zeros.
    def expression(c):
        if not _date_owner:return pl.col(c).cast(pl.Float64,strict=True).fill_nan(None)
        if frame[c].dtype == pl.String:return pl.col(c).str.to_date('%Y-%m-%d',strict=True)
        return pl.col(c).cast(pl.Date,strict=True)
    result = frame.select(pl.col(index).alias('date'), *[
        pl.coalesce([expression(c) for c in columns]).alias(symbol)
        for symbol, columns in groups.items()])
    proof = {'capture_id': receipt['capture_id'], 'receipt_sha256': receipt_sha256,
        'field': field, 'dataset': expected_dataset, 'raw_sha256': record['sha256'],
        'sibling_checksums': verified, 'rows': result.height,
        'index_dtype': str(result['date'].dtype), 'alias_groups': inventory['duplicate_aliases'],
        'vendor_absent_symbols': inventory['formal_absent_symbols'],
        'normalized_values_sha256': hashlib.sha256(result.write_ipc(None).getvalue()).hexdigest(),
        'alias_policy': 'equal_or_complementary_only_no_mean',
        'formal_admission_passed': False, 'financial_available_dates_certified': False}
    return result, proof


class SealedDailySource:
    """Explicit daily-source mode; publication-aligned fields need another owner.

    Validation eagerly loads every requested field before the producer can write
    or query external services. Cached normalized frames derive from verified bytes.
    """
    DAILY_NAMESPACES = {'price', 'etl', 'institutional_investors_trading_summary',
                        'margin_transactions', 'price_earning_ratio'}

    def __init__(self, root, receipt_sha256, datasets):
        self.root = Path(root).resolve()
        raw = (self.root / 'capture.json').read_bytes()
        if hashlib.sha256(raw).hexdigest() != receipt_sha256:
            raise ValueError('raw_receipt_checksum_mismatch')
        receipt = json.loads(raw)
        required = receipt.get('required', {})
        if len(set(required.values())) != len(required):
            raise ValueError('raw_dataset_ambiguous')
        by_dataset = {value: key for key, value in required.items()}
        if not datasets or set(datasets) - set(by_dataset):
            raise ValueError('sealed_requested_dataset_missing')
        if any(name.split(':', 1)[0] not in self.DAILY_NAMESPACES for name in datasets):
            raise ValueError('sealed_publication_date_owner_required')
        self.roster = list(receipt['roster'])
        self.frames = {}
        self.proofs = {}
        for dataset in sorted(set(datasets)):
            frame, proof = read_numeric_field(self.root, receipt_sha256=receipt_sha256,
                field=by_dataset[dataset], expected_dataset=dataset)
            if frame['date'].dtype != pl.Date and not isinstance(frame['date'].dtype, pl.Datetime):
                raise ValueError('sealed_daily_index_not_calendar_dates')
            dates = frame['date'].cast(pl.Date)
            if dates.is_duplicated().any():
                raise ValueError('sealed_daily_index_duplicate_session')
            if isinstance(frame['date'].dtype, pl.Datetime):
                if frame['date'].dtype.time_zone is not None or (frame['date'] != frame['date'].dt.truncate('1d')).any():
                    raise ValueError('sealed_daily_index_time_ambiguous')
            self.frames[dataset] = frame.sort('date')
            self.proofs[dataset] = proof
        self.binding = {'schema_version': 'sealed-daily-producer-input-v1',
            'raw_capture_id': receipt['capture_id'], 'raw_receipt_sha256': receipt_sha256,
            'datasets': self.proofs, 'formal_admission_passed': False,
            'publication_date_alignment_certified': False}

    def get(self, dataset):
        # Existing producer API expects pandas. All large raw validation and
        # alias operations above use Polars; this is only the legacy boundary.
        if dataset not in self.frames:
            raise ValueError('sealed_dataset_not_preflighted')
        return self.frames[dataset].to_pandas().set_index('date')


def quarterly_index(frame):
    """Match installed SDK TW index mapping; never infer availability from it."""
    values=frame['date']
    if values.dtype == pl.String:
        if not values.str.contains(r'^\d{4}-Q[1-4]$').all():
            raise ValueError('sealed_financial_quarter_invalid')
        result=frame
    elif values.dtype == pl.Date or isinstance(values.dtype,pl.Datetime):
        if isinstance(values.dtype,pl.Datetime) and (values.dtype.time_zone is not None or (values != values.dt.truncate('1d')).any()):
            raise ValueError('sealed_financial_quarter_invalid')
        months=values.dt.month()
        if not months.is_in([5,8,9,10,11,3,4]).all():
            raise ValueError('sealed_financial_quarter_invalid')
        q=months.replace_strict({5:1,8:2,9:2,10:3,11:3,3:4,4:4})
        year=values.dt.year()-(q==4).cast(pl.Int32)
        result=frame.with_columns((year.cast(pl.String)+pl.lit('-Q')+q.cast(pl.String)).alias('date'))
    else:raise ValueError('sealed_financial_quarter_invalid')
    if result['date'].is_duplicated().any():raise ValueError('sealed_financial_duplicate_quarter')
    return result.sort('date')


class SealedFinancialSource(SealedDailySource):
    """Native values and both date owners must belong to the same raw capture."""
    def __init__(self,root,receipt_sha256,datasets):
        requested=set(datasets)
        financial={k for k in requested if k.startswith(('fundamental_features:','financial_statement:'))}
        if not financial:raise ValueError('sealed_financial_scope_empty')
        raw=(Path(root)/'capture.json').read_bytes()
        if hashlib.sha256(raw).hexdigest()!=receipt_sha256:raise ValueError('raw_receipt_checksum_mismatch')
        receipt=json.loads(raw);required=receipt.get('required',{})
        dependencies=DATE_OWNERS|{'price:收盤價'}
        if not dependencies.issubset(set(required.values())):raise ValueError('sealed_publication_date_owner_required')
        super().__init__(root,receipt_sha256,(requested-financial)|{'price:收盤價'})
        by_dataset={v:k for k,v in required.items()}
        if not financial.issubset(by_dataset):raise ValueError('sealed_requested_dataset_missing')
        for dataset in sorted(financial|DATE_OWNERS):
            frame,proof=read_numeric_field(root,receipt_sha256=receipt_sha256,
                field=by_dataset[dataset],expected_dataset=dataset,_date_owner=dataset in DATE_OWNERS)
            self.frames[dataset]=quarterly_index(frame)
            self.proofs[dataset]=proof
        self.binding.update(schema_version='sealed-financial-producer-input-v1',
            requested_datasets=sorted(requested),financial_date_dependencies=sorted(dependencies),
            raw_values_and_date_owners_same_capture=True,publication_date_alignment_certified=False)
