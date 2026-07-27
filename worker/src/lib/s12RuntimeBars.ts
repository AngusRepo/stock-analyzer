import type { Bindings } from '../types'
import { writeEvidenceArtifact } from './artifactLifecycle'
import { sha256Text } from './datasetSnapshots'
import { floorRollingBarIntervalMs, type IntradayRollingBar } from './intradayTechnicalSnapshot'
import type { OhlcvRow } from './ohlcvTradePlanLevels'

interface IntradaySnapshotSample {
  startMs: number
  close: number
  totalVolume: number
}

export interface S12KbarRow {
  ts?: string | null
  time?: string | null
  datetime?: string | null
  open?: number | string | null
  high?: number | string | null
  low?: number | string | null
  close?: number | string | null
  volume?: number | string | null
}

export type S12BaseBarSource =
  | 'shioaji_kbars_usable'
  | 'canonical_minute_bar_continuity'
  | 'shioaji_kbars_unusable_fallback_event_history'
  | 'event_history_only'

export interface S12BaseBarDiagnostics {
  [key: string]: string | number | boolean | null | undefined
  raw_kbars_count: number
  parsed_kbars_count: number
  invalid_kbars_count: number
  event_bars_count: number
  base_bars_count: number
  kbars_first_tw: string | null
  kbars_last_tw: string | null
  kbars_min_interval_ms: number | null
  kbars_granularity: 'intraday' | 'daily_like' | 'single_bar' | 'empty'
  kbars_unusable_reason: string | null
  kbars_time_adjustment: string | null
  kbars_raw_first_tw: string | null
  kbars_raw_last_tw: string | null
  kbars_raw_session_count: number
  kbars_shifted_session_count: number
  kbars_normalized_session_count: number
  kbars_filtered_count: number
  kbars_filtered_outside_trade_date_count: number
  kbars_filtered_outside_session_count: number
  previous_4h_fallback_loaded: boolean
  previous_4h_reference_date: string | null
  previous_4h_reference_close: number | null
  previous_daily_context_loaded: boolean
  previous_daily_context_date: string | null
  previous_daily_raw_close: number | null
  previous_daily_context_row_count?: number
  previous_daily_context_rejected_reason?: string | null
  previous_daily_context_source?: string
  previous_session_kbars_count: number
  previous_session_kbars_date: string | null
  previous_session_kbars_first_tw: string | null
  previous_session_kbars_last_tw: string | null
  kbars_error: string | null
  kbars_provider?: string | null
  kbars_cache_hit?: boolean
  canonical_minute_bars_count?: number
  canonical_minute_bars_latest_tw?: string | null
  canonical_minute_bars_appended?: number
  canonical_minute_bar_continuity_restored?: boolean
  canonical_minute_bar_error?: string | null
  kbars_cache_business_date?: string | null
  kbars_point_in_time_reconstruction?: boolean
  kbars_research_fallback_reason?: string | null
}

export interface S12ResearchBarsOverride {
  bars: IntradayRollingBar[]
  cacheHit: boolean
  cacheBusinessDate: string | null
  error?: string | null
}

export interface S12DailyPriceDomainValidation {
  bars: IntradayRollingBar[]
  rejectedReason: string | null
}

const H1_MS = 60 * 60_000
const TW_OFFSET_MS = 8 * H1_MS
const TW_SESSION_OPEN_MINUTE = 9 * 60
const TW_SESSION_CLOSE_MINUTE = 13 * 60 + 30
const S12_RESEARCH_READY_MINUTE = 15 * 60 + 30
const S12_RESEARCH_ARTIFACT_DOMAIN = 's12_research_minute_bars'
const S12_RESEARCH_ARTIFACT_SCHEMA = 's12-research-minute-bars-v2'

export interface S12ResearchUsageStatus {
  status: 'ok' | 'exhausted'
  connections: number
  bytes: number
  limit_bytes: number
  remaining_bytes: number
}

export async function loadS12ResearchUsageStatus(env: Bindings): Promise<S12ResearchUsageStatus> {
  const researchUrl = String(env.S12_RESEARCH_KBARS_URL ?? '').replace(/\/+$/, '')
  const token = String(env.PROXY_SERVICE_TOKEN ?? '').trim()
  if (!researchUrl) throw new Error('s12_research_service_url_missing')
  if (!token) throw new Error('s12_research_service_token_missing')
  const response = await fetch(`${researchUrl}/usage`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => null) as Partial<S12ResearchUsageStatus> & { detail?: string } | null
  if (!response.ok) {
    const detail = String(payload?.detail ?? `http_${response.status}`).replace(/\s+/g, ' ').slice(0, 180)
    throw new Error(`s12_research_usage_${response.status}:${detail}`)
  }
  const limitBytes = Number(payload?.limit_bytes ?? 0)
  const remainingBytes = Number(payload?.remaining_bytes ?? 0)
  if (!Number.isFinite(limitBytes) || limitBytes <= 0 || !Number.isFinite(remainingBytes)) {
    throw new Error('s12_research_usage_invalid_payload')
  }
  return {
    status: remainingBytes > 0 ? 'ok' : 'exhausted',
    connections: Math.max(0, Number(payload?.connections ?? 0) || 0),
    bytes: Math.max(0, Number(payload?.bytes ?? 0) || 0),
    limit_bytes: limitBytes,
    remaining_bytes: remainingBytes,
  }
}

export function s12ResearchTerminalDataSourceReason(
  diagnostics: Pick<S12BaseBarDiagnostics, 'kbars_error' | 'kbars_research_fallback_reason'> | null | undefined,
): string | null {
  const reasons = [diagnostics?.kbars_error, diagnostics?.kbars_research_fallback_reason]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  return reasons.find((reason) => (
    reason.includes('shioaji_research_bandwidth_exhausted')
    || reason.includes('s12_research_service_token_missing')
    || reason.includes('s12_research_service_401')
    || reason.includes('s12_research_service_403')
  )) ?? null
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function optionalPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function enabledFlag(value: unknown, fallback = false): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  return fallback
}

function parseEventTimeMs(value: unknown): number | null {
  if (!value) return null
  const text = String(value)
  const parsed = new Date(text.includes('T') ? text : text.replace(' ', 'T')).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function parseTwKbarTimeMs(value: unknown): number | null {
  if (!value) return null
  const text = String(value).trim()
  if (/^\d{10,19}$/.test(text)) {
    const raw = Number(text)
    if (!Number.isFinite(raw)) return null
    if (text.length >= 18) return Math.floor(raw / 1_000_000)
    if (text.length >= 15) return Math.floor(raw / 1_000)
    if (text.length >= 13) return Math.floor(raw)
    return Math.floor(raw * 1000)
  }
  const direct = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? Date.parse(text) : Number.NaN
  if (Number.isFinite(direct)) return direct
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!match) {
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : null
  }
  const [, y, mo, d, h, mi, s] = match
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi), Number(s ?? 0))
}

