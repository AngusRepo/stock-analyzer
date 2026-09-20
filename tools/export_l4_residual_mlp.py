"""Export a verified trained challenger; no fitting or publication authority."""
from copy import deepcopy
import hashlib
from pathlib import Path


def export(checkpoint_path, receipt, anchor_model):
    import torch
    from services.l4_distribution import digest
    from services.l4_residual_mlp import SCHEMA, validate
    raw = Path(checkpoint_path).read_bytes()
    checksum = hashlib.sha256(raw).hexdigest()
    if receipt.get('status') != 'complete' or receipt.get('model_sha256') != checksum:
        raise ValueError('l4_mlp_export_checkpoint_unverified')
    if not receipt['inner_train_known_max'] < receipt['inner_valid_date_min']:
        raise ValueError('l4_mlp_export_inner_purge_invalid')
    import io
    state = torch.load(io.BytesIO(raw), map_location='cpu', weights_only=True)
    result = {'schema_version': SCHEMA, 'inputs': 34, 'width': 128, 'blocks': 3,
        'output': 'scalar_ev_correction', 'anchor_model_checksum': digest(anchor_model),
        'training_label_known_max': receipt['training_label_known_max'],
        'residual_scale': receipt['fit']['residual_scale'], 'recipe': deepcopy(receipt['recipe']),
        'state': {name: value.detach().cpu().tolist() for name,value in state.items()},
        'source_checkpoint_sha256': checksum, 'source_fit_receipt_checksum': digest(receipt)}
    result['payload_checksum'] = digest(result)
    validate(result, anchor_model=anchor_model)
    return result
