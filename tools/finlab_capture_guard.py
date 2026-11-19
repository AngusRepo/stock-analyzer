"""Bounded failure for the nightly FinLab capture: fetch deadline, transport retry, callback error text."""
import re
import sys
import time
import traceback

# One capture runs per container at a time (max_containers=1, no concurrent inputs); the Modal
# function installs this and clears it in its finally.
_DEADLINE = None


class FinLabCaptureDeadlineExceeded(RuntimeError):
    """Not a transport error: the Worker classifier must not resend a capture that ran out of time."""


def install_deadline(seconds):
    global _DEADLINE
    _DEADLINE = (time.monotonic() + float(seconds), float(seconds))


def clear_deadline():
    global _DEADLINE
    _DEADLINE = None


def remaining_seconds():
    return None if _DEADLINE is None else _DEADLINE[0] - time.monotonic()


def check_deadline(where):
    # Called only before each lane fetch. Once every lane is fetched the run finishes validating and
    # publishing, bounded by per-request timeouts and retry attempts within Modal's timeout.
    remaining = remaining_seconds()
    if remaining is not None and remaining <= 0:
        raise FinLabCaptureDeadlineExceeded(
            f'finlab_capture_deadline_exceeded:{where}:budget={round(_DEADLINE[1])}s')


# Matched against the class names of the exception's MRO, so requests, urllib3, http.client,
# google-auth and google-api-core errors are recognised without importing those packages.
_TRANSIENT_TYPES = frozenset({
    'ConnectionError', 'Timeout', 'TimeoutError', 'ChunkedEncodingError', 'ProtocolError',
    'RemoteDisconnected', 'IncompleteRead', 'TransportError', 'RetryError', 'DeadlineExceeded',
    'InternalServerError', 'BadGateway', 'ServiceUnavailable', 'GatewayTimeout', 'TooManyRequests',
})


def is_transient_transport_error(exc):
    return isinstance(exc, Exception) and any(cls.__name__ in _TRANSIENT_TYPES for cls in type(exc).__mro__)


def retry_transient(call, *, label, attempts=4, base_delay=2.0, max_delay=30.0):
    """Run call(); retry only a transient transport error, with doubling backoff (2, 4, 8 s by default)."""
    for attempt in range(1, attempts + 1):
        try:
            return call()
        except Exception as exc:
            delay = min(base_delay * 2 ** (attempt - 1), max_delay)
            if attempt == attempts or not is_transient_transport_error(exc):
                raise
            print(f'[finlab-retry] {label} attempt={attempt}/{attempts} {type(exc).__name__}: '
                  f'{redact(str(exc))[:200]}; retry in {delay:g}s', file=sys.stderr, flush=True)
            time.sleep(delay)


# requests puts the request URL in its messages, and vendor download URLs can be signed.
_QUERY_SECRET = re.compile(r'(?i)([?&][\w.-]*(?:token|key|secret|signature|sig|session_id)=)[^&\s\'"]+')


def redact(text):
    return _QUERY_SECRET.sub(r'\1[REDACTED]', text)


# The Worker classifies the callback text: the head says whether a resend may help
# (`<ExceptionType>: <message>`), and quota or late-lane markers anywhere change that answer.
# A trace frame must never add such a marker the head does not have.
_CLASSIFIER_MARKER = re.compile(
    r'Usage exceed|quota|VIP program|5000\s*MB/day|finlab_source_not_ready|daily_composition_market_dates_missing',
    re.I)


def callback_error(exc, *, message_chars=1000, frames=4):
    """Return (head, detail): head is `<Type>: <message>` on one line; detail adds the innermost frames."""
    message = ' '.join(redact(str(exc)).split())
    head = f'{type(exc).__name__}: {message[:message_chars]}'
    rendered = [f'{frame.filename.rsplit("/", 1)[-1]}:{frame.lineno} in {frame.name}'
                for frame in traceback.extract_tb(exc.__traceback__)]
    kept = [line for line in rendered if not _CLASSIFIER_MARKER.search(line)][-frames:]
    return head, (f'{head} | trace: ' + ' <- '.join(reversed(kept))) if kept else head
