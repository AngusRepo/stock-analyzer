"""The predeclared full-inventory flag follows the feature contract, not TimeXer's presence."""
from app.formal_feature_contract import FEATURE131_SEMANTIC, LEGACY_SEMANTIC, predeclared_full_release
from app.alpha_model_roster import LEGACY_MODELS, R33_MODELS, TIMEXER_MODELS


def test_four_model_r33_roster_keeps_the_predeclared_full131_inventory():
    assert predeclared_full_release(FEATURE131_SEMANTIC, R33_MODELS) is True


def test_legacy_profiles_predeclare_only_for_the_timexer_ab_roster():
    assert predeclared_full_release(LEGACY_SEMANTIC, TIMEXER_MODELS) is True
    assert predeclared_full_release(LEGACY_SEMANTIC, LEGACY_MODELS) is False
