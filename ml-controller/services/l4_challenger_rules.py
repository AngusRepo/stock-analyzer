"""Bind the original immutable R30/R31/R32 rule document, byte for byte."""
import hashlib
from pathlib import Path

RULES_DOCUMENT_SHA256 = '980d8d2cc9a07e2eece7e46630b5c6927920173a080b1e15a26b36ce0c46e96f'


def verify_document(raw=None):
    if raw is None:
        raw = (Path(__file__).resolve().parents[1]/'policies/P4-CHALLENGER-RULES-v1.md').read_bytes()
    if not isinstance(raw, bytes) or hashlib.sha256(raw).hexdigest() != RULES_DOCUMENT_SHA256:
        raise ValueError('challenger_sealed_rules_document_changed')
    return RULES_DOCUMENT_SHA256
