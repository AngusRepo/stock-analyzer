"""Publish existing native shadow sources, then their complete daily index.

This is the publication boundary, not a second inference implementation. Each
source must come from the entry's own frozen L3 and L4 path. Publication neither
initializes accounts nor grants outer-day acceptance.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from google.api_core.exceptions import PreconditionFailed

from services.l4_challenger_comparison import seal, verify
from services.l4_challenger_rules import verify_document
from services.l4_shadow_producer import DAILY_PREFIX, build_daily_packet, read_reference


def source_from_packet(packet, entry, *, observed_at, now):
    """Export the original private serializer packet without relabelling it."""
    verify(packet)
    source = seal({
        **{key: deepcopy(value) for key, value in packet.items() if key != 'checksum'},
        'schema': 'l4-shadow-native-day-source-v1',
        'rules_document_sha256': verify_document(),
        'entry_checksum': entry['checksum'],
        'observed_at': observed_at,
    })
    build_daily_packet(source, entry, session_date=packet['session_date'], now=now)
    return source


def _put(bucket, path, value):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                     allow_nan=False).encode()
    blob = bucket.blob(path)
    try:
        blob.upload_from_string(raw, content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        pass
    blob.reload()
    reference = {'path': path, 'generation': str(blob.generation),
                 'sha256': hashlib.sha256(raw).hexdigest()}
    # A conflicting old object must never be overwritten, even after a partial
    # earlier publication. The exact bytes and server generation own the ref.
    if read_reference(bucket, reference) != value:
        raise ValueError('shadow_source_publication_readback_mismatch')
    return reference


def publish_day(registry, sources, *, session_date, now):
    """Validate every source first; publish index only after all source readbacks."""
    current, _ = registry.current()
    if not current or not current.get('entries') or set(sources) != set(current['entries']):
        raise ValueError('shadow_source_export_inventory_invalid')
    for key, entry in current['entries'].items():
        build_daily_packet(sources[key], entry, session_date=session_date, now=now)
    references = {}
    for key in sorted(sources):
        source = sources[key]
        path = DAILY_PREFIX + session_date + '/sources/' + source['checksum'] + '.json'
        references[key] = _put(registry.bucket, path, source)
    latest, _ = registry.current()
    if latest != current:
        raise ValueError('shadow_source_export_registry_changed')
    index = seal({
        'schema': 'l4-shadow-native-day-index-v1',
        'rules_document_sha256': verify_document(),
        'registry_checksum': current['checksum'],
        'session_date': session_date,
        'sources': references,
    })
    reference = _put(registry.bucket, DAILY_PREFIX + session_date + '/index.json', index)
    return {'status': 'published', 'session_date': session_date,
            'source_index_reference': reference, 'source_index_checksum': index['checksum'],
            'entries': sorted(references), 'production_effect': False,
            'outer_acceptance_credit': 0}


def publish_directory(registry, directory, *, session_date, now):
    """Job entry for native producers' existing <entry_id>.json source files."""
    root = Path(directory)
    current, _ = registry.current()
    if not root.is_dir() or not current:
        raise ValueError('shadow_native_source_directory_missing')
    files = {path.stem: path for path in root.glob('*.json') if path.is_file()}
    if set(files) != set(current['entries']):
        raise ValueError('shadow_source_export_inventory_invalid')
    sources = {key: json.loads(path.read_bytes()) for key, path in files.items()}
    return publish_day(registry, sources, session_date=session_date, now=now)