function twTimeText(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null
  return new Date(ms + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
}

function isTwSessionTime(ms: number): boolean {
  if (!Number.isFinite(ms)) return false
  const tw = new Date(ms + TW_OFFSET_MS)
  const minute = tw.getUTCHours() * 60 + tw.getUTCMinutes()
  return minute >= TW_SESSION_OPEN_MINUTE && minute < TW_SESSION_CLOSE_MINUTE
}

function countTwSessionBars(bars: IntradayRollingBar[]): number {
  return bars.reduce((count, bar) => count + (isTwSessionTime(bar.startMs) ? 1 : 0), 0)
}

export function normalizeS12KbarSessionTimeSkew(bars: IntradayRollingBar[]): {
  bars: IntradayRollingBar[]
  adjustment: string | null
  rawSessionCount: number
  shiftedSessionCount: number
  normalizedSessionCount: number
} {
  const rawSessionCount = countTwSessionBars(bars)
  const shifted = bars.map((bar) => ({ ...bar, startMs: bar.startMs - TW_OFFSET_MS }))
  const shiftedSessionCount = countTwSessionBars(shifted)
  if (
    bars.length >= 3 &&
    shiftedSessionCount >= 3 &&
    shiftedSessionCount > rawSessionCount &&
    shiftedSessionCount >= Math.max(3, rawSessionCount * 4)
  ) {
    return {
      bars: shifted,
      adjustment: 'proxy_utc_label_to_tw_local_minus_8h',
      rawSessionCount,
      shiftedSessionCount,
      normalizedSessionCount: shiftedSessionCount,
    }
  }
  return {
    bars,
    adjustment: null,
    rawSessionCount,
    shiftedSessionCount,
    normalizedSessionCount: rawSessionCount,
  }
}

function twDateText(ms: number): string {
  return new Date(ms + TW_OFFSET_MS).toISOString().slice(0, 10)
}

function mergeMinuteBars(...sources: IntradayRollingBar[][]): IntradayRollingBar[] {
  const byStart = new Map<number, IntradayRollingBar>()
  for (const bars of sources) {
    for (const bar of bars) {
      if (!Number.isFinite(bar.startMs)) continue
      byStart.set(bar.startMs, bar)
    }
  }
  return [...byStart.values()].sort((left, right) => left.startMs - right.startMs)
}

export function mergeS12CurrentSessionBars(
  canonicalBars: IntradayRollingBar[],
  hubBars: IntradayRollingBar[],
  eventBars: IntradayRollingBar[],
): IntradayRollingBar[] {
  const completedBars = mergeMinuteBars(canonicalBars, hubBars)
  const latestCompletedMs = completedBars[completedBars.length - 1]?.startMs ?? Number.NEGATIVE_INFINITY
  return mergeMinuteBars(completedBars, eventBars.filter((bar) => bar.startMs > latestCompletedMs))
}

async function loadCanonicalIntradayMinuteBars(
  env: Pick<Bindings, 'DB'>,
  symbol: string,
  tradeDate: string,
): Promise<{ bars: IntradayRollingBar[]; error: string | null }> {
  try {
    const { results } = await env.DB.prepare(`
      SELECT minute_start, open, high, low, close, volume
        FROM intraday_minute_bars
       WHERE trade_date = ? AND symbol = ?
       ORDER BY minute_start ASC
    `).bind(tradeDate, symbol).all<{
      minute_start: string
      open: number
      high: number
      low: number
      close: number
      volume: number
    }>()
    const bars = (results ?? []).map((row) => ({
      startMs: Date.parse(row.minute_start),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Math.max(0, Number(row.volume ?? 0)),
    })).filter((bar) => (
      Number.isFinite(bar.startMs) &&
      [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)
    ))
    return { bars, error: null }
  } catch (error) {
    return { bars: [], error: error instanceof Error ? error.message : String(error) }
  }
}

async function appendCanonicalIntradayMinuteBars(
  env: Pick<Bindings, 'DB'>,
  symbol: string,
  tradeDate: string,
  bars: IntradayRollingBar[],
  latestPersistedMs: number | null,
): Promise<{ appended: number; error: string | null }> {
  const completed = bars.filter((bar) => (
    twDateText(bar.startMs) === tradeDate &&
    isTwSessionTime(bar.startMs) &&
    (latestPersistedMs == null || bar.startMs > latestPersistedMs)
  ))
  if (completed.length === 0) return { appended: 0, error: null }
  let appended = 0
  try {
    for (let offset = 0; offset < completed.length; offset += 50) {
      const chunk = completed.slice(offset, offset + 50)
      const results = await env.DB.batch(chunk.map((bar) => env.DB.prepare(`
        INSERT OR IGNORE INTO intraday_minute_bars
          (trade_date, symbol, minute_start, open, high, low, close, volume, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shioaji_streaming_tick_accumulator')
      `).bind(
        tradeDate,
        symbol,
        new Date(bar.startMs).toISOString(),
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        Math.max(0, Math.floor(Number(bar.volume ?? 0))),
      )))
      appended += results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0)
    }
    return { appended, error: null }
  } catch (error) {
    return { appended, error: error instanceof Error ? error.message : String(error) }
  }
}

export function filterS12KbarsToTradeDate(bars: IntradayRollingBar[], tradeDate: string): {
  bars: IntradayRollingBar[]
  outsideTradeDateCount: number
  outsideSessionCount: number
} {
  const tradeDateBars = bars.filter((bar) => twDateText(bar.startMs) === tradeDate)
  const filtered = tradeDateBars.filter((bar) => isTwSessionTime(bar.startMs))
  return {
    bars: filtered,
    outsideTradeDateCount: Math.max(0, bars.length - tradeDateBars.length),
    outsideSessionCount: Math.max(0, tradeDateBars.length - filtered.length),
  }
}

function selectPreviousSessionKbars(bars: IntradayRollingBar[], tradeDate: string): {
  bars: IntradayRollingBar[]
  date: string | null
} {
  const byDate = new Map<string, IntradayRollingBar[]>()
  for (const bar of bars) {
    const date = twDateText(bar.startMs)
    if (date >= tradeDate || !isTwSessionTime(bar.startMs)) continue
    const bucket = byDate.get(date) ?? []
    bucket.push(bar)
    byDate.set(date, bucket)
  }
  const latestDate = [...byDate.keys()].sort().pop() ?? null
  if (!latestDate) return { bars: [], date: null }
  return {
    bars: (byDate.get(latestDate) ?? []).sort((a, b) => a.startMs - b.startMs),
    date: latestDate,
  }
}

function parseIntradaySnapshotSample(row: { created_at?: string | null; detail_json?: string | null }): IntradaySnapshotSample | null {
  const startMs = parseEventTimeMs(row.created_at)
  if (startMs == null) return null
  try {
    const detail = row.detail_json ? JSON.parse(row.detail_json) : null
    const close = finiteNumber(detail?.latestClose)
    if (close == null || close <= 0) return null
    return {
      startMs,
      close,
      totalVolume: Math.max(0, finiteNumber(detail?.totalVolume) ?? 0),
    }
  } catch {
    return null
  }
}

