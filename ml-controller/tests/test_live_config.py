"""KV trading:live_config validation, env caps, session, fee buffer, and no hardcoded trading numbers."""

from __future__ import annotations

import ast
import copy
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services import live_config as lc  # noqa: E402

SEED = json.loads((ROOT.parent / "docs/live/trading_live_config_v1.seed.json").read_text())
TW = ZoneInfo("Asia/Taipei")


def test_the_seed_is_valid_and_starts_in_paper_with_pause_lines_off():
    config = lc.validate_live_config(SEED)
    assert config["mode"] == "paper"
    assert config["capital_source"] == "broker_nav_authoritative_marks"
    assert config["pause"] == {"enabled": False, "daily_loss_pct": None, "cumulative_drawdown_pct": None}


def _with(path, value):
    config = copy.deepcopy(SEED)
    target = config
    for key in path[:-1]:
        target = target[key]
    if value is KeyError:
        del target[path[-1]]
    else:
        target[path[-1]] = value
    return config


@pytest.mark.parametrize("path,value,reason", [
    (("extra",), 1, "live_config_root_keys_invalid"),
    (("mode",), KeyError, "live_config_root_keys_invalid"),
    (("schema_version",), "live-config-v0", "live_config_schema_invalid"),
    (("mode",), "Live", "live_config_mode_invalid"),
    (("capital_source",), "broker_available_cash", "live_config_capital_source_invalid"),
    (("session",), [], "live_config_session_not_object"),
    (("session", "timezone"), "UTC", "live_config_session_timezone_invalid"),
    (("session", "continuous_open"), "9:00", "live_config_session_open_invalid"),
    (("session", "continuous_close"), "24:00", "live_config_session_close_invalid"),
    (("session", "continuous_close"), "09:00", "live_config_session_window_invalid"),
    (("session", "deferred_sell_release"), "08:59", "live_config_session_window_invalid"),
    (("session", "deferred_sell_release"), "13:30", "live_config_session_window_invalid"),
    (("session", "lunch"), "12:00", "live_config_session_keys_invalid"),
    (("freshness", "max_packet_age_seconds"), 0, "live_config_freshness_max_packet_age_seconds_invalid"),
    (("freshness", "max_snapshot_age_ms"), True, "live_config_freshness_max_snapshot_age_ms_invalid"),
    (("freshness", "max_broker_truth_age_seconds"), 5.0, "live_config_freshness_max_broker_truth_age_seconds_invalid"),
    (("freshness", "max_broker_truth_age_seconds"), KeyError, "live_config_freshness_keys_invalid"),
    (("pause", "enabled"), "false", "live_config_pause_enabled_invalid"),
    (("pause", "enabled"), True, "live_config_pause_enabled_without_lines"),
    (("pause", "daily_loss_pct"), 0.03, "live_config_pause_daily_loss_pct_invalid"),
    (("pause", "daily_loss_pct"), 0, "live_config_pause_daily_loss_pct_invalid"),
    (("pause", "cumulative_drawdown_pct"), -1, "live_config_pause_cumulative_drawdown_pct_invalid"),
    (("pause", "cumulative_drawdown_pct"), float("nan"), "live_config_pause_cumulative_drawdown_pct_invalid"),
])
def test_every_malformed_field_is_rejected_without_defaults(path, value, reason):
    with pytest.raises(lc.LiveConfigInvalid, match=f"^{reason}$"):
        lc.validate_live_config(_with(path, value))


def test_pause_lines_need_both_values_to_enable():
    config = _with(("pause",), {"enabled": True, "daily_loss_pct": -0.03, "cumulative_drawdown_pct": None})
    with pytest.raises(lc.LiveConfigInvalid, match="live_config_pause_enabled_without_lines"):
        lc.validate_live_config(config)
    config["pause"]["cumulative_drawdown_pct"] = -0.1
    assert lc.validate_live_config(config)["pause"]["enabled"] is True


def test_non_mapping_and_missing_configs_are_rejected():
    for value in (None, [], "x", 1):
        with pytest.raises(lc.LiveConfigInvalid):
            lc.live_limits(value, {})


