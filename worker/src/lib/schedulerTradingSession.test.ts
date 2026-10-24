import {
  parseTwseAdHocClosures,
  parseTwseHolidayDates,
  resolveNextTwSessionClosure,
  resolveTwTradingSession,
  shouldRunScheduledTask,
} from './schedulerPolicy'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

// Real TWSE newsList rows (2026-10-22 typhoon, 2026-07-10 typhoon).
const OCT23 = { Title: '臺灣證券交易所集中交易市場115年10月23日休市一天', Url: 'https://www.twse.com.tw/zh/about/news/news/content.html?8a8216d6a0fa351b01a1638507a10203', Date: '1151022' }
const JUL10 = { Title: '臺灣證券交易所集中交易市場115年7月10日休市一天', Url: 'https://www.twse.com.tw/zh/about/news/news/content.html?8a8216d69ef76943019f46cb86bf0111', Date: '1150709' }
const LISTING = { Title: '東擎科技股份有限公司股票自115年10月27日開始上市買賣', Url: 'u', Date: '1151022' }

function memoryKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  // Annual schedule cached as empty so only the ad-hoc feed is exercised.
  for (const year of [2026]) {
    store.set(`market:twse_holiday_schedule:v2:${year}`, JSON.stringify({ schemaVersion: 'twse-holiday-schedule-v2', dates: [], loadedAt: '', source: 'twse.openapi.holidaySchedule' }))
  }
  const kv = {
    get: async (key: string, type?: string) => {
      const value = store.get(key) ?? null
      return value !== null && type === 'json' ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
  } as unknown as KVNamespace
  return { kv, store }
}

let fetchCalls = 0
function stubNews(body: unknown, ok = true): void {
  fetchCalls = 0
  globalThis.fetch = (async (url: string) => {
    fetchCalls += 1
    assert(String(url) === 'https://openapi.twse.com.tw/v1/news/newsList', `unexpected fetch ${url}`)
    if (body instanceof Error) throw body
    return { ok, status: ok ? 200 : 503, json: async () => body } as Response
  }) as typeof fetch
}

const parsed = parseTwseAdHocClosures([
  OCT23, JUL10, LISTING,
  { Title: '115年2月16日至2月20日證券市場休市' },
  { Title: '臺灣證券交易所集中交易市場115年8月1日下午休市' },
  { Title: '臺灣證券交易所集中交易市場115年8月2日照常開市，不休市' },
])
assert(parsed.map((row) => row.date).join(',') === '2026-10-23,2026-07-10,2026-02-16,2026-02-17,2026-02-18,2026-02-19,2026-02-20',
  `closure parser must keep whole-session closures only: ${parsed.map((row) => row.date)}`)

// Parser hardening: announcement dates, foreign markets, cross-year, 「及」, reversals, issuer notices.
const hardened = parseTwseAdHocClosures([
  { Title: '115年10月22日公告：臺灣證券交易所集中交易市場10月23日（星期五）休市', Date: '1151022' },
  { Title: '美國證券市場115年11月26日休市', Date: '1151120' },
  { Title: '臺灣證券交易所集中交易市場115年12月31日至1月4日休市', Date: '1151220' },
  { Title: '臺灣證券交易所集中交易市場115年9月14日及9月15日休市', Date: '1150913' },
  // newsList is newest first: this 9/16 reopen came after the closure below.
  { Title: '臺灣證券交易所集中交易市場115年9月16日照常開市', Date: '1150915' },
  { Title: '臺灣證券交易所集中交易市場115年9月16日休市', Date: '1150915' },
  { Title: '臺灣證券交易所集中交易市場115年9月17日照常開市', Date: '1150915' },
  { Title: '臺灣證券交易所集中交易市場115年9月17日休市', Date: '1150916' },
  { Title: '甲股份有限公司股票於集中交易市場自115年9月18日停止交易', Date: '1150916' },
  { Title: '臺灣證券交易所集中交易市場115年9月21日全日停止交易', Date: '1150918' },
])
assert(hardened.map((row) => row.date).join(',') === '2026-10-23,2026-12-31,2027-01-01,2027-01-02,2027-01-03,2027-01-04,2026-09-14,2026-09-15,2026-09-17,2026-09-21',
  `hardened closure parser: ${hardened.map((row) => row.date)}`)

// Review fixes: mixed titles, clause-local half-day, date after keyword, feed order, yearless cross-year, issuers.
const dates = (rows: Parameters<typeof parseTwseAdHocClosures>[0]) => parseTwseAdHocClosures(rows).map((row) => row.date).join(',')
assert(dates([{ Title: '臺灣證券交易所集中交易市場115年10月23日休市，10月24日恢復交易', Date: '1151022' }]) === '2026-10-23',
  'a closure title that also announces the reopen day keeps the closure')
assert(dates([{ Title: '臺灣證券交易所集中交易市場115年10月23日停止交易，10月24日照常開市', Date: '1151022' }]) === '2026-10-23',
  'the reopen date after a closure clause is not a closure')
assert(dates([{ Title: '因颱風下午停止上班，臺灣證券交易所集中交易市場115年10月24日休市', Date: '1151023' }]) === '2026-10-24',
  'a half-day word outside the closure clause does not make it partial')