function samplesToRollingBars(samples: IntradaySnapshotSample[], intervalMs: number): IntradayRollingBar[] {
  const ordered = [...samples].sort((a, b) => a.startMs - b.startMs)
  const buckets = new Map<number, { open: number; high: number; low: number; close: number; lastTotalVolume: number }>()
  for (const sample of ordered) {
    const bucketMs = Math.floor(sample.startMs / intervalMs) * intervalMs
    const bucket = buckets.get(bucketMs)
    if (!bucket) {
      buckets.set(bucketMs, {
        open: sample.close,
        high: sample.close,
        low: sample.close,
        close: sample.close,
        lastTotalVolume: sample.totalVolume,
      })
    } else {
      bucket.high = Math.max(bucket.high, sample.close)
      bucket.low = Math.min(bucket.low, sample.close)
      bucket.close = sample.close
      bucket.lastTotalVolume = Math.max(bucket.lastTotalVolume, sample.totalVolume)
    }
  }

  const bars: IntradayRollingBar[] = []
  let previousTotalVolume: number | null = null
  for (const [startMs, bucket] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const volume = previousTotalVolume == null
      ? Math.max(0, bucket.lastTotalVolume)
      : Math.max(0, bucket.lastTotalVolume - previousTotalVolume)
    bars.push({
      startMs,
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      volume,
    })
    previousTotalVolume = Math.max(previousTotalVolume ?? 0, bucket.lastTotalVolume)
  }
  return bars
}

function s12ResearchProducerRunId(tradeDate: string, symbol: string): string {
  return `shioaji-research:${tradeDate}:${symbol}`
}

function isResearchWindow(tradeDate: string, nowMs = Date.now()): boolean {
  const tw = new Date(nowMs + TW_OFFSET_MS)
  const currentDate = tw.toISOString().slice(0, 10)
  if (tradeDate < currentDate) return true
  if (tradeDate > currentDate) return false
  return tw.getUTCHours() * 60 + tw.getUTCMinutes() >= S12_RESEARCH_READY_MINUTE
}

async function loadCachedS12ResearchBars(
  env: Bindings,
  symbol: string,
  tradeDate: string,
): Promise<{ bars: IntradayRollingBar[]; artifactBusinessDate: string } | null> {
  if (!env.ARTIFACTS && !env.EVIDENCE_ARTIFACT_READER) return null
  const manifest = await env.DB.prepare(`
    SELECT r2_key, checksum, schema_version, business_date
      FROM run_artifacts
     WHERE domain = ?
       AND business_date >= ?
       AND business_date <= date(?, '+7 days')
       AND producer_run_id LIKE ?
       AND status = 'ready'
     ORDER BY business_date ASC, created_at DESC
     LIMIT 1
  `).bind(
    S12_RESEARCH_ARTIFACT_DOMAIN,
    tradeDate,
    tradeDate,
    `shioaji-research:%:${symbol}`,
  ).first<{ r2_key?: string | null; checksum?: string | null; schema_version?: string | null; business_date?: string | null }>()
  if (!manifest?.r2_key || manifest.schema_version !== S12_RESEARCH_ARTIFACT_SCHEMA) return null
  const body = env.ARTIFACTS
    ? await env.ARTIFACTS.get(manifest.r2_key).then((object: any) => object?.text() ?? null)
    : await env.EVIDENCE_ARTIFACT_READER?.read(manifest.r2_key) ?? null
  if (!body) return null
  if (await sha256Text(body) !== manifest.checksum) {
    throw new Error(`s12_research_cache_checksum_mismatch:${symbol}:${tradeDate}`)
  }
  const document = JSON.parse(body) as {
    schema_version?: string
    business_date?: string
    payload?: { symbol?: string; bars?: IntradayRollingBar[] }
  }
  if (
    document.schema_version !== S12_RESEARCH_ARTIFACT_SCHEMA ||
    document.business_date !== manifest.business_date ||
    document.payload?.symbol !== symbol ||
    !Array.isArray(document.payload?.bars)
  ) {
    throw new Error(`s12_research_cache_contract_mismatch:${symbol}:${tradeDate}`)
  }
  const bars = document.payload.bars
    .filter((bar) => (
      Number.isFinite(bar?.startMs) &&
      Number.isFinite(bar?.open) &&
      Number.isFinite(bar?.high) &&
      Number.isFinite(bar?.low) &&
      Number.isFinite(bar?.close) &&
      twDateText(bar.startMs) <= tradeDate &&
      isTwSessionTime(bar.startMs)
    ))
    .sort((left, right) => left.startMs - right.startMs)
  return bars.length && manifest.business_date
    ? { bars, artifactBusinessDate: manifest.business_date }
    : null
}

function dateDaysBefore(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(parsed)) throw new Error(`invalid_trade_date:${date}`)
  return new Date(parsed - Math.max(0, days) * 86_400_000).toISOString().slice(0, 10)
}

async function fetchS12ResearchKbars(
  env: Bindings,
  symbol: string,
  tradeDate: string,
  timeoutMs = 60_000,
): Promise<{ bars: IntradayRollingBar[]; cacheHit: boolean; cacheBusinessDate: string | null }> {
  const cached = await loadCachedS12ResearchBars(env, symbol, tradeDate)
  if (cached) return { bars: cached.bars, cacheHit: true, cacheBusinessDate: cached.artifactBusinessDate }

  const researchUrl = String(env.S12_RESEARCH_KBARS_URL ?? '').replace(/\/+$/, '')
  const token = String(env.PROXY_SERVICE_TOKEN ?? '').trim()
  if (!researchUrl) throw new Error('s12_research_service_url_missing')
  if (!token) throw new Error('s12_research_service_token_missing')
  const startDate = dateDaysBefore(tradeDate, 7)
  const url = `${researchUrl}/kbars/${encodeURIComponent(symbol)}?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(tradeDate)}&limit=5000`
  let lastError = 'unknown'
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.max(3_000, Math.min(60_000, Math.floor(timeoutMs)))),
      })
      const document = await response.json().catch(() => null) as {
        status?: string
        detail?: string
        data?: S12KbarRow[]
      } | null
      if (!response.ok) {
        const message = String(document?.detail ?? `http_${response.status}`).replace(/\s+/g, ' ').slice(0, 180)
        lastError = `s12_research_service_${response.status}:${message}`
        if (
          (response.status !== 429 && response.status < 500)
          || lastError.includes('shioaji_research_bandwidth_exhausted')
        ) throw new Error(lastError)
      } else {
        const sourceRows = Array.isArray(document?.data) ? document.data : []
        const bars = sourceRows
          .map(s12KbarRowToBar)
          .filter((bar): bar is IntradayRollingBar => bar != null)
          .filter((bar) => twDateText(bar.startMs) <= tradeDate && isTwSessionTime(bar.startMs))
          .sort((left, right) => left.startMs - right.startMs)
        if (!bars.length) throw new Error(`s12_research_service_empty:${symbol}:${tradeDate}`)
        await writeEvidenceArtifact(env, {
          domain: S12_RESEARCH_ARTIFACT_DOMAIN,
          businessDate: tradeDate,
          producerRunId: s12ResearchProducerRunId(tradeDate, symbol),
          retentionClass: 'raw_market_unreferenced',
          schemaVersion: S12_RESEARCH_ARTIFACT_SCHEMA,
          payload: {
            symbol,
            provider: 'shioaji_research_service',
            bars,
          },
          rowCount: bars.length,
          metadata: {
            symbol,
            source_service: 'shioaji-research',
            source_start_date: startDate,
            source_end_date: tradeDate,
            source_kbar_rows: sourceRows.length,
          },
        })
        return { bars, cacheHit: false, cacheBusinessDate: null }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (
        lastError.includes('url_missing') ||
        lastError.includes('token_missing') ||
        lastError.includes('service_400') ||
        lastError.includes('service_401') ||
        lastError.includes('service_403') ||
        lastError.includes('service_empty') ||
        lastError.includes('shioaji_research_bandwidth_exhausted')
      ) throw error
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
  }
  throw new Error(lastError)
}