@pytest.mark.parametrize("env,expected", [
    ({}, {"max_packet_age_seconds": 5, "max_snapshot_age_ms": 500, "max_broker_truth_age_seconds": 5}),
    ({"LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS": "300"}, {"max_packet_age_seconds": 5, "max_snapshot_age_ms": 300,
                                                     "max_broker_truth_age_seconds": 5}),
    ({"LIVE_EXECUTION_MAX_PACKET_AGE_SECONDS": "60", "LIVE_EXECUTION_MAX_BROKER_TRUTH_AGE_SECONDS": " 3 "},
     {"max_packet_age_seconds": 5, "max_snapshot_age_ms": 500, "max_broker_truth_age_seconds": 3}),
])
def test_env_values_only_tighten_the_kv_freshness(env, expected):
    assert lc.live_limits(SEED, env)[1] == expected


@pytest.mark.parametrize("raw", ["abc", "0", "-5", "1.5"])
def test_a_set_but_unreadable_env_cap_is_an_error(raw):
    with pytest.raises(lc.LiveConfigInvalid, match="live_config_env_cap_invalid:LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS"):
        lc.live_limits(SEED, {"LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS": raw})


@pytest.mark.parametrize("when,inside", [
    (datetime(2026, 12, 9, 8, 59, 59, tzinfo=TW), False),
    (datetime(2026, 12, 9, 9, 0, tzinfo=TW), True),
    (datetime(2026, 12, 9, 13, 30, 0, tzinfo=TW), True),
    (datetime(2026, 12, 9, 13, 30, 1, tzinfo=TW), False),  # exact to the second, for sends too
    (datetime(2026, 12, 9, 13, 30, 0, 500_000, tzinfo=TW), False),
    (datetime(2026, 12, 9, 13, 31, tzinfo=TW), False),
    (datetime(2026, 12, 12, 10, 0, tzinfo=TW), False),  # Saturday
    (datetime(2026, 12, 13, 10, 0, tzinfo=TW), False),  # Sunday
])
def test_the_continuous_session_window(when, inside):
    assert lc.in_continuous_session(lc.validate_live_config(SEED), when) is inside


@pytest.mark.parametrize("when,inside", [
    (datetime(2026, 12, 9, 13, 30, 0, tzinfo=TW), True),
    (datetime(2026, 12, 9, 13, 30, 1, tzinfo=TW), False),  # committed after the close
    (datetime(2026, 12, 9, 8, 59, 59, tzinfo=TW), False),
    (datetime(2026, 12, 12, 10, 0, tzinfo=TW), False),
])
def test_paper_placement_is_checked_to_the_second(when, inside):
    assert lc.in_continuous_session(lc.validate_live_config(SEED), when) is inside


def test_the_session_follows_the_config_values():
    config = lc.validate_live_config(_with(("session", "continuous_close"), "12:00"))
    assert lc.in_continuous_session(config, datetime(2026, 12, 9, 12, 1, tzinfo=TW)) is False


FEES = {"commission": 0.001425, "tax": 0.003, "dayTradeTax": 0.0015, "minCommission": 20}


def test_the_buy_cash_requirement_uses_trading_config_fees():
    assert lc.buy_cash_required(10, 143.0, FEES) == pytest.approx(1450)  # the NT$20 minimum dominates
    assert lc.buy_cash_required(1000, 1000.0, FEES) == pytest.approx(1_001_425)  # the rate dominates
    assert lc.buy_cash_required(1000, 1000.0, {**FEES, "commission": 0.0006}) == pytest.approx(1_000_600)
    # Board and odd legs each carry their own minimum.
    assert lc.buy_cash_required(1010, 10.0, FEES) == pytest.approx(10_100 + 20 + 20)


