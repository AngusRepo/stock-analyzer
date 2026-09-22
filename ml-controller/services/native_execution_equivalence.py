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
    policy = 'native-paper-v1:' + digest(certificate['policy_components'])
    permitted = {'native-paper-v1:' + digest(parts) for parts in certificate['runtime_components']}
    return policy if runtime_identity in permitted else runtime_identity
