import copy
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

import services.ipo_shadow as ipo

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def local(monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 7, 14, tzinfo=timezone.utc)
    monkeypatch.setattr(ipo, "datetime", Clock)
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript((ROOT / "worker/domain-migrations/learning/0039_ipo_prospective_shadow.sql").read_text())
    db.executescript("""CREATE TABLE price_horizon_labels_v1 (
      stock_id INTEGER, price_date TEXT, entry_date TEXT, exit_date TEXT, outcome_known_date TEXT,
      entry_raw_open REAL, entry_adjustment_factor REAL, exit_raw_close REAL, exit_adjustment_factor REAL,
      projection_version TEXT);
      CREATE TABLE finlab_source_sessions_v1(session_date TEXT);
    """)
    for day in ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14"]:
        db.execute("INSERT INTO finlab_source_sessions_v1 VALUES (?)", [day])
    def query(sql, params):
        return [dict(row) for row in db.execute(sql, params)]
    def writer(statements):
        for sql, params in statements:
            assert "ipo_shadow_" in sql  # This module cannot write formal/pointer/order tables.
            db.execute(sql, params)
        return {"success_count": len(statements), "error_count": 0}
    return db, query, writer


def candidates():
    return [{"row": {"stock_id": stock, "symbol": str(stock), "score_components": {"components": dict(zip(
        ["mlEdge", "fundamentalQuality", "chipFlow", "technicalStructure"], features))}},
        "prediction": {}, "l4_payload": {"expected_return_mean": l4_ev, "model_version": "ridge-original"},
        "generation_mode": "native", "model_set_signature": "same-eight", "target_semantic_version": "positive-v2"}
        for stock, features, l4_ev in [(1, [0., 0., 25., 0.], .02), (2, [25., 25., 0., 25.], .04)]]


def freeze(local, rows=None, day="2026-09-07", writer=None):
    return ipo.freeze_daily(snapshot_date=day, source_run_id="native-run", rows=rows or candidates(),
                            query=local[1], writer=writer or local[2])


def labels(local):
    for stock, close in [(1, 110.), (2, 90.)]:
        local[0].execute("INSERT INTO price_horizon_labels_v1 VALUES (?,?,?,?,?,?,?,?,?,?)",
                         [stock, "2026-09-07", "2026-09-08", "2026-09-14", "2026-09-14", 100., 1., close, 1., ipo.LABEL_VERSION])


def mature(local, day="2026-09-14"):
    return ipo.mature_daily(business_date=day, query=local[1], writer=local[2], market_query=local[1])


def test_freeze_mature_retry_cost_once_and_no_production_mutation(local):
    assert freeze(local)["status"] == "frozen"
    assert freeze(local)["status"] == "already_frozen"
    assert mature(local)["status"] == "pending_maturity"
    labels(local)
    assert mature(local, "2026-09-11")["status"] == "pending_maturity"
    assert mature(local)["evaluated_dates"] == 1
    assert mature(local)["evaluated_dates"] == 1
    evaluations = local[1]("SELECT * FROM ipo_shadow_daily_evaluations_v1", [])
    assert len(evaluations) == 1
    packet = json.loads(evaluations[0]["metrics_json"])
    assert packet["paired"] is True
    assert packet["ipo"]["proxy_net_return"] == pytest.approx(.10 - .0018)
    assert packet["cost_deducted_once_bps"] == 18
    assert packet["promotion_allowed"] is False and packet["exact_sparse_opb"] is False
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        local[0].execute("UPDATE ipo_shadow_predictions_v1 SET ipo_ev=1")


def test_historical_replay_cannot_register_or_count_as_prospective(local):
    assert freeze(local, day="2026-08-25")["status"] == "historical_not_prospective"
    assert local[1]("SELECT * FROM ipo_shadow_candidates_v1", []) == []


def test_partial_freeze_retries_without_erasing_or_refreezing_rows(local):
    failed = False
    def partial(statements):
        nonlocal failed
        if len(statements) > 1 and not failed:
            failed = True
            local[2](statements[:1])
            return {"error_count": 1, "success_count": 1}
        return local[2](statements)
    with pytest.raises(RuntimeError, match="write_incomplete"):
        freeze(local, writer=partial)
    assert local[1]("SELECT * FROM ipo_shadow_batches_v1", []) == []
    assert freeze(local)["status"] == "frozen"
    changed = candidates()
    changed[0]["row"]["score_components"]["components"]["mlEdge"] = 1
    with pytest.raises(RuntimeError, match="immutable_input_conflict"):
        freeze(local, rows=changed)


