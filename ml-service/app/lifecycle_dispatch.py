"""Spawn full-fit artifact-lifecycle children up front; collect them in target order.

Only a journal-backed lifecycle dispatches early: the journal records each child's call
under the run_id, so the children of a failed run stay attributable to it (and a resume
reattaches to them). Without a journal nothing is dispatched here and every target runs
serially at its place in the lifecycle loop, exactly as before early dispatch existed;
a queued Modal call is not reliably stopped by ``cancel()``, so an unjournaled early child
could not be kept from writing an orphan artifact.

The children the orchestrator dispatches here (GNN / TabM) run concurrently with the
train groups, but the orchestrator still calls ``get`` one target at a time in the original
order. Lifecycle results, journal completion records and the terminal payload are
therefore written in the same order and with the same content as the serial loop.

A dispatch error is kept and raised at that target's collection point, so it lands in
the same per-target error slot it did when dispatch and wait were one call.
"""
from __future__ import annotations

import time


class LifecycleDispatch:
    def __init__(self, spawn, *, journal_backed: bool, clock=time.time):
        self._spawn = spawn
        self._journal_backed = journal_backed
        self._clock = clock
        # target -> [dispatched_at, handle, error, collected, dispatch_failed_at]
        self._calls: dict[str, list] = {}

    def dispatch(self, targets, build) -> None:
        """build(target) -> (model_name, function, payload) for child-backed targets, else None.

        A no-op without a journal: those targets are left to the serial loop.
        """
        if not self._journal_backed:
            return
        for raw in targets:
            target = str(raw).strip()
            if not target or target in self._calls:
                continue
            dispatched_at = self._clock()
            try:
                spec = build(target)
                if spec is None:
                    continue
                self._calls[target] = [dispatched_at, self._spawn(*spec), None, False, None]
                print(f"[Orchestrator] Artifact lifecycle dispatched target={target}")
            except Exception as exc:
                self._calls[target] = [dispatched_at, None, exc, False, self._clock()]
                print(f"[Orchestrator] Artifact lifecycle dispatch failed target={target}: {exc}")

    def dispatched(self, target: str) -> bool:
        return target in self._calls

    def collect(self, target: str):
        call = self._calls[target]
        call[3] = True
        if call[2] is not None:
            raise call[2]
        return call[1].get()

    def wall_since_dispatch_s(self, target: str) -> float:
        return round(self._clock() - self._calls[target][0], 3)

    def elapsed_s(self, target: str, result=None, error=None) -> float:
        """Per-target elapsed_s (Modal telemetry bills it as compute_sec).

        The GNN / TabM wrappers report ``container_elapsed_s`` (on success, on an error
        result and on a raised error): the container time Python can observe for the input,
        cold start included, without the orchestrator's wait for the train groups. It is a
        lower bound of the L4 bill (see modal_app._CONTAINER_STARTED_AT). A target that
        never dispatched ran only as long as its failed dispatch. Without a reported time
        (the container was killed, the error lost its attribute in transport) the wall time
        since dispatch is the fallback: exact when collection had to wait, else an upper bound.
        """
        call = self._calls[target]
        if call[2] is not None:
            return round(call[4] - call[0], 3)
        wall = self.wall_since_dispatch_s(target)
        own = (result.get("container_elapsed_s") if isinstance(result, dict)
               else getattr(error, "container_elapsed_s", None))
        if isinstance(own, (int, float)) and not isinstance(own, bool) and own >= 0:
            return round(min(float(own), wall), 3)
        return wall

    def abandon(self) -> list[str]:
        """The run failed before every target was collected; nothing uncollected is adopted.

        Returns the targets left uncollected. Only journal-backed calls can exist here (see
        ``dispatch``), and they are not cancelled: ``cancel()`` does not reliably stop a call
        that is already queued, and a cancelled recorded call would make the run_id
        unresumable. Their journal rows stay ``dispatched`` (never ``completed``), the
        lifecycle stage stays ``planned`` and no result is adopted, but a child that runs
        to the end still writes its artifact under the run's pinned candidate version; the
        journal row (call_id under this run_id) is what ties that artifact to the failed
        run. A same-run_id resume after a coordinator-side failure (crash, transient ``get``
        error) reattaches to them instead of paying again; when the failure is the tree
        child's own terminal error, the recorded tree call fails again on resume, so those
        children are spent cost for that run_id. Calling this after every target was
        collected is a no-op.
        """
        pending = sorted(target for target, call in self._calls.items() if not call[3] and call[1] is not None)
        for call in self._calls.values():
            call[3] = True
        if pending:
            print(f"[Orchestrator] Artifact lifecycle not adopted; journal-backed calls left running "
                  f"for resume: {pending}")
        return pending
