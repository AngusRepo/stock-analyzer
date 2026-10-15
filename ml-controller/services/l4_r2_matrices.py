"""Fresh-source R2 preparation; no GPU dispatch or serving writes.

The caller seals registry discovery first. Whole daily pools are admitted once,
then every Anchor ancestor and matrix partition is selected by observable dates.
"""
from datetime import date
import hashlib
import json
from pathlib import Path

import numpy as np
import polars as pl
from services import l4_distribution as native
from services.l4_distribution_lifecycle import chronological_validation_blocks
from services.l4_forward_training import validate_forward_rows
from services.l4_native_source_registry import cutoff_day

HEAD_NAMES = ['p_loss', 'gain', 'loss', 'expected_return_gross']


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value):
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()
    path = Path(path)
    if path.exists():
        if path.read_bytes() != raw:
            raise ValueError('l4_r2_immutable_output_conflict')
    else:
        with path.open('xb') as stream:
            stream.write(raw)


def admit(rows, receipt):
    if (receipt.get('schema_version') != 'l4-r2-training-source-v1'
            or native.digest(rows) != receipt['rows_checksum']
            or receipt.get('source_pool') != 'native_non_etf_equity_v1'
            or len(rows) != receipt['rows']):
        raise ValueError('l4_r2_matrix_source_invalid')
    cutoff = cutoff_day(receipt['cutoff'])
    validate_forward_rows(rows, receipt['forward_receipts'],
                          identity=receipt['l3_identity'], as_of=cutoff)
    if (not rows or len({(r['date'], r['symbol']) for r in rows}) != len(rows)
            or sorted({r['date'] for r in rows}) != receipt['source_dates']
            or any(r['label_known_date'] >= cutoff or r['date'] >= r['label_known_date']
                   or r['l3_training_label_known_max'] >= r['date']
                   or r['l3_identity'] != receipt['l3_identity']
                   or r['feature_schema'] != receipt['feature_schema']
                   or r['prediction_kind'] not in ('oof', 'forward') for r in rows)):
        raise ValueError('l4_r2_matrix_source_rows_invalid')


