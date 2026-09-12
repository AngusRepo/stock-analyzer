from copy import deepcopy

from routers import intraday


def test_native_frozen_rescore_matches_live_calculation_without_reading_new_configuration(monkeypatch):
    cfg = dict(intraday._INTRADAY_DEFAULTS)
    predictions = {'2330': {'signal_raw': 'BUY', 'direction_accuracy': 0.7}}
    req = intraday.RescoreRequest(positions=[intraday.PositionInput(symbol='2330', shares=100,
        entry_price=100, entry_date='2026-09-01', current_price=95)], today='2026-09-07')
    monkeypatch.setattr(intraday, '_get_intraday_config', lambda: deepcopy(cfg))
    monkeypatch.setattr(intraday, 'load_latest_ensemble_predictions', lambda *args: deepcopy(predictions))
    live = intraday.rescore_positions(req)
    def forbidden(*args):
        raise AssertionError('Frozen rescore must not query live state')
    monkeypatch.setattr(intraday, '_get_intraday_config', forbidden)
    monkeypatch.setattr(intraday, 'load_latest_ensemble_predictions', forbidden)
    assert intraday.evaluate_rescore(req, cfg=cfg, predictions_map=predictions, tw_today=req.today) == live
    assert cfg == intraday._INTRADAY_DEFAULTS