export async function fetchS12ResearchKbarsBatch(
  env: Bindings,
  symbols: string[],
  tradeDate: string,
  timeoutMs = 120_000,
): Promise<Map<string, S12ResearchBarsOverride>> {
  const uniqueSymbols = [...new Set(
    symbols.map((symbol) => String(symbol ?? '').trim().toUpperCase()).filter(Boolean),
  )]
  if (uniqueSymbols.length > 64) throw new Error(`s12_research_batch_too_large:${uniqueSymbols.length}`)
  const out = new Map<string, S12ResearchBarsOverride>()
  const cached = await Promise.all(uniqueSymbols.map(async (symbol) => ({
    symbol,
    value: await loadCachedS12ResearchBars(env, symbol, tradeDate).catch(() => null),
  })))
  for (const item of cached) {
    if (!item.value) continue
    out.set(item.symbol, {
      bars: item.value.bars,
      cacheHit: true,
      cacheBusinessDate: item.value.artifactBusinessDate,
    })
  }
  const misses = uniqueSymbols.filter((symbol) => !out.has(symbol))
  if (!misses.length) return out
  const researchUrl = String(env.S12_RESEARCH_KBARS_URL ?? '').replace(/\/+$/, '')
  const token = String(env.PROXY_SERVICE_TOKEN ?? '').trim()
  if (!researchUrl) throw new Error('s12_research_service_url_missing')
  if (!token) throw new Error('s12_research_service_token_missing')
  const startDate = dateDaysBefore(tradeDate, 7)
  const response = await fetch(`${researchUrl}/kbars/batch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: misses, start: startDate, end: tradeDate, limit: 5000 }),
    signal: AbortSignal.timeout(Math.max(10_000, Math.min(600_000, Math.floor(timeoutMs)))),
  })
  const payload = await response.json().catch(() => null) as {
    detail?: string
    results?: Array<{ symbol?: string; status?: string; data?: S12KbarRow[]; detail?: string }>
  } | null
  if (!response.ok) {
    const detail = String(payload?.detail ?? `http_${response.status}`).replace(/\s+/g, ' ').slice(0, 180)
    throw new Error(`s12_research_service_${response.status}:${detail}`)
  }
  const bySymbol = new Map(
    (payload?.results ?? []).map((item) => [String(item.symbol ?? '').toUpperCase(), item]),
  )
  for (const symbol of misses) {
    const item = bySymbol.get(symbol)
    if (!item || item.status !== 'ok') {
      out.set(symbol, {
        bars: [], cacheHit: false, cacheBusinessDate: null,
        error: `s12_research_batch_symbol_error:${symbol}:${String(item?.detail ?? 'missing_result').slice(0, 180)}`,
      })
      continue
    }
    const sourceRows = Array.isArray(item.data) ? item.data : []
    const bars = sourceRows
      .map(s12KbarRowToBar)
      .filter((bar): bar is IntradayRollingBar => bar != null)
      .filter((bar) => twDateText(bar.startMs) <= tradeDate && isTwSessionTime(bar.startMs))
      .sort((left, right) => left.startMs - right.startMs)
    if (!bars.length) {
      out.set(symbol, {
        bars: [], cacheHit: false, cacheBusinessDate: null,
        error: `s12_research_service_empty:${symbol}:${tradeDate}`,
      })
      continue
    }
    await writeEvidenceArtifact(env, {
      domain: S12_RESEARCH_ARTIFACT_DOMAIN,
      businessDate: tradeDate,
      producerRunId: s12ResearchProducerRunId(tradeDate, symbol),
      retentionClass: 'raw_market_unreferenced',
      schemaVersion: S12_RESEARCH_ARTIFACT_SCHEMA,
      payload: { symbol, provider: 'shioaji_research_service_batch', bars },
      rowCount: bars.length,
      metadata: {
        symbol,
        source_service: 'shioaji-research',
        source_start_date: startDate,
        source_end_date: tradeDate,
        source_kbar_rows: sourceRows.length,
        transport: 'batch_v1',
      },
    })
    out.set(symbol, { bars, cacheHit: false, cacheBusinessDate: null })
  }
  return out
}

export function s12KbarRowToBar(row: S12KbarRow): IntradayRollingBar | null {
  const startMs = parseTwKbarTimeMs(row.ts ?? row.time ?? row.datetime)
  const open = finiteNumber(row.open)
  const high = finiteNumber(row.high)
  const low = finiteNumber(row.low)
  const close = finiteNumber(row.close)
  if (startMs == null || open == null || high == null || low == null || close == null) return null
  return {
    startMs,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    volume: Math.max(0, finiteNumber(row.volume) ?? 0),
  }
}

function kbarGranularity(bars: IntradayRollingBar[]): {
  minIntervalMs: number | null
  granularity: S12BaseBarDiagnostics['kbars_granularity']
  unusableReason: string | null
} {
  if (bars.length === 0) return { minIntervalMs: null, granularity: 'empty', unusableReason: 'empty_kbars' }
  if (bars.length === 1) return { minIntervalMs: null, granularity: 'single_bar', unusableReason: null }
  const ordered = [...bars].sort((a, b) => a.startMs - b.startMs)
  const intervals: number[] = []
  for (let i = 1; i < ordered.length; i += 1) {
    const diff = ordered[i].startMs - ordered[i - 1].startMs
    if (Number.isFinite(diff) && diff > 0) intervals.push(diff)
  }
  const minIntervalMs = intervals.length ? Math.min(...intervals) : null
  if (minIntervalMs != null && minIntervalMs >= 6 * 3600_000) {
    return { minIntervalMs, granularity: 'daily_like', unusableReason: 'daily_like_kbars' }
  }
  return { minIntervalMs, granularity: 'intraday', unusableReason: null }
}

async function fetchS12ShioajiKbars(
  env: Bindings,
  symbol: string,
  tradeDate: string,
  options: { researchTimeoutMs?: number; researchBarsOverride?: S12ResearchBarsOverride } = {},
): Promise<{
  bars: IntradayRollingBar[]
  previousSessionBars: IntradayRollingBar[]
  diagnostics: Pick<S12BaseBarDiagnostics,
    'raw_kbars_count' | 'parsed_kbars_count' | 'invalid_kbars_count' | 'kbars_first_tw' |
    'kbars_last_tw' | 'kbars_min_interval_ms' | 'kbars_granularity' | 'kbars_unusable_reason' |
    'kbars_time_adjustment' | 'kbars_raw_first_tw' | 'kbars_raw_last_tw' |
    'kbars_raw_session_count' | 'kbars_shifted_session_count' | 'kbars_normalized_session_count' |
    'kbars_filtered_count' | 'kbars_filtered_outside_trade_date_count' | 'kbars_filtered_outside_session_count' |
    'previous_session_kbars_count' | 'previous_session_kbars_date' |
    'previous_session_kbars_first_tw' | 'previous_session_kbars_last_tw' |
    'kbars_provider' | 'kbars_cache_hit' | 'kbars_cache_business_date' | 'kbars_point_in_time_reconstruction' |
    'kbars_research_fallback_reason'
  >
}> {
  if (!enabledFlag((env as any).S12_INTRADAY_KBARS_ENABLED, true)) {
    return {
      bars: [],
      previousSessionBars: [],
      diagnostics: {
        raw_kbars_count: 0,
        parsed_kbars_count: 0,
        invalid_kbars_count: 0,
        kbars_first_tw: null,
        kbars_last_tw: null,
        kbars_min_interval_ms: null,
        kbars_granularity: 'empty',
        kbars_unusable_reason: 'kbars_disabled',
        kbars_time_adjustment: null,
        kbars_raw_first_tw: null,
        kbars_raw_last_tw: null,
        kbars_raw_session_count: 0,
        kbars_shifted_session_count: 0,
        kbars_normalized_session_count: 0,
        kbars_filtered_count: 0,
        kbars_filtered_outside_trade_date_count: 0,
        kbars_filtered_outside_session_count: 0,
        previous_session_kbars_count: 0,
        previous_session_kbars_date: null,
        previous_session_kbars_first_tw: null,
        previous_session_kbars_last_tw: null,
      },
    }
  }
  const proxyUrl = String((env as any).SHIOAJI_PROXY_URL ?? '').replace(/\/+$/, '')
  const useResearchSource = isResearchWindow(tradeDate)
  if (!proxyUrl && !useResearchSource) {
    return {
      bars: [],
      previousSessionBars: [],
      diagnostics: {
        raw_kbars_count: 0,
        parsed_kbars_count: 0,
        invalid_kbars_count: 0,
        kbars_first_tw: null,
        kbars_last_tw: null,
        kbars_min_interval_ms: null,
        kbars_granularity: 'empty',
        kbars_unusable_reason: 'missing_proxy_url',
        kbars_time_adjustment: null,
        kbars_raw_first_tw: null,
        kbars_raw_last_tw: null,
        kbars_raw_session_count: 0,
        kbars_shifted_session_count: 0,
        kbars_normalized_session_count: 0,
        kbars_filtered_count: 0,
        kbars_filtered_outside_trade_date_count: 0,
        kbars_filtered_outside_session_count: 0,
        previous_session_kbars_count: 0,
        previous_session_kbars_date: null,
        previous_session_kbars_first_tw: null,
        previous_session_kbars_last_tw: null,
      },
    }
  }
  const limit = Math.max(200, Math.min(5000, Math.floor(optionalPositiveNumber((env as any).S12_INTRADAY_KBARS_LIMIT, 3000))))
  let rawRowCount = 0
  let rawBars: IntradayRollingBar[] = []
  let provider = 'shioaji_streaming_tick_accumulator'
  let cacheHit = false
  let cacheBusinessDate: string | null = null
  let researchFallbackReason: string | null = null
  let loadCurrentSessionProxy = !useResearchSource
  if (useResearchSource) {
    try {
      const research: S12ResearchBarsOverride = options.researchBarsOverride ?? await fetchS12ResearchKbars(
        env, symbol, tradeDate, options.researchTimeoutMs ?? 60_000,
      )
      if (research.error) throw new Error(research.error)
      if (!research.bars.length) throw new Error(`s12_research_service_empty:${symbol}:${tradeDate}`)
      rawBars = research.bars
      rawRowCount = rawBars.length
      provider = 'shioaji_research_service'
      cacheHit = research.cacheHit
      cacheBusinessDate = research.cacheBusinessDate
    } catch (error) {
      if (tradeDate !== twDateText(Date.now()) || !proxyUrl) throw error
      researchFallbackReason = error instanceof Error ? error.message : String(error)
      provider = 'shioaji_streaming_tick_accumulator_same_session_fallback'
      loadCurrentSessionProxy = true
    }
  }
  if (loadCurrentSessionProxy) {
    const url = `${proxyUrl}/kbars/${encodeURIComponent(symbol)}?start=${encodeURIComponent(tradeDate)}&end=${encodeURIComponent(tradeDate)}&limit=${limit}`
    const res = await fetch(url, {
      headers: (env as any).PROXY_SERVICE_TOKEN ? { Authorization: `Bearer ${(env as any).PROXY_SERVICE_TOKEN}` } : {},
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`s12_kbars_http_${res.status}`)
    const json = await res.json() as { data?: S12KbarRow[] }
    const rows = Array.isArray(json.data) ? json.data : []
    rawRowCount = rows.length
    rawBars = rows
      .map(s12KbarRowToBar)
      .filter((bar): bar is IntradayRollingBar => bar != null)
      .sort((a, b) => a.startMs - b.startMs)
  }
  const normalized = normalizeS12KbarSessionTimeSkew(rawBars)
  const filtered = filterS12KbarsToTradeDate(normalized.bars, tradeDate)
  const previousSession = useResearchSource
    ? { bars: [] as IntradayRollingBar[], date: null as string | null }
    : selectPreviousSessionKbars(normalized.bars, tradeDate)
  const bars = filtered.bars.sort((a, b) => a.startMs - b.startMs)
  const granularity = kbarGranularity(bars)
  return {
    bars,
    previousSessionBars: previousSession.bars,
    diagnostics: {
      raw_kbars_count: rawRowCount,
      parsed_kbars_count: rawBars.length,
      invalid_kbars_count: Math.max(0, rawRowCount - rawBars.length),
      kbars_raw_first_tw: twTimeText(rawBars[0]?.startMs),
      kbars_raw_last_tw: twTimeText(rawBars[rawBars.length - 1]?.startMs),
      kbars_first_tw: twTimeText(bars[0]?.startMs),
      kbars_last_tw: twTimeText(bars[bars.length - 1]?.startMs),
      kbars_min_interval_ms: granularity.minIntervalMs,
      kbars_granularity: granularity.granularity,
      kbars_unusable_reason: granularity.unusableReason,
      kbars_time_adjustment: normalized.adjustment,
      kbars_raw_session_count: normalized.rawSessionCount,
      kbars_shifted_session_count: normalized.shiftedSessionCount,
      kbars_normalized_session_count: normalized.normalizedSessionCount,
      kbars_filtered_count: bars.length,
      kbars_filtered_outside_trade_date_count: filtered.outsideTradeDateCount,
      kbars_filtered_outside_session_count: filtered.outsideSessionCount,
      previous_session_kbars_count: previousSession.bars.length,
      previous_session_kbars_date: previousSession.date,
      previous_session_kbars_first_tw: twTimeText(previousSession.bars[0]?.startMs),
      previous_session_kbars_last_tw: twTimeText(previousSession.bars[previousSession.bars.length - 1]?.startMs),
      kbars_provider: provider,
      kbars_cache_hit: cacheHit,
      kbars_cache_business_date: cacheBusinessDate,
      kbars_point_in_time_reconstruction: cacheBusinessDate != null && cacheBusinessDate !== tradeDate,
      kbars_research_fallback_reason: researchFallbackReason,
    },
  }
}

async function loadPreviousTradingDayContext(
  env: Bindings,
  symbol: string,
  tradeDate: string,
): Promise<{
  bars: IntradayRollingBar[]
  referenceDate: string | null
  referenceClose: number | null
  rejectedReason: string | null
}> {
  type DailyRow = {
    date: string
    open: number | string | null
    high: number | string | null
    low: number | string | null
    close: number | string | null
    raw_close?: number | string | null
    volume: number | string | null
  }
  let dailyRows: DailyRow[] = []
  try {
    const { results } = await env.DB.prepare(`
      WITH requested_stock AS (
        SELECT id, symbol
          FROM stocks
         WHERE symbol = ?
         LIMIT 1
      ),
      candidate_rows AS (
        SELECT cmd.date,
               cmd.open AS open,
               cmd.high AS high,
               cmd.low AS low,
               cmd.close AS close,
               cmd.close AS raw_close,
               cmd.volume,
               cmd.source,
               cmd.created_at,
               0 AS identifier_namespace_rank
          FROM canonical_market_daily cmd
          JOIN requested_stock ON cmd.stock_id = requested_stock.symbol
         WHERE cmd.date < ?
           AND cmd.open IS NOT NULL
           AND cmd.high IS NOT NULL
           AND cmd.low IS NOT NULL
           AND cmd.close IS NOT NULL
        UNION ALL
        SELECT cmd.date,
               cmd.open AS open,
               cmd.high AS high,
               cmd.low AS low,
               cmd.close AS close,
               cmd.close AS raw_close,
               cmd.volume,
               cmd.source,
               cmd.created_at,
               1 AS identifier_namespace_rank
          FROM canonical_market_daily cmd
          JOIN requested_stock ON cmd.stock_id = CAST(requested_stock.id AS TEXT)
         WHERE cmd.date < ?
           AND cmd.open IS NOT NULL
           AND cmd.high IS NOT NULL
           AND cmd.low IS NOT NULL
           AND cmd.close IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM stocks namespace_collision
              WHERE namespace_collision.symbol = CAST(requested_stock.id AS TEXT)
           )
      ),
      ranked AS (
        SELECT date, open, high, low, close, raw_close, volume, identifier_namespace_rank,
               ROW_NUMBER() OVER (
                 PARTITION BY date
                 ORDER BY identifier_namespace_rank,
                          CASE WHEN source LIKE 'finlab%' THEN 0 ELSE 1 END,
                          created_at DESC
               ) AS source_rank
          FROM candidate_rows
      )
      SELECT date, open, high, low, close, raw_close, volume
        FROM ranked
       WHERE source_rank = 1
       ORDER BY date DESC
       LIMIT 120
    `).bind(symbol, tradeDate, tradeDate).all<DailyRow>()
    dailyRows = results ?? []
  } catch {
    dailyRows = []
  }
  const rawReference = await env.DB.prepare(`
    SELECT sp.date, sp.close
      FROM stock_prices sp
      JOIN stocks s ON s.id = sp.stock_id
     WHERE s.symbol = ?
       AND sp.date < ?
       AND sp.close IS NOT NULL
     ORDER BY sp.date DESC
     LIMIT 1
  `).bind(symbol, tradeDate).first<{ date?: string | null; close?: number | string | null }>()
  const bars = dailyRows
    .map((row): IntradayRollingBar | null => {
      const open = finiteNumber(row.open)
      const high = finiteNumber(row.high)
      const low = finiteNumber(row.low)
      const close = finiteNumber(row.close)
      if (!row.date || open == null || high == null || low == null || close == null) return null
      return {
        startMs: Date.parse(`${row.date}T01:00:00.000Z`),
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: Math.max(0, finiteNumber(row.volume) ?? 0),
      }
    })
    .filter((bar): bar is IntradayRollingBar => bar != null)
    .sort((a, b) => a.startMs - b.startMs)
  const latestDaily = dailyRows[0]
  const referenceDate = String(rawReference?.date ?? latestDaily?.date ?? '').trim() || null
  const referenceClose = finiteNumber(rawReference?.close) ?? finiteNumber(latestDaily?.raw_close)
  const validated = validateS12DailyPriceDomain(bars, referenceDate, referenceClose)
  return {
    bars: validated.bars,
    referenceDate,
    referenceClose,
    rejectedReason: validated.rejectedReason,
  }
}

export function validateS12DailyPriceDomain(
  barsInput: IntradayRollingBar[],
  referenceDate: string | null,
  referenceClose: number | null,
): S12DailyPriceDomainValidation {
  const bars = [...barsInput].sort((a, b) => a.startMs - b.startMs)
  if (!bars.length) return { bars: [], rejectedReason: 'missing_canonical_daily_rows' }
  if (!referenceDate || referenceClose == null || !Number.isFinite(referenceClose) || referenceClose <= 0) {
    return { bars: [], rejectedReason: 'missing_independent_reference_close' }
  }

  const latest = bars[bars.length - 1]
  if (twDateText(latest.startMs) !== referenceDate) {
    return { bars: [], rejectedReason: 'latest_daily_date_reference_mismatch' }
  }
  const latestRatio = latest.close / referenceClose
  if (latestRatio < 0.8 || latestRatio > 1.2) {
    return { bars: [], rejectedReason: 'latest_daily_close_reference_mismatch' }
  }

  const contiguous: IntradayRollingBar[] = [latest]
  for (let index = bars.length - 2; index >= 0; index -= 1) {
    const current = bars[index]
    const newer = contiguous[0]
    const closeRatio = current.close / newer.close
    const ohlcInDomain = [current.open, current.high, current.low].every((value) => {
      const ratio = value / current.close
      return ratio >= 0.8 && ratio <= 1.2
    })
    if (!ohlcInDomain || closeRatio < 0.8 || closeRatio > 1.2) break
    contiguous.unshift(current)
  }
  return {
    bars: contiguous,
    rejectedReason: contiguous.length < bars.length ? 'older_daily_price_domain_boundary_trimmed' : null,
  }
}

export function rollingBarsToOhlcvRows(tradeDate: string, bars: IntradayRollingBar[]): OhlcvRow[] {
  return bars
    .filter((bar) => (
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) &&
      bar.high >= bar.low
    ))
    .map((bar) => {
      const d = new Date(bar.startMs + 8 * 3600_000)
      return {
        date: tradeDate,
        time: `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: Math.max(0, Number(bar.volume ?? 0)),
      }
    })
}

