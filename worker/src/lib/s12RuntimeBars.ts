import type { Bindings } from '../types'
import { floorRollingBarIntervalMs, type IntradayRollingBar } from './intradayTechnicalSnapshot'
import type { OhlcvRow } from './ohlcvTradePlanLevels'

interface IntradaySnapshotSample {
  startMs: number
  close: number
  totalVolume: number
}

interface S12KbarRow {
  ts?: string | null
  time?: string | null
  datetime?: string | null
  open?: number | string | null
  high?: number | string | null
  low?: number | string | null
  close?: number | string | null
  volume?: number | string | null
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

function s12KbarStartDate(tradeDate: string): string {
  return new Date(new Date(`${tradeDate}T00:00:00Z`).getTime() - 7 * 86400_000).toISOString().slice(0, 10)
}

function s12KbarRowToBar(row: S12KbarRow): IntradayRollingBar | null {
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

async function fetchS12ShioajiKbars(
  env: Bindings,
  symbol: string,
  tradeDate: string,
): Promise<IntradayRollingBar[]> {
  if (!enabledFlag((env as any).S12_INTRADAY_KBARS_ENABLED, true)) return []
  const proxyUrl = String((env as any).SHIOAJI_PROXY_URL ?? '').replace(/\/+$/, '')
  if (!proxyUrl) return []
  const start = s12KbarStartDate(tradeDate)
  const limit = Math.max(200, Math.min(5000, Math.floor(optionalPositiveNumber((env as any).S12_INTRADAY_KBARS_LIMIT, 3000))))
  const url = `${proxyUrl}/kbars/${encodeURIComponent(symbol)}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(tradeDate)}&limit=${limit}`
  const res = await fetch(url, {
    headers: (env as any).PROXY_SERVICE_TOKEN ? { Authorization: `Bearer ${(env as any).PROXY_SERVICE_TOKEN}` } : {},
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`s12_kbars_http_${res.status}`)
  const json = await res.json() as { data?: S12KbarRow[] }
  return (Array.isArray(json.data) ? json.data : [])
    .map(s12KbarRowToBar)
    .filter((bar): bar is IntradayRollingBar => bar != null)
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
): Promise<{ bars: IntradayRollingBar[]; source: 'shioaji_kbars_plus_events' | 'event_history' }> {
  const eventBars = await loadIntradayTechnicalRollingBars(
    env,
    symbol,
    tradeDate,
    currentPrice,
    currentTotalVolume,
    {
      intervalMs: optionalPositiveNumber((env as any).S12_INTRADAY_BASE_BAR_INTERVAL_MS, 60_000),
      lookback: optionalPositiveNumber((env as any).S12_INTRADAY_BAR_LOOKBACK, 720),
    },
  )
  try {
    const kbarBars = await fetchS12ShioajiKbars(env, symbol, tradeDate)
    if (kbarBars.length > 0) {
      return {
        bars: [...kbarBars, ...eventBars].sort((a, b) => a.startMs - b.startMs),
        source: 'shioaji_kbars_plus_events',
      }
    }
  } catch (error) {
    console.warn(`[S12] kbars unavailable for ${symbol}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { bars: eventBars, source: 'event_history' }
}
