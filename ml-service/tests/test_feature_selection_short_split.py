import pytest
from app.feature_selection import selection_date_partitions


def test_short_split_keeps_two_full_embargo_gaps_and_nonempty_parts():
    days = [f"d{i:03d}" for i in range(56)]
    train, valid, test, evidence = selection_date_partitions(days, 10)
    assert [len(train), len(valid), len(test)] == [25, 3, 8]
    assert evidence["train_validation_gap"] == evidence["validation_test_gap"] == 10
    assert max(train) < min(valid) < max(valid) < min(test)
    assert not train & valid and not valid & test


def test_expanding_split_is_unchanged():
    days = [f"d{i:03d}" for i in range(338)]
    train, valid, test, evidence = selection_date_partitions(days, 10)
    assert train == set(days[:236])
    assert valid == set(days[246:270])
    assert test == set(days[280:])
    assert evidence["partition_mode"] == "legacy_70_10_20_with_embargo"


def test_cannot_create_data_by_relaxing_embargo():
    with pytest.raises(ValueError, match="insufficient_dates"):
        selection_date_partitions([str(i) for i in range(25)], 10)
