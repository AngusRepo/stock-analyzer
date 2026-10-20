import asyncio
from unittest.mock import AsyncMock, Mock
import pytest
from app.walk_forward_regime_policy import run_window

def test_shared_environment_does_not_read_history_or_train():
    train=AsyncMock();history=Mock(side_effect=AssertionError('historical helper called'))
    result=asyncio.run(run_window(regime_mode='shared_dated_environment',window_id=6,
        train_end='2026-09-22',filtered_env=history,train=train))
    train.assert_not_called();history.assert_not_called()
    assert result['status']=='not_trained' and result['training_dispatched'] is False
    assert result['artifact_created'] is False and result['historical_regime_reconstructed'] is False

def test_legacy_mode_keeps_explicit_training_and_unknown_mode_fails():
    train=AsyncMock(return_value={'artifact':'legacy'});history=Mock(return_value={'history':{}})
    assert asyncio.run(run_window(regime_mode='train_window',window_id=1,train_end='2026-09-22',
        filtered_env=history,train=train))=={'artifact':'legacy'}
    train.assert_awaited_once_with(dict(window_id=1,train_end='2026-09-22',market_env={'history':{}}))
    train.reset_mock();history.reset_mock()
    with pytest.raises(ValueError):asyncio.run(run_window(regime_mode='typo',window_id=1,
        train_end='2026-09-22',filtered_env=history,train=train))
    train.assert_not_called();history.assert_not_called()