def _worker_per_leg_commission(shares, price, fees):
    """Worker calcCommission (tw-equity-per-leg-floor-v1), the Paper contract."""
    total = 0
    for leg, odd in (((shares // 1000) * 1000, False), (shares % 1000, True)):
        if leg:
            minimum = min(1, fees["minCommission"]) if odd else fees["minCommission"]
            total += max(int(leg * price * fees["commission"]), minimum)
    return total


@pytest.mark.parametrize("shares", [1, 10, 999, 1000, 1001, 1999, 2000, 3209, 15_000])
@pytest.mark.parametrize("price", [1.0, 9.99, 143.0, 1000.0])
def test_the_live_cash_requirement_never_undercuts_the_paper_commission(shares, price):
    assert lc.buy_cash_required(shares, price, FEES) >= shares * price + _worker_per_leg_commission(shares, price, FEES)


@pytest.mark.parametrize("fees", [None, [], {}, {"commission": 0.001425}, {"minCommission": 20},
                                  {**FEES, "commission": None}, {**FEES, "commission": True},
                                  {**FEES, "minCommission": -1}, {**FEES, "commission": float("inf")},
                                  {**FEES, "commission": "0.001425"}])
def test_unreadable_fees_give_no_cash_requirement(fees):
    assert lc.buy_cash_required(10, 100.0, fees) is None


def test_load_live_config_returns_none_for_an_invalid_value(monkeypatch):
    from services import kv_client

    calls = []
    monkeypatch.setattr(kv_client, "get_json", lambda key, **kw: calls.append(key) or {**SEED, "mode": "x"})
    assert lc.load_live_config() is None and calls == ["trading:live_config"]
    monkeypatch.setattr(kv_client, "get_json", lambda key, **kw: copy.deepcopy(SEED))
    assert lc.load_live_config()["mode"] == "paper"


def test_load_trading_fees_reads_only_the_fee_owner(monkeypatch):
    from services import kv_client

    monkeypatch.setattr(kv_client, "get_json", lambda key, **kw: {"fees": FEES} if key == "trading:config" else None)
    assert lc.load_trading_fees() == FEES
    monkeypatch.setattr(kv_client, "get_json", lambda key, **kw: {"position": {}})
    assert lc.load_trading_fees() is None  # no Python default for a missing fee owner


# Numbers allowed on the Live order path. Anything else is a trading-decision constant
# that belongs in KV (D-5); add a value here only with the reason it is not one.
_ALLOWED = {
    "services/broker_execution_contract.py": {
        2: "clock-skew tolerance (seconds) for timestamps in the future",
        16: "idempotency key minimum length", 200: "idempotency key maximum length",
    },
    "services/finlab_live_submit_service.py": {
        2: "traceback depth in the sanitized error", 3.0: "KV read timeout (seconds)",
    },
    "services/finlab_execution_shadow_service.py": {3.0: "KV read timeout (seconds)"},
    "services/live_config.py": {
        2: "HH:MM slicing", 3: "HH:MM slicing", 3.0: "KV read timeout (seconds)", 5: "weekday() < 5 is Mon-Fri",
        1000: "TW board lot size (shares per lot)",
    },
    "services/live_intake.py": {
        1000: "TW board lot size (shares per lot)", 5.0: "D1 request timeout (seconds)",
        200: "gateway reason length kept in status_reason",
    },
    "services/execution_snapshot_revalidator.py": {
        0.1: "HTTP timeout floor", 0.75: "HTTP timeout default", 5: "order book depth kept in observations",
        200: "HTTP OK", 1000: "ms per second / source-time grace",
        3000: "Market Data Hub confirmed board-lot source age (f6ddbb65)",
        10000: "Market Data Hub confirmed odd-lot source age (f6ddbb65)",
    },
}


@pytest.mark.parametrize("path", sorted(_ALLOWED))
def test_the_live_order_path_has_no_hardcoded_trading_numbers(path):
    tree = ast.parse((ROOT / path).read_text())
    found = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float) and node.value not in (0, 1):
            found.setdefault(node.value, []).append(node.lineno)
    unexpected = {value: lines for value, lines in found.items() if value not in _ALLOWED[path]}
    assert unexpected == {}, f"{path}: move these to trading:live_config / trading:config: {unexpected}"


def test_session_close_at_is_that_days_close_to_the_second():
    from datetime import datetime
    config = lc.validate_live_config(_with(("session", "continuous_close"), "12:00"))
    moment = datetime.fromisoformat("2026-12-10T10:00:37.250000+08:00")
    assert lc.session_close_at(config, moment) == datetime.fromisoformat("2026-12-10T12:00:00+08:00")
