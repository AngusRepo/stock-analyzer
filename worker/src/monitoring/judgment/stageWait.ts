// The wait of a running chain stage, read from its stored summary. ops_chain_stage_state_v1 has no waiting status
// (0027 CHECK), so the writer (opsChainStageState.ts chainStageWaitSummary) stores a stage that waits by design as
// running with a summary starting `status=waiting [wait_until=<ISO>]`. Rows written before that prefix existed name
// the post-close dispatch in English only ("... wait for the after-close dispatch at 2026-11-27 14:20 ...", Taiwan
// time; adminControlRoutes pipeline callback), so that phrase is read as well when it carries the dispatch time.

const PREFIX = /^status=waiting(?: wait_until=(\S+))?(?:\s|$)/
const DISPATCH_AT = /waits? for the after-close dispatch at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/

export type StageWait = { waiting: boolean; wait_until: string | null }

const NOT_WAITING: StageWait = { waiting: false, wait_until: null }

/** Waiting = a running row whose summary says it waits and whose wait_until (when it names one) is still ahead.
 * Past its wait_until it is no longer waiting: the dispatch should have released it, so stuck / overdue apply (stuck
 * counts from the wait_until, which stays in the result). */
export function stageWait(row: { status: string; summary: string | null }, nowMs: number): StageWait {
  if (row.status !== 'running' || !row.summary) return NOT_WAITING
  const prefix = PREFIX.exec(row.summary)
  const dispatch = prefix ? null : DISPATCH_AT.exec(row.summary)
  if (!prefix && !dispatch) return NOT_WAITING
  const untilMs = prefix?.[1] ? Date.parse(prefix[1])
    : dispatch?.[1] ? Date.parse(`${dispatch[1]}T${dispatch[2]}:00+08:00`) : Number.NaN
  if (!Number.isFinite(untilMs)) return { waiting: true, wait_until: null }
  return { waiting: untilMs > nowMs, wait_until: new Date(untilMs).toISOString() }
}