def qualify(rows, calendar):
    """The sealed fourfold rule, with official classification already applied."""
    if not calendar or calendar != sorted(set(calendar)):
        raise ValueError('l4_r2_calendar_order')
    for day in calendar:
        date.fromisoformat(day)
    known = {}
    for row in rows:
        known[row['date']] = max(known.get(row['date'], ''), row['label_known_date'])
    if not set(known).union(known.values()) <= set(calendar):
        raise ValueError('l4_r2_calendar_missing_source_or_label')
    eligible = sorted(d for d in known if sum(k < d for k in known.values()) >= 15)
    if len(eligible) < 4:
        raise ValueError('l4_r2_insufficient_head_dates')
    width, extra = divmod(len(eligible), 4)
    offset, folds, ledger = 0, [], []
    for index in range(4):
        validation = eligible[offset:offset + width + int(index < extra)]
        offset += len(validation)
        first, last = validation[0], validation[-1]
        a, b = calendar.index(first), calendar.index(last)
        if a < 5 or b + 5 >= len(calendar):
            raise ValueError('l4_r2_calendar_missing_full_purge')
        forbidden = set(calendar[a - 5:b + 6])
        train = [d for d in eligible if d not in forbidden and (known[d] < first or d > last)]
        for day in train + validation:
            ancestors = sorted(d for d, k in known.items() if k < day and d not in forbidden
                               and (k < first or d > last))
            okay = len(ancestors) >= 15
            if okay:
                tail = ancestors[len(ancestors) // 2:]
                size, rem = divmod(len(tail), 3)
                pos = 0
                for i in range(3):
                    block = tail[pos:pos + size + int(i < rem)]
                    pos += len(block)
                    okay = okay and bool(block) and any(known[d] < block[0] for d in ancestors)
            ledger.append(dict(fold=index + 1, date=day, eligible=okay,
                               role='validation' if day in validation else 'train',
                               ancestor_dates=ancestors))
        folds.append(dict(fold=index + 1, head_eligible_train_dates=train,
                          head_eligible_validation_dates=validation,
                          calendar_purge_dates=sorted(forbidden)))
    if not all(r['eligible'] for r in ledger):
        raise ValueError('l4_r2_fold_ancestor_readiness_failed')
    return dict(eligible_dates=eligible, folds=folds, ancestor_ledger=ledger)


def matrix(rows, heads, recipe=None):
    x, native_recipe = native.design(rows, None if recipe is None else recipe['native'])
    values = np.asarray([[p[k] for k in HEAD_NAMES] for p in heads], float)
    if recipe is None:
        weights = native.date_weights(rows)[:, None]
        mean = (weights * values).sum(0)
        scale = np.maximum(np.sqrt((weights * (values - mean) ** 2).sum(0)), .001)
        recipe = dict(native=native_recipe, head_names=HEAD_NAMES,
                      mean=mean.tolist(), scale=scale.tolist())
    result = np.column_stack([x, (values - np.asarray(recipe['mean'])) / np.asarray(recipe['scale'])])
    if not np.isfinite(result).all():
        raise ValueError('l4_r2_nonfinite_matrix')
    return result.astype(np.float32), recipe


def targets(frame, *, training):
    if (frame.is_empty() or frame.select(pl.struct('date', 'symbol').n_unique()).item() != len(frame)
            or not frame.select(pl.all_horizontal(pl.col('gross_return').is_finite(),
                pl.col('A').is_finite()).fill_null(False).all()).item()):
        raise ValueError('l4_r2_invalid_target_rows')
    result = frame.with_columns(((pl.col('gross_return') - pl.col('gross_return').mean().over('date'))
        - (pl.col('A') - pl.col('A').mean().over('date'))).alias('target_unclipped'))
    result = result.with_columns(
        pl.col('target_unclipped').quantile(.01, interpolation='linear').over('date').alias('q01'),
        pl.col('target_unclipped').quantile(.99, interpolation='linear').over('date').alias('q99'))
    return result.with_columns((pl.col('target_unclipped').clip(pl.col('q01'), pl.col('q99'))
        if training else pl.col('target_unclipped')).alias('target'))


def build(rows, receipt, *, calendar, calendar_sha256, output):
    """CPU Anchor fits only. Receipts retain OOF/forward kinds, never manufacture OOF."""
    admit(rows, receipt)
    readiness = qualify(rows, calendar)
    out = Path(output)
    out.mkdir(parents=True, exist_ok=False)
    save(out / 'source-receipt.json', receipt)
    save(out / 'calendar.json', dict(dates=calendar, source_sha256=calendar_sha256))
    save(out / 'data-readiness.json', readiness)
    cache = out / 'anchors'
    cache.mkdir()
    bydate = {}
    for row in sorted(rows, key=lambda r: (r['date'], r['symbol'])):
        bydate.setdefault(row['date'], []).append(row)
    receipts = {r['signal_date']: r for r in receipt['forward_receipts']}

    def fit(part, day):
        dates = {r['date'] for r in part}
        proofs = [r for d, r in receipts.items() if d in dates]
        return native.fit_candidate(part, l3_identity=receipt['l3_identity'], as_of=day,
            validation_dates=chronological_validation_blocks(part), forward_receipts=proofs)

    cases = [(str(f['fold']), f['head_eligible_train_dates'],
              f['head_eligible_validation_dates'], f) for f in readiness['folds']]
    cases.append(('final', readiness['eligible_dates'], [], None))
    result = dict(schema_version='stockvision-r2-matrices-v2', source_receipt_sha256=sha(out / 'source-receipt.json'),
        source_rows_checksum=receipt['rows_checksum'], cutoff=receipt['cutoff'],
        l3_identity=receipt['l3_identity'], feature_schema=receipt['feature_schema'],
        source_pool=receipt['source_pool'], source_rows=len(rows), classified_rows=len(rows),
        classification_sha256=receipt['classification']['evidence_sha256'],
        calendar_sha256=calendar_sha256, calendar_file_sha256=sha(out / 'calendar.json'),
        eligible_dates=readiness['eligible_dates'], folds=[],
        prediction_kind_counts=receipt['prediction_kind_counts'], training_ready=False,
        recipe_policy='causal_latest_known_anchor_with_fold_ancestor_exclusion',
        formal_instrument_classification=True, tabpack_training_started=False, promoted=False)
    for name, train_days, val_days, fold in cases:
        dest = out / name
        dest.mkdir()
        values, lineage = {}, []
        for day in sorted(train_days + val_days):
            forbidden = set(fold['calendar_purge_dates']) if fold else set()
            ancestor_days = [d for d in bydate if d not in forbidden
                and all(r['label_known_date'] < day and (not fold or
                    r['label_known_date'] < min(val_days) or r['date'] > max(val_days)) for r in bydate[d])]
            prior = [r for d in ancestor_days for r in bydate[d]]
            if len(ancestor_days) < 15:
                raise ValueError('l4_r2_insufficient_causal_ancestors')
            key = native.digest(dict(rows=native.digest(prior), as_of=day))
            path = cache / (key + '.json')
            if path.exists():
                head = json.loads(path.read_bytes())
                if head['training_rows_checksum'] != native.digest(prior) or native.digest(head['model']) != head['model_checksum']:
                    raise ValueError('l4_r2_head_cache_changed')
            else:
                head = fit(prior, day)
                save(path, head)
            values[day] = native.predict(bydate[day], head['model'])
            lineage.append(dict(date=day, model_checksum=head['model_checksum'],
                training_rows_checksum=head['training_rows_checksum'], path=path.name,
                ancestor_dates=ancestor_days, ancestor_label_known_max=max(r['label_known_date'] for r in prior),
                ancestor_rows=len(prior)))
        arrays, metadata, recipe = {}, {}, None
        for role, days in (('train', train_days), ('val', val_days)):
            if not days:
                continue
            part = [r for d in days for r in bydate[d]]
            heads = [v for d in days for v in values[d]]
            x, fitted = matrix(part, heads, recipe)
            if recipe is None:
                recipe = fitted
            table = targets(pl.DataFrame(dict(date=[r['date'] for r in part], symbol=[r['symbol'] for r in part],
                gross_return=[r['gross_return'] for r in part], A=[v['expected_return_gross'] for v in heads])), training=role == 'train')
            table.write_parquet(dest / (role + '-rows.parquet'))
            arrays[role + '_x'] = x
            arrays[role + '_y'] = table['target'].to_numpy().astype(np.float32)
            metadata[role] = dict(rows=len(part), dates=days, source_checksum=native.digest(part),
                label_known_max=max(r['label_known_date'] for r in part), matrix_sha256=hashlib.sha256(x.tobytes()).hexdigest())
        if not np.isfinite(arrays['train_y']).all() or arrays['train_y'].std() <= 0:
            raise ValueError('l4_r2_invalid_training_target')
        np.savez_compressed(dest / 'arrays.npz', **arrays)
        save(dest / 'recipe.json', recipe)
        save(dest / 'head-lineage.json', lineage)
        record = dict(fold=name, partitions=metadata, arrays_sha256=sha(dest / 'arrays.npz'),
            recipe_sha256=sha(dest / 'recipe.json'), head_lineage_sha256=sha(dest / 'head-lineage.json'))
        save(dest / 'receipt.json', record)
        result['folds'].append(record)
    anchor = fit(rows, cutoff_day(receipt['cutoff']))
    save(out / 'serving-anchor.json', anchor)
    result.update(training_ready=True, serving_anchor_checksum=anchor['model_checksum'])
    save(out / 'matrices-manifest.json', result)
    return result
