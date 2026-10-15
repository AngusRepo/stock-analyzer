"""Read current registries and seal R2 data; optionally prepare CPU matrices.

Classification is an explicitly hash-pinned official evidence artifact. It
classifies the dated source universe; it must never replace it with today's
surviving membership. A later batch must supply evidence covering new symbols.
"""
import argparse,hashlib,json,sys
from pathlib import Path
import polars as pl
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from services.l4_r2_sources import resolve


def classification_filter(path,expected_sha):
    raw=Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=expected_sha:raise ValueError('l4_r2_classification_hash')
    evidence=json.loads(raw);accepted=evidence['accepted_evidence'];excluded=evidence['excluded_symbols']
    if (not accepted or any(not v['cfi'].startswith(('ES','ED')) for v in accepted.values())
            or any(r['instrument_type']!='etf' for r in excluded)
            or len({r['symbol'] for r in excluded})!=len(excluded)
            or set(accepted)&{r['symbol'] for r in excluded}):
        raise ValueError('l4_r2_classification_scope')
    known=set(accepted)|{r['symbol'] for r in excluded}
    def apply(frame):
        missing=set(frame['symbol'].unique())-known
        if missing:raise ValueError('l4_r2_unclassified_symbols:'+','.join(sorted(missing)))
        selected=frame.filter(pl.col('symbol').is_in(sorted(accepted)))
        return selected,dict(policy='historical_source_universe_official_non_etf_equity_v1',
            evidence_sha256=expected_sha,input_rows=len(frame),retained_rows=len(selected),
            excluded_etf_rows=len(frame)-len(selected),point_in_time_membership_reconstructed=False)
    return apply


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--identity',required=True,help='JSON with l3_identity and feature_schema')
    p.add_argument('--classification',required=True);p.add_argument('--classification-sha256',required=True)
    p.add_argument('--cutoff',required=True,help='Explicit timezone-aware fit availability cutoff')
    p.add_argument('--output',required=True);p.add_argument('--bucket',default='stockvision-models')
    p.add_argument('--prepare-matrices',action='store_true',help='Fit causal CPU Anchors after fresh source discovery; never launch TabPack')
    p.add_argument('--calendar',help='Verified official session calendar JSON with dates[]')
    p.add_argument('--calendar-sha256')
    a=p.parse_args();identity=json.loads(Path(a.identity).read_bytes())
    calendar=None
    if a.prepare_matrices:
        if not a.calendar or not a.calendar_sha256:p.error('matrix preparation requires calendar and calendar-sha256')
        raw=Path(a.calendar).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=a.calendar_sha256:raise ValueError('l4_r2_calendar_hash')
        calendar=json.loads(raw)['dates']
    out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    # An existing sealed batch is never rewritten with a newer registry view.
    if (out/'source-ref.json').exists():raise ValueError('l4_r2_output_already_sealed')
    from google.cloud import storage
    rows,receipt=resolve(bucket=storage.Client().bucket(a.bucket),identity=identity['l3_identity'],
        feature_schema=identity['feature_schema'],cutoff=a.cutoff,work=out/'source-cache',
        classify=classification_filter(a.classification,a.classification_sha256))
    raw=json.dumps(dict(rows=rows,receipt=receipt),sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    checksum=hashlib.sha256(raw).hexdigest();path=out/(checksum+'.json')
    with path.open('xb') as f:f.write(raw)
    ref=dict(path=str(path.resolve()),sha256=checksum,rows=len(rows),signal_days=len(receipt['source_dates']),
        source_max_signal_date=receipt['source_max_signal_date'],label_known_max=receipt['label_known_max'],
        prediction_kind_counts=receipt['prediction_kind_counts'],forward_registry=receipt['forward_registry'],
        training_started=False,production_writes=0)
    with (out/'source-ref.json').open('x',encoding='utf8') as f:json.dump(ref,f,indent=2)
    if a.prepare_matrices:
        from services.l4_r2_matrices import build,save
        manifest=build(rows,receipt,calendar=calendar,calendar_sha256=a.calendar_sha256,output=out/'matrices')
        prepared=dict(source=ref,matrices_manifest=str((out/'matrices/matrices-manifest.json').resolve()),
            eligible_days=len(manifest['eligible_dates']),final_refit_days=len(manifest['eligible_dates']),
            tabpack_training_started=False,production_writes=0)
        save(out/'preparation-result.json',prepared)
        print(json.dumps(prepared));return
    print(json.dumps(ref))

if __name__=='__main__':main()