def test_no_synthetic_missing_values_or_reconstructed_features(local):
    rows = candidates()
    rows[0]["generation_mode"] = "counterfactual_reconstruction"
    with pytest.raises(RuntimeError, match="non_native"):
        freeze(local, rows=rows)
    rows = candidates()
    rows[0]["row"]["score_components"]["components"].pop("mlEdge")
    with pytest.raises(ValueError, match="feature_missing"):
        freeze(local, rows=rows)
    assert local[1]("SELECT * FROM ipo_shadow_candidates_v1", []) == []


def test_prospective_stacker_provenance_is_immutable_and_never_legacy_native(local):
    from services.ipo_prospective_inputs import MODE, SEAL_SHA256
    rows=candidates()
    for row in rows:
        row['generation_mode']=MODE
        row['input_provenance']={'mode':MODE,'stacker_seal_checksum':SEAL_SHA256,
            'prediction_date':'2026-09-07','production_effect':False,'training_dispatched':False}
    assert freeze(local,rows=rows)['status']=='frozen'
    assert freeze(local,rows=rows)['status']=='already_frozen'
    stored=local[1]('SELECT input_json FROM ipo_shadow_predictions_v1 ORDER BY stock_id',[])
    assert json.loads(stored[0]['input_json'])['input_mode']==MODE
    rows[0]['input_provenance']['training_dispatched']=True
    with pytest.raises(RuntimeError,match='provenance_invalid'):
        freeze(local,rows=rows)


def test_maturity_validates_real_sessions_and_l4_comparison_coverage(local):
    rows = candidates()
    rows[1]["l4_payload"] = None
    freeze(local, rows)
    labels(local)
    local[0].execute("UPDATE price_horizon_labels_v1 SET entry_date='2026-09-09'")
    with pytest.raises(RuntimeError, match="horizon_session_mismatch"):
        mature(local)
    local[0].execute("UPDATE price_horizon_labels_v1 SET entry_date='2026-09-08'")
    mature(local)
    packet = json.loads(local[1]("SELECT metrics_json FROM ipo_shadow_daily_evaluations_v1", [])[0]["metrics_json"])
    assert packet["l4"] is None and packet["proxy_return_delta"] is None
    assert packet["paired"] is False


def test_ipo_coefficients_match_sealed_research_without_refitting():
    path = ROOT / "audits/outbox/2026-09-05-l4-frozen-verification/phase8/models.json"
    if not path.exists():
        pytest.skip("Sealed local research artifact not checked out in CI")
    assert hashlib.sha256(path.read_bytes()).hexdigest() == ipo.MODEL["research_source_sha256"]
    model = json.loads(path.read_text())["models"]["ipo"]
    assert ipo.MODEL["theta"] == model["theta"]
    assert ipo.MODEL["mean"] == model["preprocessing"]["mean"]
    assert ipo.MODEL["scale"] == model["preprocessing"]["scale"]
    for values in [[0., 0., 0., 0.], [1., 1., 1., 1.], [.5, .3, .7, .2]]:
        expected = np.clip(model["theta"][0] + ((np.array(values) - model["preprocessing"]["mean"])
                           / model["preprocessing"]["scale"]) @ model["theta"][1:], -.08, .08)
        assert ipo.predict(values) == pytest.approx(expected)


def test_proxy_is_long_only_cash_cap_and_not_topk():
    scores = np.array([.03] * 50)
    weights = ipo.proxy_weights(scores)
    assert (weights > 0).sum() == 50
    assert weights.sum() == pytest.approx(1)
    assert ipo.proxy_weights(np.array([-.01, -.05])).sum() == 0


def test_delayed_evening_freeze_is_allowed_before_open_but_not_after(local, monkeypatch):
    class Clock(datetime):
        hour = 0  # 08:00 Taipei on the next day.
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 8, cls.hour, tzinfo=timezone.utc)
    monkeypatch.setattr(ipo, "datetime", Clock)
    assert freeze(local)["status"] == "frozen"
    Clock.hour = 2  # 10:00 Taipei; never create retrospective forward credit.
    assert freeze(local)["status"] == "historical_not_prospective"
    assert local[1]("SELECT COUNT(*) n FROM ipo_shadow_batches_v1", [])[0]["n"] == 1
