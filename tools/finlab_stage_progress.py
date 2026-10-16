"""Sequential, observation-only FinLab phases. Never changes data or retry policy."""
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import sys
import time

PHASES = ('acquire', 'validate', 'publish')
_active = ContextVar('finlab_stage_progress', default=None)


class StageProgress:
    def __init__(self, run_id, run_date, attempt, emit=None):
        self.run_id, self.run_date, self.attempt = run_id, run_date, attempt
        self.emit = emit
        self.rows = []
        self.sequence = 0
        self.tick = None

    def snapshot(self):
        return {'run_id': self.run_id, 'run_date': self.run_date,
                'dispatch_attempt': self.attempt, 'sequence': self.sequence,
                'observed_at': datetime.now(timezone.utc).isoformat(),
                'phases': [dict(row) for row in self.rows]}

    def _send(self):
        self.sequence += 1
        value = self.snapshot()
        print('[finlab-stage] ' + json.dumps(value), file=sys.stderr, flush=True)
        if self.emit:
            try:
                self.emit(value)
            except Exception as exc:
                print('[finlab-stage] telemetry_unavailable=' + type(exc).__name__, file=sys.stderr, flush=True)

    def finish(self, status='completed'):
        if self.rows and self.rows[-1]['status'] == 'running':
            self.rows[-1].update(status=status, completed_at=datetime.now(timezone.utc).isoformat(),
                                 elapsed_ms=round((time.monotonic()-self.tick)*1000))
            self._send()

    def start(self, phase, previous_status='completed'):
        if phase not in PHASES or len(self.rows) != PHASES.index(phase):
            raise ValueError('finlab_phase_order_invalid')
        self.finish(previous_status)
        self.tick = time.monotonic()
        self.rows.append({'phase': phase, 'status': 'running',
                          'started_at': datetime.now(timezone.utc).isoformat()})
        self._send()


def install(progress):
    return _active.set(progress)


def reset(token):
    _active.reset(token)


def start_phase(phase, previous_status='completed'):
    progress = _active.get()
    if progress is not None:
        progress.start(phase, previous_status)
