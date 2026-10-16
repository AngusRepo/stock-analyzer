"""One-pass verified acquisition and explicit sealed sequence ownership."""
from copy import deepcopy
from dataclasses import FrozenInstanceError
import gzip
import hashlib
import json
from pathlib import Path

import pytest

from services import paired_nav_cold as cold
from services import state_space_series as sequences
from services.paired_nav_journal import digest
from services.paired_nav_read_cache import reuse_verified_cold_reads, _scope
from test_paired_nav_cold import env, freeze
from test_paired_nav_atomic_dispatch import dispatched
from test_dated_canonical_sequences import canonical, _payload, _prep


@pytest.mark.parametrize('bom,bigint', [(False, False), (True, False), (False, True), (True, True)])
def test_fused_parse_verifies_bom_and_numeric_replay(tmp_path, bom, bigint):
    value = {'content': {'keep': {'negative_zero': -0.0, 'tiny': 1e-320}},
             'last': 2**100 if bigint else 1, 'ignored': list(range(300))}
    raw = (b'\xef\xbb\xbf' if bom else b'') + json.dumps(value).encode()
    path = tmp_path / 'source.gz'; path.write_bytes(gzip.compress(raw))
    actual = cold.parse_file(path, prefixes={'content.keep'},
        checksum=hashlib.sha256(raw).hexdigest(), byte_count=len(raw))
    assert digest(actual) == digest({'content': {'keep': value['content']['keep']}})
    assert cold.parse_file(path, checksum=hashlib.sha256(raw).hexdigest(), byte_count=len(raw)) == value


def test_first_projection_uses_one_gzip_open_and_preserves_verified_file_hits(env, monkeypatch):
    db, objects = env
    manifest = freeze(db, {'keep': 1, 'other': 2, 'history': list(range(1000))})
    original, opens, downloads = gzip.open, [], []
    def tracked(*args, **kwargs):
        opens.append(args[0]); return original(*args, **kwargs)
    download = objects.download
    def tracked_download(*args):
        downloads.append(args[0]); return download(*args)
    monkeypatch.setattr(gzip, 'open', tracked)
    monkeypatch.setattr(objects, 'download', tracked_download)
    with reuse_verified_cold_reads():
        assert cold.load(db.query, manifest, objects, prefixes={'content.keep'})['content'] == {'keep': 1}
        assert len(opens) == 1 and len(downloads) == 1
        assert cold.load(db.query, manifest, objects, prefixes={'content.other'})['content'] == {'other': 2}
        assert len(opens) == 2 and len(downloads) == 1


@pytest.mark.parametrize('partial_decoder', [False, True])
def test_failed_or_partially_consumed_object_cannot_publish_cache(env, monkeypatch, partial_decoder):
    from services import streaming_json_reader
    db, objects = env
    manifest = freeze(db, {'keep': 1, 'tail': 'a'*100000})
    key = cold._row(db.query, manifest['snapshot_id'])['object_key']
    original = objects.data[key]
    raw = gzip.decompress(original)
    altered = raw[:-2] + b'b' + raw[-1:]
    objects.data[key] = gzip.compress(altered)
    if partial_decoder:
        def partial(source, **kwargs):
            source.read(1)
            return {'content': {'keep': 1}}
        monkeypatch.setattr(streaming_json_reader, 'load', partial)
    with reuse_verified_cold_reads():
        with pytest.raises(RuntimeError, match='checksum_mismatch'):
            cold.load(db.query, manifest, objects, prefixes={'content.keep'})
        assert not _scope.get().entries and _scope.get().bytes == 0
        assert not list(Path(_scope.get().directory).iterdir())
    objects.data[key] = original


@pytest.mark.parametrize('fault', ['truncated_gzip', 'trailing_garbage', 'too_small', 'too_large'])
def test_fused_parse_rejects_invalid_json_or_incomplete_identity(tmp_path, fault):
    raw = b'{"content":{"keep":1},"tail":[1,2,3]}'
    if fault == 'trailing_garbage': raw += b' garbage'
    body = gzip.compress(raw)
    if fault == 'truncated_gzip': body = body[:-6]
    size = len(raw) + (1 if fault == 'too_large' else -1 if fault == 'too_small' else 0)
    path = tmp_path / 'invalid.gz'; path.write_bytes(body)
    with pytest.raises(Exception):
        cold.parse_file(path, prefixes={'content.keep'}, checksum=hashlib.sha256(raw).hexdigest(), byte_count=size)


def packet():
    payloads = [{'symbol': s, 'prices': [{'date': '2026-10-15', 'close': i+1}]} for i, s in enumerate(('A','B','C'))]
    body = {'schema_version': 'pipeline-sequence-observations-v1', 'signal_date': '2026-10-15',
        'observed_at': '2026-10-15T12:00:00Z', 'input_fingerprints': sequences.sequence_input_fingerprints(payloads),
        'series': [{'symbol': row['symbol'], 'prices': [i+1.0], 'dates': ['2026-10-15']} for i, row in enumerate(payloads)],
        'metadata': {'canonical_observations': [{'symbol':'A', 'values':list(range(1000))}]}}
    return {**body, 'source_checksum': digest(body)}, payloads


