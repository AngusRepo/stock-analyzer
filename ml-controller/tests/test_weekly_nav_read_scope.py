from types import SimpleNamespace
import pytest
from routers import walk_forward
from services import paired_nav_journal, paired_nav_daily_review, paired_nav_read_cache


def test_direct_weekly_nav_reuses_verified_reads_across_accounting_and_review(monkeypatch):
    reads = []
    def source():
        reads.append(1)
        return {"positions": [1, 2]}
    def phase(**kwargs):
        result = paired_nav_read_cache.cached_verified_read("immutable", source)
        assert result == {"positions": [1, 2]}
        result["positions"].append(9)
    def accounting(**kwargs):
        phase(**kwargs); phase(**kwargs)
        return {"status": "accounted"}
    def review(**kwargs):
        phase(**kwargs)
        return {"failures": []}
    monkeypatch.setattr(paired_nav_journal, "mature_staged_pairs", accounting)
    monkeypatch.setattr(paired_nav_daily_review, "run_daily_nav_reviews", review)
    client = SimpleNamespace(query=lambda *a: [], batch_execute=lambda *a: {},
                             atomic_batch_execute=lambda *a: {})
    for count in (1, 2):
        result = walk_forward._materialize_nav_with_reviews(
            business_date="2026-09-27", learning_client=client)
        assert result["status"] == "accounted"
        assert len(reads) == count
        assert paired_nav_read_cache._scope.get() is None


def test_direct_weekly_nav_failure_is_not_reused(monkeypatch):
    def fail(**kwargs):
        assert paired_nav_read_cache._scope.get() is not None
        raise RuntimeError("checksum mismatch")
    monkeypatch.setattr(paired_nav_journal, "mature_staged_pairs", fail)
    client = SimpleNamespace(query=lambda *a: [], batch_execute=lambda *a: {})
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        walk_forward._materialize_nav_with_reviews(
            business_date="2026-09-27", learning_client=client)
    assert paired_nav_read_cache._scope.get() is None


def test_daily_outer_evidence_scope_survives_shared_boundary():
    from services.paired_nav_evidence import reuse_verified_nav_evidence, _read_cache
    with reuse_verified_nav_evidence():
        original = _read_cache.get()
        original["proof"] = "same-closure"
        with reuse_verified_nav_evidence():
            assert _read_cache.get() is original
        assert _read_cache.get() is original
    assert _read_cache.get() is None
