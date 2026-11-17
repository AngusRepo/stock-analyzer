import { strict as assert } from 'node:assert'
import {
  resolveEveningChainClosureDurationMs,
  resolveEveningChainRunAuthority,
} from './eveningChainRunAuthority'

type FakeDbOptions = {
  sessionPresent?: boolean
  expectedRunId?: string
  queuedAt?: string
  queuedTaipeiDate?: string
  nextSessionDate?: string
  startedAt?: string
}

function fakeDb(options: FakeDbOptions): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes('MIN(COALESCE')) {
                return { started_at: options.startedAt ?? null }
              }
              if (sql.includes('pipeline_stage_runs')) {
                if (String(values.at(-1) ?? '') !== String(options.expectedRunId ?? '')) return null
                return {
                  queued_at: options.queuedAt ?? null,
                  queued_taipei_date: options.queuedTaipeiDate ?? null,
                }
              }
              if (sql.includes('AS present')) return { present: options.sessionPresent === false ? 0 : 1 }
              if (sql.includes('canonical_market_daily')) {
                return { next_session_date: options.nextSessionDate ?? null }
              }
              throw new Error(`unexpected query: ${sql}`)
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

async function main(): Promise<void> {
const originalNow = Date.now
Date.now = () => Date.parse('2026-07-30T17:00:00.000Z')
try {
  const db = fakeDb({
    expectedRunId: 'verify-2026-07-30-canonical',
    queuedAt: '2026-07-30 15:25:36',
    queuedTaipeiDate: '2026-07-30',
    nextSessionDate: '2026-07-31',
    startedAt: '2026-07-30 13:00:00',
  })
  const env = { DB: db, KV: {} as KVNamespace }

  const allowed = await resolveEveningChainRunAuthority(env, {
    businessDate: '2026-07-30',
    canonicalRunId: 'verify-2026-07-30-canonical',
  })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.runScope, 'live_canonical')
  assert.equal(allowed.reason, 'pre_next_session_open_historical_write_window')
  assert.equal(allowed.nextSessionOpenUtc, '2026-07-31T01:00:00.000Z')

  const screenerAllowed = await resolveEveningChainRunAuthority(env, {
    businessDate: '2026-07-30',
    canonicalRunId: 'verify-2026-07-30-canonical',
    authorityStage: 'screener_v2',
  })
  assert.equal(screenerAllowed.allowed, true)
  assert.equal(screenerAllowed.runScope, 'live_canonical')

  const wrongRun = await resolveEveningChainRunAuthority(env, {
    businessDate: '2026-07-30',
    canonicalRunId: 'wrong-run',
  })
  assert.equal(wrongRun.allowed, false)
  assert.equal(wrongRun.reason, 'canonical_post_verify_stage_missing')

  const wrongDateDb = fakeDb({
    expectedRunId: 'verify-2026-07-30-canonical',
    queuedAt: '2026-07-30 16:05:00',
    queuedTaipeiDate: '2026-07-31',
    nextSessionDate: '2026-07-31',
  })
  const wrongDate = await resolveEveningChainRunAuthority(
    { DB: wrongDateDb, KV: {} as KVNamespace },
    {
      businessDate: '2026-07-30',
      canonicalRunId: 'verify-2026-07-30-canonical',
    },
  )
  assert.equal(wrongDate.allowed, true)
  assert.equal(wrongDate.reason, 'canonical_stage_cross_midnight_before_next_session_open')

  Date.now = () => Date.parse('2026-07-31T01:00:00.000Z')
  const afterOpen = await resolveEveningChainRunAuthority(
    { DB: wrongDateDb, KV: {} as KVNamespace },
    {
      businessDate: '2026-07-30',
      canonicalRunId: 'verify-2026-07-30-canonical',
    },
  )
  assert.equal(afterOpen.allowed, false)
  assert.equal(afterOpen.reason, 'next_executable_session_opened_use_snapshot_only_repair')
  Date.now = () => Date.parse('2026-07-30T17:00:00.000Z')

  const durationMs = await resolveEveningChainClosureDurationMs(db, '2026-07-30')
  assert.equal(durationMs, 4 * 60 * 60 * 1000)
  assert.equal(allowed.liveEffectsAllowed, true)
  assert.equal(allowed.liveEffectsReason, 'live_canonical')
  assert.equal(wrongRun.liveEffectsAllowed, false)

  // LIVE-AUTH-B: business date Mon 11/16, next session Tue 11/17, the one after it Wed 11/18.
  const calendarKv = (holidays: string[] = []) => ({
    async get(key: string) {
      if (key === 'market:twse_holiday_schedule:v2:2026') {
        return { schemaVersion: 'twse-holiday-schedule-v2', dates: holidays }
      }
      return null
    },
  }) as unknown as KVNamespace
  const liveEffectsAt = async (now: string, queuedAt: string, options: {
    businessDate?: string
    nextSessionDate?: string
    kv?: KVNamespace
  } = {}) => {
    Date.now = () => Date.parse(now)
    const businessDate = options.businessDate ?? '2026-11-16'
    const authority = await resolveEveningChainRunAuthority({
      DB: fakeDb({
        expectedRunId: 'verify-canonical',
        queuedAt,
        queuedTaipeiDate: new Date(Date.parse(`${queuedAt.replace(' ', 'T')}Z`) + 8 * 3600_000).toISOString().slice(0, 10),
        nextSessionDate: options.nextSessionDate ?? '2026-11-17',
      }),
      KV: options.kv ?? calendarKv(),
    }, { businessDate, canonicalRunId: 'verify-canonical' })
    assert.equal(authority.allowed, false, `allowed must never widen (${now})`)
    assert.equal(authority.runScope, 'historical_replay')
    return authority
  }
  // D+1 14:22 TW: postclose research queued 14:20.
  const postClose = await liveEffectsAt('2026-11-17T06:22:00.000Z', '2026-11-17 06:20:00')
  assert.equal(postClose.liveEffectsAllowed, true)
  assert.equal(postClose.liveEffectsReason, 'post_close_next_session_window')
  assert.equal(postClose.reason, 'next_executable_session_opened_use_snapshot_only_repair')
  // Left-closed at D+1 13:30 TW.
  assert.equal((await liveEffectsAt('2026-11-17T05:30:00.000Z', '2026-11-17 05:30:00')).liveEffectsAllowed, true)
  const beforeClose = await liveEffectsAt('2026-11-17T05:30:00.000Z', '2026-11-17 05:29:59')
  assert.equal(beforeClose.liveEffectsAllowed, false)
  assert.equal(beforeClose.liveEffectsReason, 'post_close_window_stage_queued_outside')
  // D+1 09:30 TW: the next session is trading.
  assert.equal((await liveEffectsAt('2026-11-17T01:30:00.000Z', '2026-11-17 01:25:00')).liveEffectsAllowed, false)
  // Right-open at D+2 09:00 TW: a continuation still running then is no longer live.
  assert.equal((await liveEffectsAt('2026-11-18T00:59:59.000Z', '2026-11-17 06:20:00')).liveEffectsAllowed, true)
  const nextOpen = await liveEffectsAt('2026-11-18T01:01:00.000Z', '2026-11-17 06:20:00')
  assert.equal(nextOpen.liveEffectsAllowed, false)
  assert.equal(nextOpen.liveEffectsReason, 'post_close_window_closed')
  // A replay of an older date in today's window is outside its own window.
  const oldReplay = await liveEffectsAt('2026-11-17T06:22:00.000Z', '2026-11-17 06:20:00', {
    businessDate: '2026-11-10',
    nextSessionDate: '2026-11-11',
  })
  assert.equal(oldReplay.liveEffectsAllowed, false)
  assert.equal(oldReplay.liveEffectsReason, 'post_close_window_stage_queued_outside')
  // The official calendar extends the window over a holiday (Fri 11/20 -> Mon 11/23, holiday Tue 11/24).
  const overHoliday = await liveEffectsAt('2026-11-24T03:00:00.000Z', '2026-11-23 06:20:00', {
    businessDate: '2026-11-20',
    nextSessionDate: '2026-11-23',
    kv: calendarKv(['2026-11-24']),
  })
  assert.equal(overHoliday.liveEffectsAllowed, true)
  // A missing FinLab row for the session after the next one must not stretch the window past its open
  // (D+3 00:20 TW, FinLab of D+2 failed, a resumed stage re-queued now).
  Date.now = () => Date.parse('2026-11-18T16:20:30.000Z')
  const finLabGap = await resolveEveningChainRunAuthority({
    DB: fakeDb({ expectedRunId: 'verify-canonical', queuedAt: '2026-11-18 16:20:00', queuedTaipeiDate: '2026-11-19',
      nextSessionDate: '2026-11-17', sessionPresent: false }),
    KV: calendarKv(),
  }, { businessDate: '2026-11-16', canonicalRunId: 'verify-canonical' })
  assert.equal(finLabGap.liveEffectsAllowed, false)
  // The screener_v2 authority never carries live effects.
  Date.now = () => Date.parse('2026-11-17T06:22:00.000Z')
  const screenerStage = await resolveEveningChainRunAuthority({
    DB: fakeDb({ expectedRunId: 'verify-canonical', queuedAt: '2026-11-17 06:20:00', queuedTaipeiDate: '2026-11-17',
      nextSessionDate: '2026-11-17' }),
    KV: calendarKv(),
  }, { businessDate: '2026-11-16', canonicalRunId: 'verify-canonical', authorityStage: 'screener_v2' })
  assert.equal(screenerStage.liveEffectsAllowed, false)
  // Without the official future calendar the window cannot be bounded.
  const noCalendar = await liveEffectsAt('2026-11-17T06:22:00.000Z', '2026-11-17 06:20:00', {
    kv: { async get() { return null } } as unknown as KVNamespace,
  })
  assert.equal(noCalendar.liveEffectsAllowed, false)
  assert.equal(noCalendar.liveEffectsReason, 'post_close_window_following_session_unresolved')
} finally {
  Date.now = originalNow
}

console.log('eveningChainRunAuthority tests passed')
}

void main()
