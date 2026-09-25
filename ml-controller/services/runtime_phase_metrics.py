"""Process and container memory at costly phase boundaries; no trading state."""
from contextlib import contextmanager
import logging
from pathlib import Path
import sys
import time


def memory_bytes():
    result = {}
    try:
        import resource
        result['process_peak_bytes'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024)
    except ImportError:
        pass
    for key, filename in [('container_current_bytes','memory.current'), ('container_peak_bytes','memory.peak')]:
        try:
            result[key] = int(Path('/sys/fs/cgroup', filename).read_text().strip())
        except (OSError, ValueError):
            pass
    return result


@contextmanager
def measured_phase(name):
    start = time.monotonic()
    logger = logging.getLogger('runtime_phase')
    logger.info('[RuntimePhase] begin phase=%s memory=%s', name, memory_bytes())
    try:
        yield
    finally:
        logger.info('[RuntimePhase] end phase=%s seconds=%.3f memory=%s', name, time.monotonic()-start, memory_bytes())
