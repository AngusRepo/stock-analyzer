"""Immutable official TabPack candidate job. Never moves a serving pointer."""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

from services.l4_distribution import digest, predict, validate_bundle
from services.l4_distribution_lifecycle import persist_candidate
from services import l4_tabpack_weights as weights
from .l4_tabpack_protocol import RECIPE, UPSTREAM_COMMIT
from services.l4_tabpack_budget_protocol import validate_run, validate_result


def _write_once(bucket, path, raw, content_type):
    blob = bucket.blob(path)
    if not blob.exists():
        blob.upload_from_string(raw, content_type=content_type, if_generation_match=0)
    if blob.download_as_bytes() != raw:
        raise ValueError('l4_tabpack_immutable_readback_mismatch')


def _train(dataset, output, *, timeout=3300, recipe=RECIPE, seed=42):
    validate_run(recipe, seed)
    root = Path(__file__).resolve().parents[1] / 'vendor' / 'tabpack'
    root = Path(os.environ.get('STOCKVISION_TABPACK_ROOT', str(root))).resolve()
    python = root / '.venv' / 'bin' / 'python'
    if not python.is_file():
        raise ValueError('l4_tabpack_official_environment_missing')
    env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(root / 'src'), str(Path(__file__).resolve().parents[1]),
           str(Path(__file__).resolve().parents[2] / 'ml-controller'), '/root'])}
    subprocess.run([str(python), '-m', 'app.l4_tabpack_official', '--root', str(root),
                    '--dataset', str(dataset), '--output', str(output), '--recipe', recipe,
                    '--seed', str(seed)], cwd=root, env=env,
                   check=True, timeout=timeout)


def build_candidate(payload, bucket):
    source, anchor_path = payload['dataset_path'], payload['anchor_path']
    if (source != 'l4_distribution/native_datasets/' + payload['rows_checksum'] + '.json'
            or not anchor_path.startswith('l4_distribution/candidates/') or '..' in anchor_path.split('/')):
        raise ValueError('l4_tabpack_source_reference_invalid')
    rows = json.loads(bucket.blob(source).download_as_bytes())
    anchor = json.loads(bucket.blob(anchor_path).download_as_bytes())
    if digest(rows) != payload['rows_checksum'] or digest(anchor) != payload['anchor_checksum']:
        raise ValueError('l4_tabpack_source_checksum_mismatch')
    from app.l4_tabpack_stages import read_prepared, read_gpu_output
    prepared = read_prepared(payload, bucket)
    recipe, evidence = prepared['recipe'], prepared['evidence']
    dates = set(anchor['evaluation']['dates'])
    held = [row for row in rows if row['date'] in dates]
    with tempfile.TemporaryDirectory(prefix='stockvision-tabpack-finalize-') as temp:
        root = Path(temp)
        read_gpu_output(payload, bucket, root / 'output')
        result = json.loads((root / 'output/result.json').read_text())
        validate_result(result, recipe=payload['training_recipe'], seed=payload.get('seed', 42))
        raw = (root / 'output/weights.npz').read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        if sha != result['checkpoint_sha256']:
            raise ValueError('l4_tabpack_export_checksum_mismatch')
        ref = {'path': weights.PREFIX + sha + '.npz', 'sha256': sha, 'bytes': len(raw)}
        decoded = weights.decode(raw, ref)
        weights.validate_members(result, decoded)
        _write_once(bucket, ref['path'], raw, 'application/octet-stream')
        # Keep official reports/config/history and causal evidence, not just weights.
        manifest = {'recipe': payload['training_recipe'], 'upstream_commit': UPSTREAM_COMMIT, 'source': payload,
                    'causal_evidence': evidence, 'official': result}
        manifest_sha = digest(manifest)
        manifest_path = 'l4_distribution/tabpack_training/' + manifest_sha + '.json'
        _write_once(bucket, manifest_path, json.dumps(manifest, sort_keys=True, separators=(',', ':'), allow_nan=False).encode(), 'application/json')
        for name in ('experiments.json', 'online_ensemble_history.json', 'online_ensemble_predictions.npz'):
            path = root / 'output/experiment' / name
            if not path.is_file():
                raise ValueError('l4_tabpack_official_evidence_missing:' + name)
            _write_once(bucket, 'l4_distribution/tabpack_training/' + manifest_sha + '/' + name,
                        path.read_bytes(), 'application/octet-stream')
    residual = {'schema_version': weights.SCHEMA, 'inputs': 34, 'output': 'scalar_ev_correction',
                'activation': 'ReLU', 'anchor_model_checksum': digest(anchor['model']),
                'training_label_known_max': evidence['val_known_max'], 'recipe': recipe,
                'residual_mean': result['residual_mean'], 'residual_scale': result['residual_scale'],
                'members': result['members'], 'weights': ref,
                'provenance': {'seed': result['seed'], 'selection_rule': 'official_online_greedy_validation_only',
                    'upstream_commit': UPSTREAM_COMMIT, 'checkpoint_sha256': sha,
                    'training_recipe': payload['training_recipe'], 'n_models': result['config']['n_models'],
                    'partition_checksum': digest(evidence['partitions']),
                    'source_rows_checksum': evidence['source_rows_checksum'],
                    'training_manifest_sha256': manifest_sha, 'training_manifest_path': manifest_path}}
    residual['payload_checksum'] = digest(residual)
    candidate = deepcopy(anchor)
    candidate.pop('candidate_id', None)
    candidate['model']['residual_tabpack'] = residual
    candidate['model_checksum'] = digest(candidate['model'])
    candidate['release'] = {'scope': 'research', 'decision': 'CANDIDATE'}
    candidate['export_verification'] = result['export_verification']
    candidate['challenger_training_source'] = dict(payload)
    validate_bundle(candidate, l3_identity=candidate['l3_identity'], signal_date=payload['as_of'], require_paper_release=False)
    outputs = predict(held, candidate['model'])
    from services.l4_prediction_evaluation import evaluate_predictions
    candidate['evaluation'] = {'method': 'untouched_later_dates_no_refit', 'dates': anchor['evaluation']['dates'],
        'rows': len(held), 'rows_checksum': digest(held),
        'ev_mse': sum((p['expected_return_gross'] - r['gross_return']) ** 2 for r, p in zip(held, outputs, strict=True)) / len(held),
        'zero_mse': sum(r['gross_return'] ** 2 for r in held) / len(held),
        'native_l3_comparison': evaluate_predictions(held, outputs, model=candidate['model']),
        'portfolio_superiority': 'requires_same_account_execution_comparison'}
    candidate['candidate_id'] = 'l4_distribution:' + digest(candidate)
    return {**persist_candidate(candidate, bucket=bucket), 'model_schema': weights.SCHEMA,
            'training_recipe': payload['training_recipe'], 'run_key': payload['run_key'], 'weights': ref}


def run(payload, *, bucket=None):
    from app.l4_tabpack_stages import run_stage
    return run_stage(payload, 'prepare', bucket=bucket)