export async function loadIntradayTechnicalRollingBars(
  env: Bindings,
  symbol: string,
  tradeDate: string,
  currentPrice: number,
  currentTotalVolume: number,
  options: { intervalMs?: number; lookback?: number } = {},
): Promise<IntradayRollingBar[]> {
  const intervalMs = floorRollingBarIntervalMs(Number(options.intervalMs ?? (env as any).INTRADAY_TECHNICAL_BAR_INTERVAL_MS ?? 30_000))
  const defaultLookback = options.lookback ?? Number((env as any).INTRADAY_TECHNICAL_BAR_LOOKBACK ?? 40)
  const lookback = Math.max(6, Math.min(720, Math.floor(Number(defaultLookback))))
  const { results } = await env.DB.prepare(`
    SELECT created_at, detail_json
      FROM paper_execution_events
     WHERE trade_date = ?
       AND symbol = ?
       AND event_type = 'intraday_technical_decision'
     ORDER BY id DESC
     LIMIT ?
  `).bind(tradeDate, symbol, lookback).all<{ created_at: string | null; detail_json: string | null }>()
  const samples = (results ?? [])
    .map(parseIntradaySnapshotSample)
    .filter((sample): sample is IntradaySnapshotSample => sample != null)
  samples.push({
    startMs: Date.now(),
    close: currentPrice,
    totalVolume: Math.max(0, currentTotalVolume),
  })
  const bars = samplesToRollingBars(samples, intervalMs)
  return bars.length > 0
    ? bars.slice(-lookback)
    : [{
      startMs: Date.now(),
      open: currentPrice,
      high: currentPrice,
      low: currentPrice,
      close: currentPrice,
      volume: Math.max(0, currentTotalVolume),
    }]
}

