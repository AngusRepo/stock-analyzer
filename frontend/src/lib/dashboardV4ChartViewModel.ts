import type { DashboardV4ChartPacket } from './api'

export type ChartLaneStatus = 'ok' | 'warn' | 'error' | 'neutral'

export type ChartEvidenceLane = {
  id:
    | 'price'
    | 'model_signals'
    | 'regime'
    | 'data_quality'
    | 'finlab_diff'
    | 'preview_blocked_reasons'
  label: string
  value: string
  status: ChartLaneStatus
  detail: string
}

export type DashboardV4ChartViewModel = {
  title: string
  subtitle: string
  candles: DashboardV4ChartPacket['series']['priceCandles']
  volume: DashboardV4ChartPacket['series']['volumeHistogram']
  modelMarkers: DashboardV4ChartPacket['series']['modelMarkers']
  sectorFlow: Array<DashboardV4ChartPacket['series']['sectorFlow'][number] & { color: string }>
  lanes: ChartEvidenceLane[]
  regimeLabel: string
  dataQualityStatus: string
  previewReasons: DashboardV4ChartPacket['previewBlockedReasons']
}

export type DashboardV4PacketSummary = {
  mainQuestion: 'price_model_regime_quality'
  hasExternalWidget: boolean
  warningCount: number
}

function byTime<T extends { time: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.time.localeCompare(b.time))
}

function packetDate(value: string): string {
  if (!value) return 'N/A'
  return value.replace('T', ' ').slice(0, 16)
}

function dataQualityOverall(packet: DashboardV4ChartPacket): string {
  const overall = (packet.dataQuality as { overall?: unknown })?.overall
  return String(overall ?? 'unknown')
}

function qualityStatus(overall: string): ChartLaneStatus {
  if (overall === 'ok') return 'ok'
  if (overall === 'warn') return 'warn'
  if (overall === 'fail' || overall === 'error') return 'error'
  return 'neutral'
}

function previewStatus(reasons: DashboardV4ChartPacket['previewBlockedReasons']): ChartLaneStatus {
  if (reasons.some((row) => ['blocked', 'error'].includes(String(row.status).toLowerCase()))) return 'error'
  if (reasons.some((row) => String(row.status).toLowerCase() === 'warning')) return 'warn'
  return reasons.length ? 'warn' : 'ok'
}

function lane(
  id: ChartEvidenceLane['id'],
  label: string,
  value: string,
  status: ChartLaneStatus,
  detail: string,
): ChartEvidenceLane {
  return { id, label, value, status, detail }
}

export function buildDashboardV4ChartViewModel(packet: DashboardV4ChartPacket): DashboardV4ChartViewModel {
  const candles = byTime(packet.series.priceCandles)
  const volume = byTime(packet.series.volumeHistogram)
  const modelMarkers = byTime(packet.series.modelMarkers)
  const sectorFlow = byTime(packet.series.sectorFlow).map((row) => ({
    ...row,
    color: row.value >= 0 ? '#ef4444' : '#10b981',
  }))
  const regimeLabel = String((packet.regimeOverlay as { label?: unknown } | null)?.label ?? 'unknown')
  const dataQualityStatus = dataQualityOverall(packet)
  const finlabDiffCount = packet.finlabDiff.rows.length
  const previewReasons = packet.previewBlockedReasons

  return {
    title: `${packet.stock.symbol} ${packet.stock.name}`.trim(),
    subtitle: `${packet.stock.market} · ${packetDate(packet.generatedAt)}`,
    candles,
    volume,
    modelMarkers,
    sectorFlow,
    lanes: [
      lane('price', 'Price', String(candles.length), candles.length ? 'ok' : 'warn', 'OHLC rows'),
      lane('model_signals', 'Signals', String(modelMarkers.length), modelMarkers.length ? 'ok' : 'neutral', 'model markers'),
      lane('regime', 'Regime', regimeLabel, regimeLabel === 'unknown' ? 'warn' : 'ok', 'market_regime_state'),
      lane('data_quality', 'Quality', dataQualityStatus, qualityStatus(dataQualityStatus), 'Worker data-quality gate'),
      lane('finlab_diff', 'FinLab', String(finlabDiffCount), finlabDiffCount ? 'warn' : 'ok', 'shadow/audit rows'),
      lane('preview_blocked_reasons', 'Preview', String(previewReasons.length), previewStatus(previewReasons), 'FinLab preview warnings'),
    ],
    regimeLabel,
    dataQualityStatus,
    previewReasons,
  }
}

export function summarizeDashboardV4Packet(packet: DashboardV4ChartPacket): DashboardV4PacketSummary {
  const qualityWarning = qualityStatus(dataQualityOverall(packet)) === 'warn' || qualityStatus(dataQualityOverall(packet)) === 'error'
    ? 1
    : 0
  return {
    mainQuestion: 'price_model_regime_quality',
    hasExternalWidget: packet.externalWidgetUrls.length > 0,
    warningCount: qualityWarning + packet.previewBlockedReasons.length,
  }
}

