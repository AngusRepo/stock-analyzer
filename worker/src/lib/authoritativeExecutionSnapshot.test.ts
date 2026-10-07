import { resolveAuthoritativeBuyExecutionSnapshot, resolveAuthoritativeSellExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { matchPaperOrderAgainstAuthoritativeDepth } from './paperOrderBookMatcher'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const impossible4541 = resolveAuthoritativeBuyExecutionSnapshot({
  limitPrice: 63.4,
  lotType: 'board_lot',
  nowMs: Date.parse('2026-07-13T01:04:20.000Z'),
  maxAgeMs: 1500,
  observations: [
    { source: 'shioaji_hub', lotType: 'board_lot', bid: 63.2, ask: 63.4, ageMs: 9698 },
    { source: 'finlab_l5', lotType: 'board_lot', bid: 63.4, ask: 63.5, ageMs: 200 },
  ],
})
assert(impossible4541.status === 'blocked', 'fresh best ask above limit must not fill')
assert(impossible4541.reason.startsWith('authoritative_ask_above_limit'), 'fresh selected ask must be authoritative')

const disagreement = resolveAuthoritativeBuyExecutionSnapshot({
  limitPrice: 63.4,
  lotType: 'board_lot',
  maxAgeMs: 1500,
  observations: [
    { source: 'shioaji_hub', lotType: 'board_lot', bid: 63.2, ask: 63.4, ageMs: 300 },
    { source: 'finlab_l5', lotType: 'board_lot', bid: 63.4, ask: 63.5, ageMs: 200 },
  ],
})
assert(disagreement.status === 'blocked', 'conflicting marketability must fail closed')
assert(disagreement.reason === 'buy_fill_below_fresh_best_ask', 'impossible-fill mismatch must be explicit')
assert(disagreement.hardMismatch, 'conflicting fresh sources must set hard mismatch')

const ready = resolveAuthoritativeBuyExecutionSnapshot({
  limitPrice: 63.5,
  lotType: 'board_lot',
  observations: [
    { source: 'shioaji_hub', lotType: 'board_lot', bid: 63.4, ask: 63.5, ageMs: 300 },
    { source: 'finlab_l5', lotType: 'board_lot', bid: 63.4, ask: 63.5, ageMs: 200 },
  ],
})
assert(ready.status === 'ready' && ready.ask === 63.5, 'agreeing fresh books should be executable')

const wrongLot = resolveAuthoritativeBuyExecutionSnapshot({
  limitPrice: 143,
  lotType: 'odd_lot',
  observations: [
    { source: 'shioaji_hub', lotType: 'board_lot', bid: 142.5, ask: 143, ageMs: 200 },
  ],
})
assert(wrongLot.status === 'blocked' && wrongLot.reason === 'execution_book_unavailable', 'board-lot book must not authorize odd-lot fills')

console.log('authoritativeExecutionSnapshot tests passed')

// Event170191: all strategy gates passed; the Proxy confirmation was 24ms
// ahead of the Worker clock. Transport times below are explicit test inputs.
for (const resolver of [resolveAuthoritativeBuyExecutionSnapshot, resolveAuthoritativeSellExecutionSnapshot]) {
  const nowMs = Date.parse('2026-10-07T03:00:25.130Z')
  const book = {
    source:'shioaji_hub' as const,lotType:'odd_lot' as const,bid:121.5,ask:122,
    bidPrices:[121.5,121,120.5,120,119.5],askPrices:[122,122.5,123,123.5,124],
    bidVolumes:[339,3023,2890,2749,182],askVolumes:[31,362,310,130,891],volumeUnit:'shares' as const,
    sourceTime:'2026-10-07T11:00:18.480298+08:00',receivedAt:'2026-10-07T11:00:25.154894+08:00',
    ageMs:0,sessionEpoch:1,streamHeartbeatAgeMs:633,confirmationMode:'quote_session_static_book',
    timingReceipt:{requestStartedAtMs:nowMs-80,responseReceivedAtMs:nowMs,quoteAgeMs:0,sourceAgeMs:6674},
  }
  const resolve = (observation: typeof book, at=nowMs) => resolver({
    limitPrice:resolver===resolveAuthoritativeBuyExecutionSnapshot?122:121.5,
    lotType:'odd_lot',nowMs:at,maxAgeMs:1500,observations:[observation],
  })
  const fresh = resolve(book)
  assert(fresh.status==='ready' && fresh.ageMs===80,'cross-clock confirmation must use broker age plus full transport time')
  const match=matchPaperOrderAgainstAuthoritativeDepth({snapshot:fresh,requestedShares:100,limitPrice:fresh.normalizedLimitPrice})
  assert(match.filledShares===(resolver===resolveAuthoritativeBuyExecutionSnapshot?31:100),
    'clock-domain repair must still consume only visible depth at the limit')
  assert(resolve(book,nowMs+1420).status==='ready','1500ms age boundary must remain inclusive')
  assert(resolve(book,nowMs+1421).status==='blocked','waiting after receipt must age the book beyond the unchanged limit')
  for (const observation of [
    {...book,timingReceipt:{...book.timingReceipt,quoteAgeMs:2000}},
    {...book,timingReceipt:{...book.timingReceipt,requestStartedAtMs:nowMs-1501}},
    {...book,timingReceipt:{...book.timingReceipt,responseReceivedAtMs:nowMs+1}},
    {...book,timingReceipt:{...book.timingReceipt,sourceAgeMs:NaN}},
    {...book,streamHeartbeatAgeMs:10_001},
    {...book,streamHeartbeatAgeMs:9950},
    {...book,sessionEpoch:0},
    {...book,sourceTime:'2026-10-07T11:00:26+08:00'},
    {...book,receivedAt:'2026-10-08T11:00:25+08:00'},
    {...book,receivedAt:'bad-time'},
    {...book,confirmationMode:'symbol_event',timingReceipt:{...book.timingReceipt,sourceAgeMs:10_001}},
    {...book,timingReceipt:undefined as unknown as typeof book.timingReceipt},
    {...book,source:'finlab_l5' as unknown as typeof book.source},
  ]) assert(resolve(observation).status==='blocked','invalid transport, dead stream, future broker event or stale source must fail closed')
  assert(resolve({...book,confirmationMode:'symbol_event'}).status==='ready','fresh symbol callback uses its own source-age bound')
}

for (const resolver of [resolveAuthoritativeBuyExecutionSnapshot, resolveAuthoritativeSellExecutionSnapshot]) {
  const base = { source: 'shioaji_hub' as const, lotType: 'board_lot' as const, bid: 100, ask: 100 }
  const nowMs = Date.parse('2026-09-07T01:00:10Z')
  for (const observation of [
    { ...base, ageMs: null },
    { ...base, ageMs: 0, sourceTime: '2026-09-07T01:00:11Z' },
    { ...base, ageMs: 0, sourceTime: '2026-09-07T01:00:00Z' },
    { ...base, ageMs: 0, receivedAt: 'not-a-date' },
  ]) {
    assert(resolver({ limitPrice: 100, lotType: 'board_lot', nowMs, observations: [observation] }).status === 'blocked',
      'missing, future, stale or invalid timestamp must not become a fresh quote')
  }
  assert(resolver({ limitPrice: 100, lotType: 'board_lot', nowMs,
    observations: [{ ...base, ageMs: null, sourceTime: '2026-09-07T01:00:09Z' }] }).status === 'ready',
    'a valid real source timestamp supplies age without fabricating zero')
}

for (const resolver of [resolveAuthoritativeBuyExecutionSnapshot, resolveAuthoritativeSellExecutionSnapshot]) {
  const nowMs = Date.parse('2026-10-06T03:10:15.400Z')
  const staticOdd = {
    source: 'shioaji_hub' as const, lotType: 'odd_lot' as const, bid: 100, ask: 100,
    ageMs: 200, sourceTime: new Date(nowMs - 7_700).toISOString(),
    receivedAt: new Date(nowMs - 200).toISOString(), sessionEpoch: 7,
    streamHeartbeatAgeMs: 200,
    confirmationMode: 'quote_session_static_book',
  }
  const snapshot = (observation: typeof staticOdd) => resolver({
    limitPrice: 100, lotType: 'odd_lot', nowMs, maxAgeMs: 1500, observations: [observation],
  })
  assert(snapshot(staticOdd).status === 'ready', 'same-session 7.7s odd-lot book must remain executable')
  assert(snapshot({ ...staticOdd, confirmationMode: 'symbol_event' }).status === 'ready',
    'fresh callback with 7.7s broker source time must remain executable')
  assert(snapshot({ ...staticOdd, sourceTime: new Date(nowMs - 176_000).toISOString() }).status === 'ready',
    'an unchanged same-session book remains usable while actual stream callbacks continue')
  assert(snapshot({ ...staticOdd, streamHeartbeatAgeMs: 11_000 }).status === 'blocked',
    'an inactive callback stream cannot confirm the book')
  assert(snapshot({ ...staticOdd, confirmationMode: undefined as unknown as string }).status === 'blocked',
    'static exemption requires explicit Proxy confirmation')
  assert(snapshot({ ...staticOdd, sessionEpoch: 0 }).status === 'blocked',
    'static exemption requires a valid session')
  assert(snapshot({ ...staticOdd, receivedAt: new Date(nowMs - 2_000).toISOString() }).status === 'blocked',
    'stale confirmation must remain blocked')
}

for (const resolver of [resolveAuthoritativeBuyExecutionSnapshot, resolveAuthoritativeSellExecutionSnapshot]) {
  const nowMs = Date.parse('2026-10-06T05:10:15.400Z')
  const oldSource = new Date(nowMs - 20_000).toISOString()
  const book = {
    source: 'shioaji_hub' as const, lotType: 'board_lot' as const, bid: 100, ask: 100.5,
    ageMs: 200, sourceTime: oldSource, receivedAt: new Date(nowMs - 200).toISOString(),
    sessionEpoch: 7, streamHeartbeatAgeMs: 200, confirmationMode: 'quote_session_static_book',
  }
  const resolve = (observation: typeof book) => resolver({
    limitPrice: resolver === resolveAuthoritativeBuyExecutionSnapshot ? 100.5 : 100,
    lotType: 'board_lot', nowMs, maxAgeMs: 1500, observations: [observation],
  })
  assert(resolve(book).status === 'ready', 'live callbacks may confirm an unchanged same-session stream book')
  assert(resolve({ ...book, confirmationMode: 'symbol_event' }).status === 'blocked',
    'an old event alone must not become executable')
  assert(resolve({ ...book, sessionEpoch: 0 }).status === 'blocked',
    'stream confirmation requires a valid broker session')
  assert(resolve({ ...book, receivedAt: new Date(nowMs - 2_000).toISOString() }).status === 'blocked',
    'an old stream confirmation must not authorize execution')
  assert(resolve({ ...book, streamHeartbeatAgeMs: 11_000 }).status === 'blocked',
    'a stale market callback heartbeat must not authorize execution')
}
