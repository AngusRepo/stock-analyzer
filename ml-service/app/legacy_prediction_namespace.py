"""Compatibility constants for disabled pre-refactor prediction side channels."""

LEGACY_LAYER3_CANDIDATE_RANK_SCORES_KEY = "__batch_challenger_rank_scores"
LEGACY_LAYER3_CANDIDATE_MODEL_ERRORS_KEY = "__batch_challenger_model_errors"

LEGACY_DISABLED_BATCH_KEYS = {
    LEGACY_LAYER3_CANDIDATE_RANK_SCORES_KEY,
    LEGACY_LAYER3_CANDIDATE_MODEL_ERRORS_KEY,
}
