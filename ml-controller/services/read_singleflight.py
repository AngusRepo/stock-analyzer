"""Share in-flight I/O only. No TTL, retained data or serving verdict cache."""
from concurrent.futures import Future
from copy import deepcopy
from threading import Lock, get_ident


class ReadSingleFlight:
    def __init__(self, max_inflight=64):
        self._lock = Lock()
        self._pending = {}
        self.max_inflight = max_inflight

    def read(self, key, fetch):
        with self._lock:
            existing = self._pending.get(key)
            if existing is not None:
                future, owner = existing
                if owner == get_ident():
                    raise RuntimeError("singleflight_recursive_key")
                leader = False
            elif len(self._pending) < self.max_inflight:
                future = Future()
                self._pending[key] = (future, get_ident())
                leader = True
            else:
                future = None
                leader = True
        if future is None:
            return fetch()  # Saturation keeps correctness; no unbounded queue.
        if leader:
            try:
                result = fetch()
                future.set_result(result)
            except BaseException as exc:
                future.set_exception(exc)
                raise
            finally:
                with self._lock:
                    self._pending.pop(key, None)
        # Callers never receive a mutable object shared with another request.
        return deepcopy(future.result())


UI_READS = ReadSingleFlight()