def test_explicit_sealed_reader_hashes_once_and_never_copies_discarded_metadata(monkeypatch):
    from services import paired_nav_journal as journal
    saved, payloads = packet(); hashes, copies = [], []
    original_digest, original_copy = journal.digest, sequences.deepcopy
    def tracked_digest(value):
        if isinstance(value, dict) and value.get('schema_version') == 'pipeline-sequence-observations-v1':
            hashes.append(1)
        return original_digest(value)
    def tracked_copy(value):
        if value is saved['metadata']: copies.append(1)
        return original_copy(value)
    monkeypatch.setattr(journal, 'digest', tracked_digest)
    monkeypatch.setattr(sequences, 'deepcopy', tracked_copy)
    slates = [payloads, payloads[:1], payloads[1:], payloads[::2], payloads, [], payloads[2:]]
    expected = [sequences.read_frozen_sequence_inputs(saved, decision_date='2026-10-15', payloads=rows)[0]
                for rows in slates]
    assert len(hashes) == 7 and len(copies) == 7
    hashes.clear(); copies.clear()
    reader = sequences.VerifiedSequenceInputs(saved, decision_date='2026-10-15', include_metadata=False)
    assert [reader.read(rows)[0] for rows in slates] == expected
    assert len(hashes) == 1 and not copies


def test_sealed_view_is_detached_and_public_reader_still_rejects_mutated_packet():
    saved, payloads = packet()
    reader = sequences.VerifiedSequenceInputs(saved, decision_date='2026-10-15')
    expected = reader.read(payloads)
    saved['series'][0]['prices'][0] = 999
    saved['metadata']['canonical_observations'][0]['values'].append(999)
    saved['input_fingerprints']['A'] = 'f'*64
    assert reader.read(payloads) == expected
    with pytest.raises(ValueError, match='sequence_snapshot_invalid'):
        sequences.read_frozen_sequence_inputs(saved, decision_date='2026-10-15', payloads=payloads)
    with pytest.raises(TypeError): reader._rows['A'] = b'forged'
    with pytest.raises(FrozenInstanceError): reader.source_checksum = 'forged'
    result = reader.read(payloads); result[0][0]['prices'][0] = 333
    result[1]['canonical_observations'].clear()
    assert reader.read(payloads) == expected
    changed = deepcopy(payloads); changed[0]['prices'][0]['close'] = 5
    with pytest.raises(ValueError, match='raw_inputs_changed'): reader.read(changed)
    with pytest.raises(ValueError, match='observed_after_parent'):
        reader.read(payloads, observed_before='2026-10-15T11:00:00Z')


def test_actual_atomic_prepare_uses_one_sequence_validation_for_all_isolated_slates(dispatched, monkeypatch):
    from services import paired_nav_journal as journal
    from services.paired_nav_atomic_dispatch import prepare_atomic_request
    _, state, request = dispatched
    expected = deepcopy(state['paired_nav_atomic_dispatch'])
    original_digest, original_read = journal.digest, sequences.VerifiedSequenceInputs.read
    hashes, selections, metadata_copies = [], [], []
    def tracked_digest(value):
        if isinstance(value, dict) and value.get('schema_version') == 'pipeline-sequence-observations-v1':
            hashes.append(1)
        return original_digest(value)
    def tracked_read(self, payloads, **kwargs):
        selections.append(tuple(row['symbol'] for row in payloads))
        return original_read(self, payloads, **kwargs)
    original_copy = sequences.deepcopy
    def tracked_copy(value):
        if value is state['pipeline_sequence_observations']['metadata']:
            metadata_copies.append(1)
        return original_copy(value)
    monkeypatch.setattr(journal, 'digest', tracked_digest)
    monkeypatch.setattr(sequences.VerifiedSequenceInputs, 'read', tracked_read)
    monkeypatch.setattr(sequences, 'deepcopy', tracked_copy)
    assert prepare_atomic_request(state, request) == expected
    assert len(selections) > 2 and len(set(selections)) > 1
    assert len(hashes) == 1 and metadata_copies == []


def test_new_pipeline_sequence_capture_does_not_copy_discarded_union_or_hash_thrice(monkeypatch, canonical):
    from graphs import daily_pipeline_v2 as graph
    from services import paired_nav_journal as journal
    _prep(monkeypatch)
    monkeypatch.setattr(graph, 'daily_sequence_target_points', lambda: 6)
    state = {'run_date': '2026-09-06', 'payloads': _payload()}
    original, hashes = journal.digest, []
    def tracked(value):
        if isinstance(value, dict) and value.get('schema_version') == 'pipeline-sequence-observations-v1':
            hashes.append(1)
        return original(value)
    monkeypatch.setattr(journal, 'digest', tracked)
    # The old initial validation deep-copied the entire union merely to discard
    # it. The new capture freezes once and creates only its requested result.
    with monkeypatch.context() as local:
        original_copy = sequences.deepcopy
        def forbid_discarded_result(value):
            if isinstance(value, dict) and ('prices' in value or 'canonical_observations' in value):
                pytest.fail('discarded/public copy during initial capture')
            return original_copy(value)
        local.setattr(sequences, 'deepcopy', forbid_discarded_result)
        result = graph._pipeline_sequence_inputs(state, state['payloads'])
    assert len(hashes) == 2  # Producer checksum + one independent verified capture.
    assert result[0][0]['prices'] == [90, 92, 94, 96, 98, 100]
    saved = deepcopy(state['pipeline_sequence_observations'])
    hashes.clear()
    assert graph._pipeline_sequence_inputs(state, state['payloads']) == result
    assert len(hashes) == 1, 'existing saved state must still be freshly authenticated'
    assert state['pipeline_sequence_observations'] == saved
    state['pipeline_sequence_observations']['metadata']['mutated'] = True
    with pytest.raises(ValueError, match='sequence_snapshot_invalid'):
        graph._pipeline_sequence_inputs(state, state['payloads'])
