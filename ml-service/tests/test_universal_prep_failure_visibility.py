import pytest
from app import features,universal_training as u

def test_unexpected_feature_exception_cannot_shrink_training_universe(monkeypatch):
    def fail(*a,**kw):raise KeyError("missing auxiliary field")
    monkeypatch.setattr(features,"build_feature_matrix",fail)
    monkeypatch.setattr(u,"_get_bucket",lambda:pytest.fail("partial artifact published"))
    req=u.UniversalPrepRequest(payloads=[{"symbol":"2330","prices":[{}]*60}])
    with pytest.raises(ValueError,match="feature_data_quality_build_failed:2330:KeyError"):
        u.prep_universal_batch(req)

def test_explicit_insufficient_history_remains_distinct_from_pipeline_exception(monkeypatch):
    monkeypatch.setattr(features,"build_feature_matrix",lambda *a,**kw:pytest.fail("too short"))
    result=u.prep_universal_batch(u.UniversalPrepRequest(payloads=[{"symbol":"NEW","prices":[{}]*59}]))
    assert result["skipped"]==1 and result["rows"]==0
