"""HMM-only clock policy. Inference and model maintenance use exact durations."""
from datetime import datetime, timedelta, timezone

MAX_MODEL_AGE = timedelta(days=9)
REFRESH_AFTER = timedelta(days=7)


def timestamp(value):
    parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('HMM_CLOCK_UNZONED')
    return parsed.astimezone(timezone.utc)


def model_fresh(metadata, *, as_of=None):
    try:
        now = as_of or datetime.now(timezone.utc)
        age = now - timestamp(metadata['trained_at'])
        return timedelta(0) <= age <= MAX_MODEL_AGE
    except (ValueError, TypeError, KeyError, OverflowError):
        return False


def refresh_due(metadata, *, now, required_until):
    if required_until < now:
        raise ValueError('HMM_DECISION_COVERAGE_IN_PAST')
    return (not model_fresh(metadata, as_of=now)
            or not model_fresh(metadata, as_of=required_until)
            or now - timestamp(metadata['trained_at']) >= REFRESH_AFTER)
