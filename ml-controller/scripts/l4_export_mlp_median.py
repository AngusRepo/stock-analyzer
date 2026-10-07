"""Local-only original checkpoint export; no training/publication."""
import argparse,json
from pathlib import Path
from services.l4_mlp_export import export,read
from services.l4_mlp_median import SEEDS

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('model-folder','serving-artifact','signal-date','output'):
        parser.add_argument('--'+name, required=True)
    parser.add_argument('--weights-output')
    args = parser.parse_args()
    candidate = export(args.model_folder, serving_artifact=read(args.serving_artifact), signal_date=args.signal_date)
    if args.weights_output:
        from services.l4_mlp_weights import compact_candidate
        candidate,objects=compact_candidate(candidate)
        folder=Path(args.weights_output);folder.mkdir(parents=True,exist_ok=True)
        for key,raw in objects.items():
            with (folder/Path(key).name).open('xb') as stream:stream.write(raw)
        from services.l4_distribution import validate_bundle
        validate_bundle(candidate,l3_identity=candidate['l3_identity'],signal_date=args.signal_date,require_paper_release=False)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x', encoding='utf-8') as stream:
        json.dump(candidate, stream, sort_keys=True, separators=(',',':'), allow_nan=False)
    print(json.dumps({'status':'local_exported', 'model_checksum':candidate['model_checksum'],
        'seeds':list(SEEDS), 'training_executed':False, 'remote_mutations_executed':False}))
