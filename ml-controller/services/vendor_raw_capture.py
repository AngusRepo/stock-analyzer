"""Local raw-first capture gate. No downloads, credentials, training, or production IO."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import time
import polars as pl


def normalize_holding_raw(frame):
    """Recognize the SDK's identity alias without changing sealed wire bytes."""
    columns = set(frame.columns)
    if (frame.is_empty() or not {'date','持股分級','占集保庫存數比例'} <= columns
            or not columns & {'stock_id','symbol'}):
        raise ValueError('raw_holding_schema_invalid:' + ','.join(frame.columns))
    if {'stock_id','symbol'} <= columns:
        different = frame.select((~pl.col('stock_id').cast(pl.String).eq_missing(
            pl.col('symbol').cast(pl.String))).any()).item()
        if different:
            raise ValueError('raw_holding_identity_alias_conflict')
    return frame if 'symbol' in columns else frame.rename({'stock_id':'symbol'})


def read_holding_raw(path):
    import pyarrow as pa
    from pyarrow import feather
    table = feather.read_table(path)
    table.validate(full=True)
    # Valid Arrow dictionaries may use -1 beneath a null bitmap. Decode only
    # nullable dictionaries so Polars never treats that sentinel as a key.
    for index,field in enumerate(table.schema):
        if pa.types.is_dictionary(field.type) and table.column(index).null_count:
            table = table.set_column(index,field.name,table.column(index).cast(pa.large_string()))
    return pl.from_arrow(table,rechunk=False)


def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


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


class FullRawCapture:
    def __init__(self,root,*,roster,required,max_seconds=3600):
        self.root=Path(root)
        if len(roster)!=len(set(roster)) or not roster or not required:raise ValueError('capture_inventory_invalid')
        if any(not re.fullmatch(r'[a-z][a-z0-9_]*',k) for k in required):raise ValueError('field_path_invalid')
        self.root.mkdir(parents=True,exist_ok=False)  # Never resume/overwrite a prior vintage.
        (self.root/'sdk').mkdir();(self.root/'sealed').mkdir()
        self.started=time.monotonic();self.max_seconds=max_seconds
        self.receipt={'schema_version':'full-raw-local-capture-v1','capture_id':self.root.name,
          'started_at':datetime.now(timezone.utc).isoformat(),'roster':list(roster),'required':dict(required),
          'datasets':{},'status':'incomplete','formal_admission_passed':False,
          'production_writes':0,'training_calls':0}
        self._record()

    def _record(self):
        tmp=self.root/'capture.pending.json'
        tmp.write_text(json.dumps(self.receipt,ensure_ascii=False,indent=2),encoding='utf8')
        tmp.replace(self.root/'capture.json')

    def make_sdk_storage(self):
        # Reopening populated FileStorage starts SDK's reset-time network thread.
        # One storage instance belongs to one fresh capture, across all datasets.
        if getattr(self, '_sdk_storage', None) is not None:
            return self._sdk_storage
        # Actual SDK persistence runs before finalization/universe filtering.
        # SDK's first data import constructs a default FileStorage and may start a
        # reset thread for the user's old cache. Keep bootstrap in this new run too.
        import finlab.utils
        bootstrap=self.root/'sdk_bootstrap'
        bootstrap.mkdir(exist_ok=True)
        original=finlab.utils.get_tmp_dir
        try:
            finlab.utils.get_tmp_dir=lambda:str(bootstrap)
            from finlab.data import FileStorage
        finally:
            finlab.utils.get_tmp_dir=original
        self._sdk_storage=FileStorage(str(self.root/'sdk'),use_cache=False)
        return self._sdk_storage

    def seal(self,field):
        if self.receipt['status']!='incomplete':raise ValueError('capture_closed')
        if time.monotonic()-self.started>self.max_seconds:raise ValueError('capture_window_expired')
        if field in self.receipt['datasets']:raise ValueError('dataset_already_sealed')
        key=self.receipt['required'][field]
        source=self.root/'sdk'/(key.replace(':','#')+'.feather')
        if source.resolve().parent!=(self.root/'sdk').resolve():raise ValueError('source_path_invalid')
        dest=self.root/'sealed'/(field+'.feather')
        # Save complete wire/cache bytes before any alias rejection; retain failure evidence.
        with source.open('rb') as src,dest.open('xb') as dst:shutil.copyfileobj(src,dst)
        record={'dataset':key,'path':str(dest.relative_to(self.root)),'sha256':sha(dest),
                'bytes':dest.stat().st_size,'observed_at':datetime.now(timezone.utc).isoformat(),'status':'unverified'}
        self.receipt['datasets'][field]=record;self._record()
        try:
            if sha(source)!=record['sha256']:raise ValueError('source_changed_during_seal')
            if key == 'inventory':
                frame = read_holding_raw(dest)
                record['raw_schema'] = {name:str(dtype) for name,dtype in pl.read_ipc_schema(dest).items()}
                normalize_holding_raw(frame)
                record['inventory'] = {'rows':frame.height,'columns':frame.columns,'conflicts':[],
                                       'identity_column':'symbol' if 'symbol' in frame.columns else 'stock_id'}
            else:
                record['inventory']=audit_wide_raw(dest,self.receipt['roster'],date_values=key in {'etl:financial_statements_disclosure_dates','etl:financial_statements_deadline'})
            if record['inventory']['conflicts']:raise ValueError('raw_alias_conflict')
            record['status']='raw_verified'
        except Exception as exc:
            record['status']='rejected';record['error_class']=type(exc).__name__
            self.receipt['status']='rejected';self._record();raise
        self._record()
        return record

    def finish(self):
        if self.receipt['status']!='incomplete':raise ValueError('capture_closed')
        if time.monotonic()-self.started>self.max_seconds:raise ValueError('capture_window_expired')
        if set(self.receipt['datasets'])!=set(self.receipt['required']):raise ValueError('capture_incomplete')
        for record in self.receipt['datasets'].values():
            if record['status']!='raw_verified' or sha(self.root/record['path'])!=record['sha256']:
                raise ValueError('capture_corrupt_or_unverified')
        self.receipt['status']='raw_complete_not_formal_admitted'
        self.receipt['completed_at']=datetime.now(timezone.utc).isoformat()
        self._record()
        return self.receipt
