from services import runtime_phase_metrics as metrics


def test_cgroup_v1_fallback_reports_container_and_children(monkeypatch):
    values={'/sys/fs/cgroup/memory/memory.usage_in_bytes':'1000',
            '/sys/fs/cgroup/memory/memory.max_usage_in_bytes':'2000'}
    class FakePath:
        def __init__(self,*parts):self.name='/'.join(parts)
        def read_text(self):
            if self.name not in values:raise FileNotFoundError(self.name)
            return values[self.name]
    monkeypatch.setattr(metrics,'Path',FakePath)
    result=metrics.memory_bytes()
    assert result['container_current_bytes']==1000
    assert result['container_peak_bytes']==2000
    assert result['container_memory_status']=='available'


def test_missing_cgroup_is_explicitly_unavailable_not_zero(monkeypatch):
    class Missing:
        def __init__(self,*a):pass
        def read_text(self):raise FileNotFoundError
    monkeypatch.setattr(metrics,'Path',Missing)
    result=metrics.memory_bytes()
    assert result['container_memory_status']=='unavailable'
    assert 'container_current_bytes' not in result
