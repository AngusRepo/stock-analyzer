"""Explicit import from existing GCS evidence to a local file; never publishes."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'ml-controller'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bucket', required=True)
    parser.add_argument('--price-manifest', required=True)
    parser.add_argument('--price-sha256', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    from google.cloud import storage
    from services.daily_history_capture import import_legacy_history, encode, digest
    value = import_legacy_history(storage.Client().bucket(args.bucket),
        {'path':args.price_manifest, 'sha256':args.price_sha256})
    raw = encode(value)
    with Path(args.output).open('xb') as stream:
        stream.write(raw)
    print(json.dumps({'output': args.output, 'sha256':digest(raw), 'end_date':value['end_date'],
                      'days':len(value['breadth']), 'production_writes':0}))


if __name__ == '__main__':
    main()
