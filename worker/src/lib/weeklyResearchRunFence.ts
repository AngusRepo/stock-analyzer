const WEEKLY_BACKTEST_FENCE_PREFIX = 'weekly-backtest:'
const WEEKLY_BACKTEST_DISPATCHING_OWNER = 'weekly_backtest_dispatching'
const WEEKLY_BACKTEST_DISPATCH_FAILED_OWNER = 'weekly_backtest_dispatch_failed'
const WEEKLY_BACKTEST_RUNNING_PREFIX = 'weekly_backtest_running:'
const WEEKLY_BACKTEST_TERMINAL_PREFIX = 'weekly_backtest_terminal:'

export const WEEKLY_BACKTEST_RUN_ID_PATTERN = /^weekly-backtest-\d{4}-\d{2}-\d{2}-\d{10,16}-[a-f0-9]{8,32}$/

type WeeklyBacktestFenceRow = {
  run_date?: string | null
  run_id?: string | null
  owner?: string | null
}

export function weeklyBacktestRunFenceKey(runDate: string): string {
  return `${WEEKLY_BACKTEST_FENCE_PREFIX}${runDate}`
}

export function buildWeeklyBacktestRunId(
  runDate: string,
  nowMs = Date.now(),
  entropy = crypto.randomUUID().replaceAll('-', '').slice(0, 12),
): string {
  const runId = `weekly-backtest-${runDate}-${Math.floor(nowMs)}-${entropy.toLowerCase()}`
  if (!WEEKLY_BACKTEST_RUN_ID_PATTERN.test(runId)) {
    throw new Error('invalid weekly backtest canonical run_id components')
  }
  return runId
}

async function readWeeklyBacktestFence(
  db: D1Database,
  runDate: string,
): Promise<WeeklyBacktestFenceRow | null> {
  return db.prepare(`
    SELECT run_date, run_id, owner
      FROM scheduler_locks
     WHERE lock_key=?
     LIMIT 1
  `).bind(weeklyBacktestRunFenceKey(runDate)).first<WeeklyBacktestFenceRow>()
}

export async function reserveWeeklyBacktestDispatch(
  db: D1Database,
  input: { runDate: string; runId: string },
): Promise<{ acquired: boolean; activeRunId: string | null; owner: string | null }> {
  if (!WEEKLY_BACKTEST_RUN_ID_PATTERN.test(input.runId)) {
    throw new Error('invalid weekly backtest canonical run_id')
  }
  const now = new Date().toISOString()
  const reserved = await db.prepare(`
    INSERT INTO scheduler_locks (
      lock_key, owner, run_date, run_id, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(lock_key) DO UPDATE SET
      owner=excluded.owner,
      run_date=excluded.run_date,
      run_id=excluded.run_id,
      created_at=excluded.created_at,
      expires_at=NULL
    WHERE scheduler_locks.owner LIKE '${WEEKLY_BACKTEST_TERMINAL_PREFIX}%'
       OR scheduler_locks.owner = '${WEEKLY_BACKTEST_DISPATCH_FAILED_OWNER}'
  `).bind(
    weeklyBacktestRunFenceKey(input.runDate),
    WEEKLY_BACKTEST_DISPATCHING_OWNER,
    input.runDate,
    input.runId,
    now,
  ).run()
  if (Number(reserved.meta?.changes ?? 0) > 0) {
    return { acquired: true, activeRunId: input.runId, owner: WEEKLY_BACKTEST_DISPATCHING_OWNER }
  }
  const active = await readWeeklyBacktestFence(db, input.runDate)
  return {
    acquired: false,
    activeRunId: active?.run_id ?? null,
    owner: active?.owner ?? null,
  }
}

export async function markWeeklyBacktestDispatchRunning(
  db: D1Database,
  input: { runDate: string; runId: string; executionId: string },
): Promise<{ transitioned: boolean; owner: string | null }> {
  const owner = `${WEEKLY_BACKTEST_RUNNING_PREFIX}${input.executionId}`
  const updated = await db.prepare(`
    UPDATE scheduler_locks
       SET owner=?, expires_at=NULL
     WHERE lock_key=? AND run_date=? AND run_id=? AND owner=?
  `).bind(
    owner,
    weeklyBacktestRunFenceKey(input.runDate),
    input.runDate,
    input.runId,
    WEEKLY_BACKTEST_DISPATCHING_OWNER,
  ).run()
  if (Number(updated.meta?.changes ?? 0) > 0) return { transitioned: true, owner }
  const current = await readWeeklyBacktestFence(db, input.runDate)
  return { transitioned: false, owner: current?.run_id === input.runId ? current.owner ?? null : null }
}

export async function markWeeklyBacktestDispatchFailed(
  db: D1Database,
  input: { runDate: string; runId: string },
): Promise<boolean> {
  const updated = await db.prepare(`
    UPDATE scheduler_locks
       SET owner=?, expires_at=NULL
     WHERE lock_key=? AND run_date=? AND run_id=? AND owner=?
  `).bind(
    WEEKLY_BACKTEST_DISPATCH_FAILED_OWNER,
    weeklyBacktestRunFenceKey(input.runDate),
    input.runDate,
    input.runId,
    WEEKLY_BACKTEST_DISPATCHING_OWNER,
  ).run()
  return Number(updated.meta?.changes ?? 0) > 0
}

export async function acceptWeeklyBacktestCallback(
  db: D1Database,
  input: { runDate: string; runId: string; callbackStatus: string },
): Promise<{
  accepted: boolean
  reason: 'accepted' | 'weekly_backtest_dispatch_fence_missing' | 'stale_weekly_backtest_callback'
  activeRunId: string | null
}> {
  const current = await readWeeklyBacktestFence(db, input.runDate)
  if (!current?.run_id) {
    return { accepted: false, reason: 'weekly_backtest_dispatch_fence_missing', activeRunId: null }
  }
  if (current.run_id !== input.runId) {
    return { accepted: false, reason: 'stale_weekly_backtest_callback', activeRunId: current.run_id }
  }

  const terminalOwner = `${WEEKLY_BACKTEST_TERMINAL_PREFIX}${input.callbackStatus}`
  if (current.owner === terminalOwner) {
    return { accepted: true, reason: 'accepted', activeRunId: current.run_id }
  }
  if (
    current.owner !== WEEKLY_BACKTEST_DISPATCHING_OWNER
    && !String(current.owner ?? '').startsWith(WEEKLY_BACKTEST_RUNNING_PREFIX)
  ) {
    return { accepted: false, reason: 'stale_weekly_backtest_callback', activeRunId: current.run_id }
  }

  const updated = await db.prepare(`
    UPDATE scheduler_locks
       SET owner=?,
           expires_at=NULL
     WHERE lock_key=?
       AND run_date=?
       AND run_id=?
       AND (owner=? OR owner LIKE ?)
  `).bind(
    terminalOwner,
    weeklyBacktestRunFenceKey(input.runDate),
    input.runDate,
    input.runId,
    WEEKLY_BACKTEST_DISPATCHING_OWNER,
    `${WEEKLY_BACKTEST_RUNNING_PREFIX}%`,
  ).run()
  if (Number(updated.meta?.changes ?? 0) === 0) {
    const active = await readWeeklyBacktestFence(db, input.runDate)
    return {
      accepted: false,
      reason: active?.run_id ? 'stale_weekly_backtest_callback' : 'weekly_backtest_dispatch_fence_missing',
      activeRunId: active?.run_id ?? null,
    }
  }
  return { accepted: true, reason: 'accepted', activeRunId: current.run_id }
}