assert(dates([{ Title: '臺灣證券交易所集中交易市場休市一天（115年10月23日）', Date: '1151022' }]) === '2026-10-23',
  'date written after the keyword')
assert(dates([{ Title: '115年10月22日公告：臺灣證券交易所集中交易市場休市一天（10月23日）', Date: '1151022' }]) === '2026-10-23',
  'announcement date in an earlier clause is not the closure date')
const reopenFirst = [
  { Title: '臺灣證券交易所集中交易市場115年10月23日照常開市', Date: '1151022' },
  { Title: '臺灣證券交易所集中交易市場115年10月23日休市一天', Date: '1151022' },
]
assert(dates(reopenFirst) === '', 'same-day reopen listed above (newer than) the closure reverses it')
assert(dates([...reopenFirst].reverse()) === '2026-10-23', 'same-day closure newer than the reopen stands')
assert(dates([{ Title: '臺灣證券交易所集中交易市場1月2日休市', Date: '1151230' }]) === '2027-01-02',
  'a yearless January date announced in December is next year')
assert(dates([
  { Title: '甲存託憑證於集中交易市場115年10月23日停止交易', Date: '1151022' },
  { Title: '甲認購權證於集中交易市場115年10月23日停止買賣', Date: '1151022' },
  { Title: '乙控股有限公司（公司代號：1234）集中交易市場115年10月23日停止交易', Date: '1151022' },
  { Title: '集中交易市場丙（證券代號：5678）115年10月23日停止交易', Date: '1151022' },
  { Title: '集中交易市場丁自115年10月23日起停止買賣', Date: '1151022' },
]) === '', 'issuer notices and open-ended suspensions are not session closures')
assert(dates([null, { Url: 'u' }, OCT23]) === '2026-10-23', 'malformed rows are skipped')

// Real 2026 rows: weekend holidays moved onto Fri 10/09 and Mon 10/26 say 補假, not 放假.
const moved = parseTwseHolidayDates([
  { Name: '國慶日', Date: '1151009', Description: '國慶日為10月10日適逢星期六，於10月9日（星期五）補假。' },
  { Name: '臺灣光復暨金門古寧頭大捷紀念日', Date: '1151026', Description: '臺灣光復暨金門古寧頭大捷紀念日為10月25日適逢星期日，於10月26日（星期一）補假。' },
], 2026)
assert(moved.join(',') === '2026-10-09,2026-10-26', `annual schedule must include moved holidays: ${moved}`)

