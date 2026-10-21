from copy import deepcopy
import pytest
from services.l4_challenger_rules import RULES_DOCUMENT_SHA256,verify_document
from services.l4_challenger_comparison import seal
from services.l4_challenger_registry import Registry,PREFIX
from test_l4_challenger_registry import Bucket,entry


def test_exact_rules_document_and_registry_binding():
    assert verify_document()==RULES_DOCUMENT_SHA256
    with pytest.raises(ValueError,match='document_changed'):
        verify_document(b'edited rules')
    e=entry('champion');bucket=Bucket()
    registry=Registry(bucket,formal_identity=lambda:e['serving_identity'],clock=lambda:'2026-10-20T00:00:00Z')
    result=registry.initialize(e)
    assert result['rules_document_sha256']==RULES_DOCUMENT_SHA256
    assert registry.seal_rules()['rules_document_sha256']==RULES_DOCUMENT_SHA256
    assert registry.current()[0]==result
