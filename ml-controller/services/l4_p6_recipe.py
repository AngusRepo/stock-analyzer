"""P6-a CPU preparation. A separate recipe; never delegates to R2 monthly.

Inputs are fold-specific, freshly replayed native rows plus complete upstream
dependency graphs. No fixed historical parquet, member selection or checkpoint
is reused. The caller must materialize/checkpoint the upstream graph first.
"""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import numpy as np
import polars as pl
from services import l4_distribution as native
from services import l4_p6_pure_head as pure
from services.l4_distribution_lifecycle import chronological_validation_blocks
from services.l4_training_ancestry import HeldoutFold, verify_graph, check_roots
from services.alpha_model_roster import TIMEXER_MODELS

RECIPE='p6-a-direct-excess-pure8-ploss-fourfold-v1'
PROTOCOL=dict(recipe=RECIPE,arm='P6-a',seeds=[42,43,44],folds=4,
    target='five_session_return_relative_to_full_daily_candidate_pool',
    training_winsor_quantiles=[.01,.99],validation_target_clipped=False,
    selection_target='actual_pool_relative_return_daily_equal_rank_IC',
    max_epochs=200,patience=32,member_count=16,max_selected_members=32,
    p_loss_features=pure.NAMES,gain_loss_A_removed=True,A_weight=0,
    final_refit='freeze_new_inner_selection_then_fit_all_admitted_rows',
    calibration='new_OOF_only_linear_and_nine_bin_empirical_bayes',
    online_switch=False)


def targets(rows, *, training):
    frame=pl.from_dicts([{k:r[k] for k in ('date','symbol','gross_return')} for r in rows])
    if (frame.is_empty() or frame.unique(['date','symbol']).height!=frame.height
            or not frame['gross_return'].is_finite().all()):
        raise ValueError('p6_target_rows_invalid')
    frame=frame.with_columns((pl.col('gross_return')-pl.col('gross_return').mean().over('date')).alias('relative_return'))
    frame=frame.with_columns(pl.col('relative_return').quantile(.01,interpolation='linear').over('date').alias('q01'),
        pl.col('relative_return').quantile(.99,interpolation='linear').over('date').alias('q99'))
    return frame.with_columns((pl.col('relative_return').clip(pl.col('q01'),pl.col('q99'))
        if training else pl.col('relative_return')).alias('target'))


def matrix(rows, probabilities, recipe=None):
    x,scaler=native.design(rows,None if recipe is None else recipe['native'])
    p=np.asarray(probabilities,dtype=float)
    if p.shape!=(len(rows),) or not np.isfinite(p).all() or ((p<0)|(p>1)).any():
        raise ValueError('p6_probability_invalid')
    if recipe is None:
        w=pure.weights([r['date'] for r in rows]);mean=float(w@p)
        scale=max(float(np.sqrt(w@((p-mean)**2))),.001)
        recipe=dict(recipe_version=RECIPE,feature_names=scaler['names']+['p_loss'],native=scaler,
            p_loss_scaler=dict(mean=mean,scale=scale),p_loss_features=pure.NAMES,
            gain_loss_A_removed=True,A_weight=0)
    if recipe.get('recipe_version')!=RECIPE or recipe['feature_names']!=native.feature_names(TIMEXER_MODELS)+['p_loss']:
        raise ValueError('p6_recipe_feature_contract_invalid')
    scale=recipe['p_loss_scaler']
    if not np.isfinite([scale['mean'],scale['scale']]).all() or scale['scale']<=0:
        raise ValueError('p6_probability_scaler_invalid')
    x=np.column_stack((x,(p-scale['mean'])/scale['scale'])).astype(np.float32)
    if x.shape!=(len(rows),31) or not np.isfinite(x).all():raise ValueError('p6_matrix_invalid')
    return x,recipe


def _write(path, raw):
    path=Path(path)
    if path.exists():
        if path.read_bytes()!=raw:raise ValueError('p6_immutable_output_conflict:'+path.name)
    else:path.write_bytes(raw)


def _json(path, obj):
    _write(path,json.dumps(obj,sort_keys=True,ensure_ascii=False,allow_nan=False).encode())


def _parquet(path, frame):
    import io
    buffer=io.BytesIO();frame.write_parquet(buffer)
    _write(path,buffer.getvalue())