void (async () => {
  {
    const { kv, store } = memoryKv()
    stubNews([LISTING, OCT23])
    const session = await resolveTwTradingSession(kv, '2026-10-23')
    assert(!session.trading && session.reason === 'twse_adhoc_closure', 'announced typhoon closure must close the session')
    const recorded = JSON.parse(String(store.get('holiday:2026-10-23')))
    assert(recorded.source === 'twse_adhoc' && recorded.title === OCT23.Title && recorded.url === OCT23.Url,
      'closure must be written to the holiday key with its announcement and source')
    const again = await resolveTwTradingSession(kv, '2026-10-23')
    assert(!again.trading && again.adHocCheck === 'cached_closed' && fetchCalls === 1, 'recorded closure is read back without refetching')
  }

  {
    const { kv, store } = memoryKv()
    stubNews([LISTING, JUL10])
    const session = await resolveTwTradingSession(kv, '2026-10-27')
    assert(session.trading && session.adHocCheck === 'open', 'unrelated announcements keep the session open')
    assert(!store.has('holiday:2026-10-27'), 'an open session must not write a holiday key')
    const cached = await resolveTwTradingSession(kv, '2026-10-27')
    assert(cached.adHocCheck === 'cached_open' && fetchCalls === 1, 'open result is cached to bound feed calls')
  }

  for (const failure of [new Error('network down'), [], 'not-ok']) {
    const { kv, store } = memoryKv()
    stubNews(failure === 'not-ok' ? [OCT23] : failure, failure !== 'not-ok')
    const session = await resolveTwTradingSession(kv, '2026-10-23')
    assert(session.trading && session.adHocCheck === 'unavailable', 'feed failure must not block trading')
    assert(!store.has('holiday:2026-10-23') && store.get('market:twse_adhoc_closure_check:v1:2026-10-23') === 'unavailable',
      'feed failure must neither close the session nor cache an open result')
    const retry = await resolveTwTradingSession(kv, '2026-10-23')
    assert(retry.trading && retry.adHocCheck === 'unavailable' && fetchCalls === 1, 'a down feed is not refetched on every run')
  }

  {
    // A recorded ad-hoc closure is re-checked: an explicit reopen removes it, silence keeps it.
    const { kv, store } = memoryKv()
    stubNews([OCT23])
    await resolveTwTradingSession(kv, '2026-10-23')
    store.delete('market:twse_adhoc_closure_check:v1:2026-10-23')
    stubNews([LISTING])
    const aged = await resolveTwTradingSession(kv, '2026-10-23')
    assert(!aged.trading && store.has('holiday:2026-10-23'), 'an announcement aging out of the feed keeps the closure')
    store.delete('market:twse_adhoc_closure_check:v1:2026-10-23')
    stubNews(new Error('network down'))
    const down = await resolveTwTradingSession(kv, '2026-10-23', { DISCORD_WEBHOOK_URL: 'https://discord.test/hook' })
    assert(!down.trading && down.adHocCheck === 'unavailable' && !store.has('cron:alert:twse-adhoc-closure-check:2026-10-23'),
      'a recorded closure stays closed while the feed is down, without a trading-day alert')
    store.delete('market:twse_adhoc_closure_check:v1:2026-10-23')
    stubNews([{ Title: '臺灣證券交易所集中交易市場115年10月23日照常開市', Url: 'r', Date: '1151023' }, OCT23])
    const reopened = await resolveTwTradingSession(kv, '2026-10-23')
    assert(reopened.trading && !store.has('holiday:2026-10-23'), 'a later reopen notice removes the recorded closure')
  }

  {
    // Hand-set holiday keys are never re-checked or removed.
    const { kv, store } = memoryKv({ 'holiday:2026-10-23': 'TWSE公告：颱風休市' })
    stubNews([{ Title: '臺灣證券交易所集中交易市場115年10月23日照常開市', Date: '1151023' }])
    const manual = await resolveTwTradingSession(kv, '2026-10-23')
    assert(manual.reason === 'holiday_kv' && fetchCalls === 0 && store.has('holiday:2026-10-23'), 'manual holiday keys are owned by people')
  }

  {
    const { kv } = memoryKv()
    stubNews([OCT23])
    const gate = await shouldRunScheduledTask({ task: 'morning-setup', kv, nowTw: new Date('2026-10-23T07:15:00.000Z'), checkAdHocClosure: true })
    assert(!gate.shouldRun && gate.reason.includes('source=twse_adhoc_closure'), `run-start gate must skip an announced closure: ${gate.reason}`)
  }

  {
    const { kv } = memoryKv()
    stubNews(new Error('must not fetch'))
    const gate = await shouldRunScheduledTask({ task: 'morning-setup', kv, nowTw: new Date('2026-10-23T07:15:00.000Z') })
    assert(gate.shouldRun && fetchCalls === 0, 'display/next-run gates must not call the announcement feed')
  }

  {
    // Feed down: alert once per day, never block, never close.
    const { kv, store } = memoryKv()
    const posts: string[] = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url) === 'https://discord.test/hook') { posts.push(String(init?.body)); return { ok: true } as Response }
      throw new Error('network down')
    }) as typeof fetch
    const env = { DISCORD_WEBHOOK_URL: 'https://discord.test/hook' }
    const first = await shouldRunScheduledTask({ task: 'morning-setup', kv, nowTw: new Date('2026-10-27T07:15:00.000Z'), checkAdHocClosure: true, alertEnv: env })
    await resolveTwTradingSession(kv, '2026-10-27', env)
    assert(first.shouldRun && first.reason.includes('adhoc_closure_check=unavailable'), `feed down must still run: ${first.reason}`)
    assert(posts.length === 1 && posts[0].includes('2026-10-27'), `feed down must alert once per day, got ${posts.length}`)
    assert(store.has('cron:alert:twse-adhoc-closure-check:2026-10-27'), 'alert dedupe key recorded')
  }

  {
    // A throwing webhook still claims the day's alert.
    const { kv, store } = memoryKv()
    let attempts = 0
    globalThis.fetch = (async (url: string) => {
      if (String(url) === 'https://discord.test/hook') { attempts += 1; throw new Error('discord down') }
      throw new Error('network down')
    }) as typeof fetch
    const env = { DISCORD_WEBHOOK_URL: 'https://discord.test/hook' }
    await resolveTwTradingSession(kv, '2026-10-27', env)
    store.delete('market:twse_adhoc_closure_check:v1:2026-10-27')
    await resolveTwTradingSession(kv, '2026-10-27', env)
    assert(attempts === 1, `webhook failure must not re-alert every run, got ${attempts}`)
  }

  {
    // KV writes are best-effort: a failed put must not turn a closure into a crash.
    const { kv } = memoryKv()
    ;(kv as unknown as { put: () => Promise<void> }).put = async () => { throw new Error('kv write limit') }
    stubNews([OCT23])
    const closed = await resolveTwTradingSession(kv, '2026-10-23')
    assert(!closed.trading && closed.reason === 'twse_adhoc_closure', 'closure decision stands when the holiday key write fails')
    stubNews([LISTING])
    const open = await resolveTwTradingSession(kv, '2026-10-27')
    assert(open.trading && open.adHocCheck === 'open', 'open decision stands when the cache write fails')
  }

  {
    const { kv, store } = memoryKv({ 'holiday:2026-10-26': '光復節補假' })
    stubNews([OCT23])
    const next = await resolveNextTwSessionClosure(kv, '2026-10-22')
    assert(next === '2026-10-27', `evening chain must see 10/27 as the next session, got ${next}`)
    assert(store.has('holiday:2026-10-23'), 'closure for the next session is recorded before the chain runs')
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
