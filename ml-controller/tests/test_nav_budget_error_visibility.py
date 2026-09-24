import pytest
from services.paired_nav_collection import shadow_failure


@pytest.mark.parametrize('reason', [
    'native_bootstrap_copy_bound_exceeded:paper_execution_events',
    'native_bootstrap_copy_bytes_exceeded:pending_buy_items',
])
def test_owned_budget_errors_name_the_failed_table(reason):
    assert shadow_failure('native_registration', ValueError(reason))['reason'] == reason


@pytest.mark.parametrize('reason', [
    'native_bootstrap_copy_bytes_exceeded:table?token=secret',
    'native_bootstrap_copy_bound_exceeded:paper_execution_events\nAuthorization: secret',
    'provider failed https://example.test?token=secret',
])
def test_provider_and_malformed_details_remain_private(reason):
    assert shadow_failure('native_registration', ValueError(reason))['reason'] == 'paired_nav_source_or_capture_failed'
