"""Exact audited storage-only native builds share an economic policy identity.

Raw execution fingerprints remain in captured environments and runtime manifests.
Unknown builds never inherit an approved identity. This is source equivalence,
not a model efficacy verdict or permission to rewrite prior evidence.
"""
import json
from pathlib import Path
from services.paired_nav_journal import digest


def policy_execution_owner(runtime_identity):
    certificate = json.loads(Path(__file__).with_name('native_execution_equivalence.json').read_text(encoding='utf-8'))
    if (certificate.get('schema_version') != 'native-storage-equivalence-v1'
            or certificate.get('scope') != 'identical_execution_economics_and_evidence_bytes'
            or not isinstance(certificate.get('policy_components'), dict)
            or not isinstance(certificate.get('runtime_components'), list)):
        raise ValueError('native_storage_equivalence_certificate_invalid')
    # Later debate policies have their own approved identity. Storage-only
    # successors must retain that identity, never inherit the older policy.
    groups = [certificate, *certificate.get('additional_groups', [])]
    owners = {}
    for group in groups:
        if not isinstance(group.get('policy_components'), dict) or not isinstance(group.get('runtime_components'), list):
            raise ValueError('native_storage_equivalence_certificate_invalid')
        policy = 'native-paper-v1:' + digest(group['policy_components'])
        for parts in group['runtime_components']:
            identity = 'native-paper-v1:' + digest(parts)
            if identity in owners and owners[identity] != policy:
                raise ValueError('native_storage_equivalence_certificate_ambiguous')
            owners[identity] = policy
    return owners.get(runtime_identity, runtime_identity)
