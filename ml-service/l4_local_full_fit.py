"""Full-capacity local fitting; outputs remain unreleased until native admission.

Uses the original trainers and date split. Never registers an artifact, grants
NAV credit, or makes a network connection. Source bytes and input bytes are
sealed before training and checked again before the completion receipt.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'ml-service'), str(ROOT / 'ml-controller')]
from l4_local_study import DiskBucket, INPUT  # installs network-denial audit hook
from services.active8_release_model_profiles import LOCAL_EXECUTION_PROFILE, model_profile

DEST = ROOT / 'audits/l4-release-candidate/full-fit'


def sha(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()


def inventory(paths):
    return {str(p.relative_to(ROOT)).replace('\\', '/'): sha(p) for p in sorted(paths)}


def run(model, attempt=None):
    if attempt is not None and (not attempt or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in attempt)):
        raise ValueError("local_full_fit_attempt_invalid")
    import numpy as np
    import torch
    from app import model_store, tabm_training, gnn_training, gcs_batch_io
    from app.research_benchmarks import common
    from app.training_reproducibility import configure_training_reproducibility

    folder = DEST / (attempt or "") / model
    folder.mkdir(parents=True, exist_ok=True)
    receipt_path = folder / 'completion.json'
    if receipt_path.exists():
        saved = json.loads(receipt_path.read_text(encoding='utf-8'))
        for path, checksum in saved['artifacts'].items():
            if sha(ROOT / path) != checksum:
                raise ValueError('local_full_fit_existing_artifact_changed')
        print('VERIFIED_COMPLETE', model, flush=True)
        return
    if (folder / 'start.json').exists():
        raise ValueError('local_full_fit_incomplete_attempt_requires_review')
    source_paths = [* (ROOT / 'ml-service/app').rglob('*.py'), Path(__file__),
                    ROOT / 'ml-service/l4_local_study.py',
                    ROOT / 'ml-controller/services/active8_release_model_profiles.py']
    source_checksums = inventory(source_paths)
    batches = sorted((INPUT / 'study/prep').glob('batch_*.npz'))
    checksums = inventory([*batches, INPUT / 'study/prep/feature_names.json'])
    original_receipt = json.loads((INPUT.parent / 'canonical-price-input-canonical-receipt.json').read_text())
    if len(batches) != len(original_receipt['batches']):
        raise ValueError('local_full_fit_batch_inventory_changed')
    nrows = 0
    known_max = ''
    for path, expected in zip(batches, original_receipt['batches']):
        if sha(path) != expected['sha256']:
            raise ValueError('local_full_fit_corrected_source_changed')
        with np.load(path, allow_pickle=True) as data:
            rows = len(data['dates'])
            if rows != expected['rows'] or data['X'].shape != (rows, 137):
                raise ValueError('local_full_fit_population_or_capacity_changed')
            dates = data['dates'].astype(str)
            known = data['label_known_dates'].astype(str)
            if not np.all(known > dates) or not np.all(known <= '2026-09-14'):
                raise ValueError('local_full_fit_future_or_invalid_label')
            known_max = max(known_max, max(known))
            nrows += rows
    if nrows != original_receipt['rows']:
        raise ValueError('local_full_fit_source_rows_changed')
    torch.set_num_threads(4)
    configure_training_reproducibility(42)
    bucket = DiskBucket(folder)
    for module in (model_store, tabm_training, gnn_training):
        module._get_bucket = lambda: bucket
    common._bucket = lambda: bucket
    gcs_batch_io._BLOB_BYTES_CACHE.clear()
    profile = model_profile(model, execution_profile=LOCAL_EXECUTION_PROFILE)
    payload = {**profile['payload_config'], 'gcs_prefix': 'study', 'batch_count': len(batches),
        'generation_mode': 'local_full_fit', 'output_model_version': f'l4-repaired-{attempt or "full-fit"}-20260914',
        'max_rows': 1_000_000_000, 'run_date': '2026-09-14', 'label_horizon_days': 5}
    start = {'scope': 'local_full_fit_unreleased', 'started_at': datetime.now(timezone.utc).isoformat(),
        'model': model, 'profile': profile, 'payload': payload, 'input_rows': nrows,
        'label_known_date_max': known_max, 'source_checksums': source_checksums,
        'input_checksums': checksums, 'production_effect': False, 'registration': False,
        'release_attestation_pending': True, 'nav_maturity_credit': 0}
    (folder / 'start.json').write_text(json.dumps(start, indent=2), encoding='utf-8', newline='\n')
    print('FULL_FIT_STARTED', model, nrows, flush=True)
    if model == 'TabM':
        import torch_directml
        result = tabm_training.train_tabm_universal(payload, research_device=torch_directml.device(0))
    elif model == 'GNN':
        result = gnn_training.train_graphsage_universal(payload)
    else:
        raise ValueError('local_full_fit_model_not_implemented')
    if result.get('status') != 'ok' or not result.get('checksum') or not result.get('metadata'):
        raise ValueError('local_full_fit_trainer_incomplete')
    if result["metadata"].get("deployment_fit", {}).get("performed") is not True:
        raise ValueError("local_full_fit_deployment_refit_missing")
    if result["train_samples"] != nrows:
        raise ValueError("local_full_fit_rows_truncated")
    if inventory(source_paths) != source_checksums or inventory([*batches, INPUT / 'study/prep/feature_names.json']) != checksums:
        raise ValueError('local_full_fit_source_changed_during_training')
    (folder / 'result.json').write_text(json.dumps(result, indent=2, default=str), encoding='utf-8', newline='\n')
    output = {**start, 'completed_at': datetime.now(timezone.utc).isoformat(),
        'train_samples': result['train_samples'], 'validation_samples': result['validation_samples'],
        'artifacts': inventory(p for p in folder.rglob('*') if p.is_file()),
        'status': 'weights_complete_admission_pending'}
    receipt_path.write_text(json.dumps(output, indent=2), encoding='utf-8', newline='\n')
    print('FULL_FIT_COMPLETE', model, result['checksum'], flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', choices=['TabM', 'GNN'], required=True)
    parser.add_argument("--attempt")
    args = parser.parse_args()
    run(args.model, args.attempt)