export async function loadS12IntradayBaseBars(
  env: Bindings,
  symbol: string,
  tradeDate: string,
  currentPrice: number,
  currentTotalVolume: number,
): Promise<{
  bars: IntradayRollingBar[]
  fallback15mBars: IntradayRollingBar[]
  fallback4hBars: IntradayRollingBar[]
  fallback1hBars: IntradayRollingBar[]
  fallbackDailyBars: IntradayRollingBar[]
  source: S12BaseBarSource
  diagnostics: S12BaseBarDiagnostics
}> {
  const [eventBars, previousDaily, canonicalMinuteBars] = await Promise.all([
    loadIntradayTechnicalRollingBars(
      env,
      symbol,
      tradeDate,
      currentPrice,
      currentTotalVolume,
      {
        intervalMs: optionalPositiveNumber((env as any).S12_INTRADAY_BASE_BAR_INTERVAL_MS, 60_000),
        lookback: optionalPositiveNumber((env as any).S12_INTRADAY_BAR_LOOKBACK, 720),
      },
    ),
    loadPreviousTradingDayContext(env, symbol, tradeDate),
    loadCanonicalIntradayMinuteBars(env, symbol, tradeDate),
  ])
  let diagnostics: S12BaseBarDiagnostics = {
    raw_kbars_count: 0,
    parsed_kbars_count: 0,
    invalid_kbars_count: 0,
    event_bars_count: eventBars.length,
    base_bars_count: eventBars.length,
    kbars_first_tw: null,
    kbars_last_tw: null,
    kbars_min_interval_ms: null,
    kbars_granularity: 'empty',
    kbars_unusable_reason: 'not_loaded',
    kbars_time_adjustment: null,
    kbars_raw_first_tw: null,
    kbars_raw_last_tw: null,
    kbars_raw_session_count: 0,
    kbars_shifted_session_count: 0,
    kbars_normalized_session_count: 0,
    kbars_filtered_count: 0,
    kbars_filtered_outside_trade_date_count: 0,
    kbars_filtered_outside_session_count: 0,
    previous_4h_fallback_loaded: false,
    previous_4h_reference_date: null,
    previous_4h_reference_close: null,
    previous_daily_context_loaded: previousDaily.bars.length > 0,
    previous_daily_context_date: previousDaily.referenceDate,
    previous_daily_raw_close: previousDaily.referenceClose,
    previous_daily_context_row_count: previousDaily.bars.length,
    previous_daily_context_rejected_reason: previousDaily.rejectedReason,
    previous_daily_context_source: 'canonical_market_daily.raw_ohlcv.namespace_safe_v1',
    previous_session_kbars_count: 0,
    previous_session_kbars_date: null,
    previous_session_kbars_first_tw: null,
    previous_session_kbars_last_tw: null,
    kbars_error: null,
    canonical_minute_bars_count: canonicalMinuteBars.bars.length,
    canonical_minute_bars_latest_tw: twTimeText(canonicalMinuteBars.bars[canonicalMinuteBars.bars.length - 1]?.startMs),
    canonical_minute_bars_appended: 0,
    canonical_minute_bar_continuity_restored: false,
    canonical_minute_bar_error: canonicalMinuteBars.error,
  }
  let previousSessionBars: IntradayRollingBar[] = []
  try {
    const kbars = await fetchS12ShioajiKbars(env, symbol, tradeDate)
    previousSessionBars = kbars.previousSessionBars
    diagnostics = {
      ...diagnostics,
      ...kbars.diagnostics,
    }
    if (kbars.bars.length > 0 && diagnostics.kbars_unusable_reason == null) {
      const latestPersistedMs = canonicalMinuteBars.bars[canonicalMinuteBars.bars.length - 1]?.startMs ?? null
      const persistence = await appendCanonicalIntradayMinuteBars(env, symbol, tradeDate, kbars.bars, latestPersistedMs)
      const bars = mergeS12CurrentSessionBars(canonicalMinuteBars.bars, kbars.bars, eventBars)
      const continuityRestored = canonicalMinuteBars.bars.some((bar) => (
        kbars.bars.length === 0 || bar.startMs < kbars.bars[0].startMs
      ))
      return {
        bars,
        fallback15mBars: previousSessionBars,
        fallback4hBars: [],
        fallback1hBars: previousSessionBars,
        fallbackDailyBars: previousDaily.bars,
        source: 'shioaji_kbars_usable',
        diagnostics: {
          ...diagnostics,
          base_bars_count: bars.length,
          canonical_minute_bars_appended: persistence.appended,
          canonical_minute_bar_continuity_restored: continuityRestored,
          canonical_minute_bar_error: persistence.error ?? canonicalMinuteBars.error,
        },
      }
    }
  } catch (error) {
    diagnostics = {
      ...diagnostics,
      kbars_error: error instanceof Error ? error.message : String(error),
      kbars_unusable_reason: 'kbars_fetch_error',
    }
    console.warn(`[S12] kbars unavailable for ${symbol}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (canonicalMinuteBars.bars.length > 0) {
    const bars = mergeS12CurrentSessionBars(canonicalMinuteBars.bars, [], eventBars)
    return {
      bars,
      fallback15mBars: previousSessionBars,
      fallback4hBars: [],
      fallback1hBars: previousSessionBars,
      fallbackDailyBars: previousDaily.bars,
      source: 'canonical_minute_bar_continuity',
      diagnostics: {
        ...diagnostics,
        base_bars_count: bars.length,
        canonical_minute_bar_continuity_restored: true,
      },
    }
  }
  return {
    bars: eventBars,
    fallback15mBars: previousSessionBars,
    fallback4hBars: [],
    fallback1hBars: previousSessionBars,
    fallbackDailyBars: previousDaily.bars,
    source: diagnostics.raw_kbars_count > 0
      ? 'shioaji_kbars_unusable_fallback_event_history'
      : 'event_history_only',
    diagnostics: {
      ...diagnostics,
      base_bars_count: eventBars.length,
    },
  }
}

export async function loadS12HistoricalReplayBars(
  env: Bindings,
  symbol: string,
  tradeDate: string,
  options: { researchTimeoutMs?: number; researchBarsOverride?: S12ResearchBarsOverride } = {},
): Promise<{
  bars: IntradayRollingBar[]
  fallback15mBars: IntradayRollingBar[]
  fallback4hBars: IntradayRollingBar[]
  fallback1hBars: IntradayRollingBar[]
  fallbackDailyBars: IntradayRollingBar[]
  diagnostics: S12BaseBarDiagnostics
}> {
  const previousDaily = await loadPreviousTradingDayContext(env, symbol, tradeDate)
  let diagnostics: S12BaseBarDiagnostics = {
    raw_kbars_count: 0,
    parsed_kbars_count: 0,
    invalid_kbars_count: 0,
    event_bars_count: 0,
    base_bars_count: 0,
    kbars_first_tw: null,
    kbars_last_tw: null,
    kbars_min_interval_ms: null,
    kbars_granularity: 'empty',
    kbars_unusable_reason: 'not_loaded',
    kbars_time_adjustment: null,
    kbars_raw_first_tw: null,
    kbars_raw_last_tw: null,
    kbars_raw_session_count: 0,
    kbars_shifted_session_count: 0,
    kbars_normalized_session_count: 0,
    kbars_filtered_count: 0,
    kbars_filtered_outside_trade_date_count: 0,
    kbars_filtered_outside_session_count: 0,
    previous_4h_fallback_loaded: false,
    previous_4h_reference_date: null,
    previous_4h_reference_close: null,
    previous_daily_context_loaded: previousDaily.bars.length > 0,
    previous_daily_context_date: previousDaily.referenceDate,
    previous_daily_raw_close: previousDaily.referenceClose,
    previous_daily_context_row_count: previousDaily.bars.length,
    previous_daily_context_rejected_reason: previousDaily.rejectedReason,
    previous_daily_context_source: 'canonical_market_daily.raw_ohlcv.namespace_safe_v1',
    previous_session_kbars_count: 0,
    previous_session_kbars_date: null,
    previous_session_kbars_first_tw: null,
    previous_session_kbars_last_tw: null,
    kbars_error: null,
  }
  try {
    const kbars = await fetchS12ShioajiKbars(env, symbol, tradeDate, options)
    diagnostics = {
      ...diagnostics,
      ...kbars.diagnostics,
      base_bars_count: kbars.diagnostics.kbars_unusable_reason == null ? kbars.bars.length : 0,
    }
    return {
      bars: kbars.diagnostics.kbars_unusable_reason == null ? kbars.bars : [],
      fallback15mBars: kbars.previousSessionBars,
      fallback4hBars: [],
      fallback1hBars: kbars.previousSessionBars,
      fallbackDailyBars: previousDaily.bars,
      diagnostics,
    }
  } catch (error) {
    return {
      bars: [],
      fallback15mBars: [],
      fallback4hBars: [],
      fallback1hBars: [],
      fallbackDailyBars: previousDaily.bars,
      diagnostics: {
        ...diagnostics,
        kbars_error: error instanceof Error ? error.message : String(error),
        kbars_unusable_reason: 'kbars_fetch_error',
      },
    }
  }
}

export async function loadS12HistoricalReplayLifecycleBars(
  env: Bindings,
  symbol: string,
  entryDate: string,
  maxSessions = 5,
  maxAvailableDate = '9999-12-31',
  options: { researchTimeoutMs?: number } = {},
): Promise<{
  bars: IntradayRollingBar[]
  fallback15mBars: IntradayRollingBar[]
  fallback4hBars: IntradayRollingBar[]
  fallback1hBars: IntradayRollingBar[]
  fallbackDailyBars: IntradayRollingBar[]
  diagnostics: S12BaseBarDiagnostics
}> {
  const sessionLimit = Math.max(1, Math.min(10, Math.floor(maxSessions)))
  const { results } = await env.DB.prepare(`
    SELECT DISTINCT date(sp.date) AS session_date
      FROM stock_prices sp
      JOIN stocks st ON st.id = sp.stock_id
     WHERE st.symbol = ?
       AND date(sp.date) >= date(?)
       AND date(sp.date) <= date(?)
       AND sp.open IS NOT NULL
       AND sp.high IS NOT NULL
       AND sp.low IS NOT NULL
       AND sp.close IS NOT NULL
     ORDER BY date(sp.date) ASC
     LIMIT ?
  `).bind(symbol, entryDate, maxAvailableDate, sessionLimit).all<{ session_date?: string | null }>()
  const sessionDates = (results ?? [])
    .map((row) => String(row.session_date ?? '').slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
  if (!sessionDates.includes(entryDate)) sessionDates.unshift(entryDate)

  const requestedSessionDates = sessionDates.slice(0, sessionLimit)
  const loadedByDate = new Map<string, Awaited<ReturnType<typeof loadS12HistoricalReplayBars>>>()
  let terminalDataSourceReason: string | null = null
  // Load newest first and sequentially. A successful research artifact contains
  // the preceding seven calendar days, so older sessions can reuse R2 instead
  // of issuing five concurrent broker queries for one replay candidate.
  for (const sessionDate of [...requestedSessionDates].reverse()) {
    const loaded = await loadS12HistoricalReplayBars(env, symbol, sessionDate, options)
    loadedByDate.set(sessionDate, loaded)
    terminalDataSourceReason = terminalDataSourceReason
      ?? s12ResearchTerminalDataSourceReason(loaded.diagnostics)
    if (terminalDataSourceReason) break
  }
  const loadedSessions = requestedSessionDates
    .filter((sessionDate) => loadedByDate.has(sessionDate))
    .map((sessionDate) => ({ sessionDate, loaded: loadedByDate.get(sessionDate)! }))
  const first = loadedSessions[0]?.loaded ?? await loadS12HistoricalReplayBars(env, symbol, entryDate, options)
  const barsByStart = new Map<number, IntradayRollingBar>()
  const completeSessionDates: string[] = []
  for (const session of loadedSessions) {
    const sessionBars = session.loaded.bars.filter((bar) => twDateText(bar.startMs) === session.sessionDate)
    if (sessionBars.length > 0) completeSessionDates.push(session.sessionDate)
    for (const bar of session.loaded.bars) barsByStart.set(bar.startMs, bar)
  }
  const bars = [...barsByStart.values()].sort((left, right) => left.startMs - right.startMs)
  return {
    bars,
    fallback15mBars: first.fallback15mBars,
    fallback4hBars: first.fallback4hBars,
    fallback1hBars: first.fallback1hBars,
    fallbackDailyBars: first.fallbackDailyBars,
    diagnostics: {
      ...first.diagnostics,
      kbars_error: terminalDataSourceReason ?? first.diagnostics.kbars_error,
      base_bars_count: bars.length,
      lifecycle_requested_session_dates: requestedSessionDates.join(','),
      lifecycle_requested_session_count: requestedSessionDates.length,
      lifecycle_session_dates: completeSessionDates.join(','),
      lifecycle_session_count: completeSessionDates.length,
      lifecycle_missing_session_dates: requestedSessionDates
        .filter((sessionDate) => !completeSessionDates.includes(sessionDate))
        .join(','),
      lifecycle_horizon_sessions: sessionLimit,
      lifecycle_contract: 'next_session_entry_then_multisession_canonical_exit',
    },
  }
}
