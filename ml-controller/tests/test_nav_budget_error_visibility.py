import pytest
from services.paired_nav_collection import shadow_failure
from services import paired_native_runtime as runtime


def failure(monkeypatch, reason):
    def register(**kwargs):
        raise ValueError(reason)
    monkeypatch.setattr(runtime, 'register_allocation_pair', register)
    with pytest.raises(ValueError) as caught:
        runtime._register_with_visible_budget()
    return shadow_failure('native_registration', caught.value)['reason']


@pytest.mark.parametrize('reason', [
    'native_bootstrap_copy_bound_exceeded:paper_execution_events',
    'native_bootstrap_copy_bytes_exceeded:pending_buy_items',
])
def test_owned_budget_errors_name_the_failed_table(monkeypatch, reason):
    assert failure(monkeypatch, reason) == reason.replace(':', '_table_', 1)


@pytest.mark.parametrize('reason', [
    'native_bootstrap_copy_bytes_exceeded:table?token=secret',
    'native_bootstrap_copy_bound_exceeded:paper_execution_events\nAuthorization: secret',
    'provider failed https://example.test?token=secret',
])
def test_provider_and_malformed_details_remain_private(monkeypatch, reason):
    assert failure(monkeypatch, reason) == 'paired_nav_source_or_capture_failed'
