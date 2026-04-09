"""
test_rrg_calculator.py — Parity test for Phase 6.1 RRG port

Validates 1:1 alignment with V1 dailyRecommendation.ts:170-204 formula.
Does NOT require D1/network — pure function unit tests.
"""
from __future__ import annotations
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services._rrg_calculator import (
    compute_rs_ratio_vs_benchmark,
    classify_quadrant,
    compute_theme_return,
    build_rrg_point,
)


def approx(a: float, b: float, eps: float = 0.01) -> bool:
    return abs(a - b) < eps


def test_rs_ratio_basic():
    # theme +3%, twii +1% → (1.03/1.01)*100 = 101.9801 → round 2 decimals = 101.98
    assert approx(compute_rs_ratio_vs_benchmark(0.03, 0.01), 101.98)


def test_rs_ratio_underperform():
    # theme -1%, twii +2% → (0.99/1.02)*100 = 97.0588 → 97.06
    assert approx(compute_rs_ratio_vs_benchmark(-0.01, 0.02), 97.06)


def test_rs_ratio_twii_zero_theme_positive():
    assert compute_rs_ratio_vs_benchmark(0.05, 0.0) == 105.0


def test_rs_ratio_twii_zero_theme_negative():
    assert compute_rs_ratio_vs_benchmark(-0.05, 0.0) == 95.0


def test_rs_ratio_twii_zero_theme_zero():
    assert compute_rs_ratio_vs_benchmark(0.0, 0.0) == 100.0


def test_rs_ratio_both_negative():
    # theme -2%, twii -5% → (0.98/0.95)*100 = 103.1579 → 103.16
    assert approx(compute_rs_ratio_vs_benchmark(-0.02, -0.05), 103.16)


def test_classify_leading():
    assert classify_quadrant(105.0, 1.5) == "Leading"
    assert classify_quadrant(100.0, 0.0) == "Leading"  # boundary rs=100+mom=0


def test_classify_weakening():
    assert classify_quadrant(103.0, -0.5) == "Weakening"


def test_classify_lagging():
    assert classify_quadrant(95.0, -1.0) == "Lagging"


def test_classify_improving():
    assert classify_quadrant(98.0, 0.5) == "Improving"
    # rs<100+mom=0 also Improving (not Lagging) — matches V1: mom<0 needed for Lagging
    assert classify_quadrant(98.0, 0.0) == "Improving"


def test_classify_none_momentum_treated_as_zero():
    # V1: `mom = s.rs_momentum ?? 0`. rs=102 + mom None → treat mom=0 → Leading
    assert classify_quadrant(102.0, None) == "Leading"
    assert classify_quadrant(98.0, None) == "Improving"


def test_theme_return_below_min_members():
    assert compute_theme_return([0.01, 0.02]) is None  # < 3


def test_theme_return_at_min():
    r = compute_theme_return([0.01, 0.02, 0.03])
    assert r is not None and approx(r, 0.02)


def test_build_rrg_point_full():
    pt = build_rrg_point(
        sector="AI Server",
        member_returns=[0.05, 0.04, 0.06, 0.03],
        benchmark_return_5d=0.01,
        prev_rs_ratio=101.0,
    )
    # theme_ret = 0.045
    assert approx(pt.theme_return_5d, 0.045)
    # rs = 1.045/1.01*100 = 103.4653 → 103.47
    assert approx(pt.rs_ratio, 103.47)
    # mom = 103.47-101.00 = 2.47
    assert approx(pt.rs_momentum, 2.47)
    assert pt.quadrant == "Leading"
    assert pt.member_count == 4


def test_build_rrg_point_insufficient_members():
    pt = build_rrg_point(
        sector="NicheTheme",
        member_returns=[0.02, 0.03],
        benchmark_return_5d=0.01,
        prev_rs_ratio=100.0,
    )
    assert pt.rs_ratio is None
    assert pt.rs_momentum is None
    assert pt.quadrant is None
    assert pt.member_count == 2


def test_build_rrg_point_no_prev_rs():
    pt = build_rrg_point(
        sector="NewTheme",
        member_returns=[0.02, 0.03, 0.04],
        benchmark_return_5d=0.02,
        prev_rs_ratio=None,
    )
    # theme_ret=0.03, rs = 1.03/1.02*100 = 100.98
    assert approx(pt.rs_ratio, 100.98)
    assert pt.rs_momentum is None  # no prev → no mom
    # mom None → classify treats as 0 → rs>=100+mom=0 → Leading
    assert pt.quadrant == "Leading"


# ── V1 JS-replication fixtures ────────────────────────────────────────────────
# Manually computed from V1 formula to guarantee bit-level parity

V1_FIXTURES = [
    # (theme_ret, twii_ret, expected_rs)
    (0.03, 0.01, 101.98),   # typical outperform
    (-0.01, 0.02, 97.06),   # underperform
    (0.00, 0.01, 99.01),    # flat theme vs +1% market
    (0.10, 0.05, 104.76),   # strong outperform
    (0.05, 0.0, 105.0),     # twii=0 fallback positive
    (-0.05, 0.0, 95.0),     # twii=0 fallback negative
    (0.0, 0.0, 100.0),      # all zero
    (-0.02, -0.05, 103.16), # both negative, theme less negative → outperform
]


def test_v1_fixtures_parity():
    for theme, twii, expected in V1_FIXTURES:
        got = compute_rs_ratio_vs_benchmark(theme, twii)
        assert approx(got, expected), f"theme={theme} twii={twii}: expected {expected}, got {got}"


# ── runner ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    passed, failed = 0, 0
    tests = [fn for name, fn in list(globals().items()) if name.startswith("test_") and callable(fn)]
    for fn in tests:
        try:
            fn()
            print(f"  PASS {fn.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL {fn.__name__}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ERROR {fn.__name__}: {type(e).__name__}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed (of {len(tests)})")
    sys.exit(0 if failed == 0 else 1)
