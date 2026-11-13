"""R33 object identity in the active8 ensemble table and frozen inference (R33-NEW-08). Synthetic fixtures only."""
from copy import deepcopy
from datetime import datetime, timezone
import json

import pytest

from services.ensemble_v2 import ARTIFACT_SCHEMA_VERSION, ensemble_artifact_id
from services.paired_nav_journal import digest
from services.paired_nav_l3_candidate import _validate_payload_identity
from test_r33_l4_equal7 import IDENTITY, _ensemble

NOW = datetime(2026, 11, 9, 8, tzinfo=timezone.utc)


# --- identity --------------------------------------------------------------------------------

def test_r33_artifact_id_is_its_own_derivation():
    ensemble = _ensemble()
    assert ensemble_artifact_id(ensemble) == ensemble['artifact_id'] == IDENTITY['artifact_id']
    assert ensemble_artifact_id({'cohort_id': 'c1', 'payload_checksum': 'f' * 64}).startswith('active8-ensemble:c1:')


def _row(ensemble):
    return {'artifact_id': ensemble['artifact_id'], 'cohort_id': ensemble['cohort_id'], 'training_run_id': 'r33-run-1',
            'knowledge_cutoff_date': '2026-10-30', 'schema_version': ARTIFACT_SCHEMA_VERSION,
            'payload_json': json.dumps(ensemble), 'payload_checksum': ensemble['payload_checksum'],
            'base_artifact_set_checksum': ensemble['base_artifact_set_checksum'],
            'validation_decision': 'PASS', 'validation_json': json.dumps(ensemble['validation']),
            'archive_uri': 'gs://stockvision-models/r33/monthly_candidates/c1/bundle.json'}


def test_r33_table_row_keeps_the_row_format_and_binds_the_payload():
    ensemble = _ensemble()
    _validate_payload_identity(_row(ensemble), ensemble)
    for key, value in (('schema_version', 'r33-roster-ensemble-v1'), ('artifact_id', 'active8-ensemble:c1:x'),
                       ('knowledge_cutoff_date', '2026/10/30'), ('knowledge_cutoff_date', None),
                       ('validation_json', json.dumps({'decision': 'PASS'})), ('validation_decision', 'FAIL'),
                       ('cohort_id', 'c2'), ('payload_checksum', '0' * 64), ('archive_uri', ''),
                       ('training_run_id', '')):
        with pytest.raises(ValueError, match='paired_nav_l3_artifact_registry_mismatch'):
            _validate_payload_identity({**_row(ensemble), key: value}, ensemble)
    forged = deepcopy(ensemble)
    forged['base_artifacts']['GNN']['version'] = 'GNN-v0'
    with pytest.raises(ValueError):
        _validate_payload_identity(_row(ensemble), forged)


def test_r33_frozen_inference_needs_a_paper_admission():
    from services.active8_nav_inference import SCHEMA, restore_frozen_nav_inference
    ensemble = _ensemble()
    body = {'schema_version': SCHEMA, 'scope': 'frozen_compute_only', 'captured_at': NOW.isoformat(),
            'artifact_checksum': ensemble['payload_checksum'], 'publication_receipt': {'nav_validation': {}},
            'review_records': []}
    with pytest.raises(ValueError, match='r33_nav_inference_requires_paper_admission'):
        restore_frozen_nav_inference({**body, 'context_checksum': digest(body)}, artifact=ensemble, pool_models={})
