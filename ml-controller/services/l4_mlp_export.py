"""Export existing complete E0 checkpoints; never trains or publishes anything."""
from copy import deepcopy
import argparse
import hashlib
import json
from pathlib import Path

from services.l4_distribution import digest, validate_bundle
from services.l4_residual_mlp import SCHEMA as SINGLE_SCHEMA, OUTPUTS
from services.l4_mlp_median import SCHEMA, SEEDS, validate


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def export_member(state, *, recipe, anchor, training, provenance):
    value = dict(schema_version=SINGLE_SCHEMA, inputs=34, width=128, blocks=3,
        output='scalar_ev_correction', anchor_model_checksum=digest(anchor),
        training_label_known_max=training['training_label_known_max'],
        residual_scale=training['training']['residual_scale'], recipe=deepcopy(recipe),
        state={key: tensor.detach().cpu().float().numpy().tolist() for key,tensor in state.items()})
    value['payload_checksum'] = digest(value)
    return {'seed':provenance['seed'], 'model':value, 'provenance':deepcopy(provenance)}


def ensemble(anchor, members, *, multiplier=1.0):
    value = dict(schema_version=SCHEMA, aggregation='median_residual_per_symbol',
        residual_multiplier=multiplier, missing_member_policy='fail_closed',
        anchor_model_checksum=digest(anchor), members=members,
        training_label_known_max=max(m['model']['training_label_known_max'] for m in members))
    value['payload_checksum'] = digest(value)
    validate(value, anchor_model=anchor)
    return value


def export(folder, *, serving_artifact, signal_date):
    import torch
    folder = Path(folder)
    anchor = read(folder/'w22-anchor-original.json')
    partition = read(folder/'w22-partition.json')
    if (anchor['model_checksum'] != digest(anchor['model'])
            or anchor['model_checksum'] != partition['anchor_model_checksum']):
        raise ValueError('mlp_export_anchor_mismatch')
    members = []
    for seed in SEEDS:
        receipt_path = folder/f'w22-MLP-{seed}.json'
        checkpoint = folder/f'w22-MLP-{seed}.pt'
        receipt = read(receipt_path)
        if (receipt.get('status') != 'complete' or receipt.get('seed') != seed
                or receipt.get('kind') != 'MLP' or receipt.get('fold') != partition['fold']
                or receipt['checkpoint_sha256'] != sha(checkpoint)
                or receipt['partition_sha256'] != partition['matrix_sha256']
                or receipt['training_label_known_max'] != partition['training_label_known_max']):
            raise ValueError('mlp_export_checkpoint_identity_invalid')
        members.append(export_member(torch.load(checkpoint, map_location='cpu', weights_only=True),
            recipe=partition['recipes']['full'], anchor=anchor['model'], training=receipt,
            provenance={'seed':seed, 'checkpoint_sha256':sha(checkpoint),
                'training_receipt_sha256':sha(receipt_path), 'partition_sha256':sha(folder/'w22-partition.json')}))
    candidate = deepcopy(anchor)
    candidate['training_l3_identity'] = deepcopy(anchor['l3_identity'])
    # Preserve original training identity separately. Serving uses the verified
    # unchanged feature-coordinate contract; this is an authorized experiment,
    # never a claim that the two L3 artifacts are identical.
    candidate['l3_identity'] = deepcopy(serving_artifact['l3_identity'])
    if candidate['feature_schema'] != serving_artifact['feature_schema']:
        raise ValueError('mlp_export_serving_feature_schema_changed')
    if candidate['model']['recipe']['names'] != serving_artifact['model']['recipe']['names']:
        raise ValueError('mlp_export_serving_coordinates_changed')
    candidate['model']['residual_mlp'] = ensemble(anchor['model'], members)
    candidate['model_checksum'] = digest(candidate['model'])
    candidate['release'] = {'scope':'research', 'decision':'CANDIDATE'}
    candidate['export_source'] = {'anchor_sha256':sha(folder/'w22-anchor-original.json'),
        'partition_sha256':sha(folder/'w22-partition.json'), 'training_executed':False,
        'training_l3_identity':anchor['l3_identity'], 'serving_l3_identity':candidate['l3_identity']}
    validate_bundle(candidate, l3_identity=candidate['l3_identity'], signal_date=signal_date, require_paper_release=False)
    return candidate


