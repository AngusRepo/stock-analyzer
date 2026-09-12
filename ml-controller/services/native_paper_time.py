"""One source/execution timing policy; no missing historical input backfill."""
from datetime import datetime, timedelta, timezone

TW = timezone(timedelta(hours=8))


def frame_capture_deadline(frame: dict) -> datetime:
    due = datetime.fromisoformat(frame['observed_at'].replace('Z', '+00:00'))
    if due.tzinfo is None:
        raise ValueError('native_frame_timezone_missing')
    local = due.astimezone(TW)
    minute = local.hour * 60 + local.minute
    # Morning work includes the original sequential LLM debate rounds. Its
    # deadline is preopen, not one minute after cron dispatch. Trading phases
    # retain their one-minute window; retries may only reuse sealed old reads.
    boundaries = {('settlement', 435): 530, ('morning', 435): 530,
                  ('preopen', 530): 540, ('postclose', 820): 860}
    end = boundaries.get((frame['stage'], minute))
    if end is None:
        return due + timedelta(minutes=1)
    return local.replace(hour=end // 60, minute=end % 60, second=0, microsecond=0)