def prepare_fold(rows, *, spec, graph, cutoff, calendar, calendar_sha256, output):
    """Fit only the pure p_loss head on admitted ancestors; no neural fit here."""
    rows=sorted(rows,key=lambda r:(r['date'],r['symbol']))
    train_days=spec['head_eligible_train_dates']; val_days=spec['head_eligible_validation_dates']
    if (not train_days or not val_days or set(train_days)&set(val_days)
            or calendar!=sorted(set(calendar)) or not calendar_sha256):
        raise ValueError('p6_fold_partition_invalid')
    first,last=min(val_days),max(val_days);a,b=calendar.index(first),calendar.index(last)
    if a<5 or b+5>=len(calendar):raise ValueError('p6_purge_calendar_incomplete')
    purge=frozenset(calendar[a-5:b+6])
    if purge!=frozenset(spec['calendar_purge_dates']):raise ValueError('p6_purge_contract_changed')
    fold=HeldoutFold(first,last,purge);nodes=verify_graph(graph)
    if len({(r['date'],r['symbol']) for r in rows})!=len(rows):raise ValueError('p6_duplicate_rows')
    byday={}
    for row in rows:
        if not cutoff.admits(row['date'],row['label_known_date']):raise ValueError('p6_row_after_cutoff')
        roots=row.get('feature_roots') or {}
        if set(roots)!=set(pure.MODELS)|{'native_meta'}:raise ValueError('p6_upstream_roster_incomplete')
        # Warm-up inputs can be used by p_loss, so they require the same full
        # ancestry audit as train/validation matrix rows.
        check_roots(nodes,list(roots.values()),cutoff=cutoff,signal_date=row['date'],fold=fold)
        byday.setdefault(row['date'],[]).append(row)
    if not set(train_days+val_days)<=set(byday):raise ValueError('p6_fold_dates_missing')
    if any(fold.excludes(r['date'],r['label_known_date']) for d in train_days for r in byday[d]):
        raise ValueError('p6_train_partition_leaks')
    directory=Path(output);directory.mkdir(parents=True,exist_ok=True)
    _json(directory/'source.json',dict(rows_checksum=native.digest(rows),spec=spec,ancestry_checksum=graph['checksum'],
        calendar_sha256=calendar_sha256,requested_cutoff=cutoff.__dict__,protocol=PROTOCOL))
    head_values={};head_proofs=[]
    for day in sorted(train_days+val_days):
        ancestors=[r for r in rows if r['label_known_date']<day and not fold.excludes(r['date'],r['label_known_date'])]
        if not ancestors:raise ValueError('p6_causal_head_ancestors_missing')
        name='head-'+day+'.json'
        source_checksum=native.digest(ancestors)
        binding=dict(training_rows_checksum=source_checksum,ancestry_checksum=graph['checksum'],
            pure_head_source_sha256=hashlib.sha256(Path(pure.__file__).read_bytes()).hexdigest(),
            cutoff=cutoff.__dict__)
        if (directory/name).exists():
            saved=json.loads((directory/name).read_bytes())
            if (saved.get('binding')!=binding or saved.get('model_checksum')!=native.digest(saved['model'])
                    or saved.get('checksum')!=native.digest({k:v for k,v in saved.items() if k!='checksum'})):
                raise ValueError('p6_causal_head_cache_changed')
            fitted,proof=saved['model'],saved['receipt']
        else:
            fitted=pure.fit(pure.extract(ancestors),np.asarray([r['gross_return'] for r in ancestors]),
                [r['date'] for r in ancestors],[r['label_known_date'] for r in ancestors],chronological_validation_blocks(ancestors))
            proof=cutoff.attest(component='p_loss',signals=[r['date'] for r in ancestors],
                known_dates=[r['label_known_date'] for r in ancestors],feature_vintage=graph['source_receipts'],
                ancestor_cutoff=max(r['label_known_date'] for r in ancestors),trained_at=datetime.now(timezone.utc).isoformat())
            saved=dict(model=fitted,model_checksum=native.digest(fitted),binding=binding,receipt=proof)
            _json(directory/name,{**saved,'checksum':native.digest(saved)})
        x,_=pure.design(pure.extract(byday[day]),[day]*len(byday[day]),fitted['recipe'])
        head_values[day]=pure.predict(x,fitted['head'])
        head_proofs.append(dict(date=day,model_checksum=native.digest(fitted),receipt=proof,
            source_file=name,forbidden_label_ancestors=0))
    _parquet(directory/'native-rows.parquet',pl.from_dicts(rows))
    arrays={};recipe=None;partitions={}
    for role,days in [('train',train_days),('val',val_days)]:
        part=[r for d in days for r in byday[d]];probability=np.concatenate([head_values[d] for d in days])
        x,recipe=matrix(part,probability,recipe)
        frame=targets(part,training=role=='train');arrays[role+'_x']=x
        arrays[role+'_y']=frame['target'].to_numpy().astype(np.float32)
        _parquet(directory/(role+'-rows.parquet'),frame)
        _parquet(directory/(role+'-pure-p-loss.parquet'),pl.DataFrame(dict(date=[r['date'] for r in part],symbol=[r['symbol'] for r in part],p_loss=probability)))
        partitions[role]=dict(rows=len(part),dates=days,signal_date_max=max(days),label_known_at_max=max(r['label_known_date'] for r in part))
    import io
    buffer=io.BytesIO();np.savez_compressed(buffer,**arrays)
    _write(directory/'arrays.npz',buffer.getvalue())
    _json(directory/'recipe.json',recipe);_json(directory/'head-lineage.json',head_proofs)
    names=['source.json','native-rows.parquet','arrays.npz','recipe.json','head-lineage.json',
        *[role+suffix for role in ('train','val') for suffix in ('-rows.parquet','-pure-p-loss.parquet')],
        *[proof['source_file'] for proof in head_proofs]]
    files={name:hashlib.sha256((directory/name).read_bytes()).hexdigest() for name in names}
    receipt=dict(recipe=RECIPE,fold=spec['fold'],partitions=partitions,ancestry_checksum=graph['checksum'],
        requested_cutoff=cutoff.__dict__,files_sha256=files,
        preparation_source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        arrays_sha256=hashlib.sha256((directory/'arrays.npz').read_bytes()).hexdigest(),
        affected_train_rows=0,affected_validation_rows=0,neural_training_started=False,promoted=False)
    receipt={**receipt,'checksum':native.digest(receipt)}
    _json(directory/'receipt.json',receipt)
    return receipt
