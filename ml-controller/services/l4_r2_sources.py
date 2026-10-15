"""Resolve current verified native and forward sources for an explicit R2 fit.

Discovery is read-only and never starts training. Daily labels and model fits
have separate owners. A missing native-pool observation remains a visible gap.
"""
from services.l4_native_source_registry import discover_gcs, prepare_sources, cutoff_day
from services.l4_forward_training import load_current_registry, merge_materializations
from services.l4_distribution import digest


def resolve(*,bucket,identity,feature_schema,cutoff,work,classify,
            discover=discover_gcs,prepare=prepare_sources,forward=load_current_registry):
    """Classification is the caller's verified, dated official-instrument policy.

    Keeping classification outside discovery preserves the historical source
    universe. The policy must return whole daily non-ETF pools, not top-k rows.
    """
    native,inventory=prepare(discover(bucket),identity=identity,
        feature_schema=feature_schema,cutoff=cutoff,work=work,bucket=bucket)
    native,classification=classify(native)
    if (classification.get('policy')!='historical_source_universe_official_non_etf_equity_v1'
            or len(classification.get('evidence_sha256',''))!=64):
        raise ValueError('l4_r2_source_classification_unverified')
    bodies,registry=forward(bucket,cutoff=cutoff)
    rows,receipts,exclusions=merge_materializations(native.to_dicts(),bodies,
        identity=identity,feature_schema=feature_schema,as_of=cutoff_day(cutoff))
    if not rows:raise ValueError('l4_r2_no_current_eligible_sources')
    dates=sorted({r['date'] for r in rows})
    kinds={kind:sum(r['prediction_kind']==kind for r in rows) for kind in ('oof','forward')}
    receipt=dict(schema_version='l4-r2-training-source-v1',cutoff=cutoff,
        l3_identity=identity,feature_schema=feature_schema,source_pool='native_non_etf_equity_v1',
        rows=len(rows),rows_checksum=digest(rows),source_dates=dates,
        source_max_signal_date=max(dates),label_known_max=max(r['label_known_date'] for r in rows),
        prediction_kind_counts=kinds,native_inventory=inventory,classification=classification,
        forward_registry=registry,forward_receipts=receipts,exclusion_ledger=exclusions,
        training_started=False,promoted=False)
    return rows,receipt


def verified_slice(rows,receipt,*,dates,as_of):
    """Select complete dates only after verifying the original mixed dataset."""
    from services.l4_forward_training import validate_forward_rows
    if receipt.get('schema_version')!='l4-r2-training-source-v1' or digest(rows)!=receipt['rows_checksum']:
        raise ValueError('l4_r2_source_rows_changed')
    validate_forward_rows(rows,receipt['forward_receipts'],identity=receipt['l3_identity'],
        as_of=cutoff_day(receipt['cutoff']))
    chosen=set(dates)
    if not chosen<=set(receipt['source_dates']):raise ValueError('l4_r2_requested_date_missing')
    part=[r for r in rows if r['date'] in chosen]
    if any(r['label_known_date']>=as_of for r in part):raise ValueError('l4_r2_slice_immature')
    return part,[r for r in receipt['forward_receipts'] if r['signal_date'] in chosen]
