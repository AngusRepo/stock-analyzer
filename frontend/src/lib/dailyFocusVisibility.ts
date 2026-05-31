export type PublicFlowTone = 'positive' | 'negative' | 'neutral'

export type PublicDailyFlow = {
  name: string
  net: number
  stockCount: number
  quadrant: string
  rsRatio: number | null
  rsMomentum: number | null
  turnoverDelta: number | null
  tone: PublicFlowTone
}

export type PublicDailyFocusPacket = {
  date: string
  dataDate: string
  generatedAt: string | null
  isStale: boolean
  riskScore: number
  riskLevel: string
  riskSummary: string
  publicCandidateCount: number
  buyCount: number
  holdCount: number
  sellCount: number
  breadthLabel: string
  themeFlows: PublicDailyFlow[]
  positiveFlows: PublicDailyFlow[]
  negativeFlows: PublicDailyFlow[]
  dailyDigest: string
  informationBoundary: string
}

function twToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function optionalNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function arrayValue(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

function textValue(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim()
  return text || fallback
}

function riskScoreFrom(risk: any, report: any): number {
  return numberValue(
    risk?.riskScore ??
      risk?.risk_score ??
      risk?.factorPacket?.score ??
      report?.report?.market_summary?.risk_score,
    50,
  )
}

function riskLevelFrom(risk: any, report: any): string {
  return textValue(
    risk?.riskLevel ??
      risk?.risk_level ??
      risk?.factorPacket?.level ??
      report?.report?.market_summary?.risk_level,
    'unknown',
  )
}

function riskSummaryFrom(risk: any, report: any): string {
  return textValue(
    risk?.riskSummary ??
      risk?.risk_summary ??
      report?.report?.market_summary?.risk_summary,
    '尚未取得今日市場風險摘要。',
  )
}

function normalizeFlow(row: any): PublicDailyFlow {
  const net = numberValue(row?.total_net)
  const stockCount = numberValue(row?.stock_count ?? row?.count)
  return {
    name: textValue(row?.sector ?? row?.theme ?? row?.name, '未分類'),
    net,
    stockCount,
    quadrant: textValue(row?.quadrant, 'Unknown'),
    rsRatio: optionalNumber(row?.rs_ratio),
    rsMomentum: optionalNumber(row?.rs_momentum),
    turnoverDelta: optionalNumber(row?.turnover_share_delta),
    tone: net > 0 ? 'positive' : net < 0 ? 'negative' : 'neutral',
  }
}

function candidateCount(report: any, flows: PublicDailyFlow[]): number {
  const reportRows = arrayValue(report?.report?.recommendations)
  if (reportRows.length) return reportRows.length

  const mlTotal = numberValue(report?.report?.ml_overview?.total, 0)
  if (mlTotal > 0) return mlTotal

  return flows.reduce((sum, row) => sum + row.stockCount, 0)
}

function buildDigest(report: any, flows: PublicDailyFlow[], riskLevel: string): string {
  const marketSummary = report?.report?.market_summary
  const usContext = marketSummary?.us_context
  const strongest = flows[0]
  const lines = [
    `市場風險為 ${riskLevel}; 首頁僅呈現公開聚合訊號。`,
    strongest ? `今日最強公開主題是 ${strongest.name}，以資金流與相對強弱做排序。` : '',
    usContext?.sentiment ? `海外情緒: ${usContext.sentiment}` : '',
  ].filter(Boolean)
  return lines.join(' ')
}

export function buildPublicDailyFocusPacket(input: {
  risk?: any
  sectorFlow?: any
  dailyReport?: any
  nowDate?: string
}): PublicDailyFocusPacket {
  const flows = arrayValue(input.sectorFlow?.flows)
    .map(normalizeFlow)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))

  const report = input.dailyReport
  const riskScore = Math.max(0, Math.min(100, riskScoreFrom(input.risk, report)))
  const riskLevel = riskLevelFrom(input.risk, report)
  const publicCandidateCount = candidateCount(report, flows)
  const positiveFlows = flows.filter((row) => row.net > 0)
  const negativeFlows = flows.filter((row) => row.net < 0)
  const dataDate = input.sectorFlow?.stale ? input.sectorFlow?.stale_date : input.sectorFlow?.date

  return {
    date: input.nowDate ?? twToday(),
    dataDate: textValue(dataDate ?? report?.date, input.nowDate ?? twToday()),
    generatedAt: input.risk?.calculatedAt ?? input.risk?.calculated_at ?? report?.report?.created_at ?? null,
    isStale: Boolean(input.sectorFlow?.stale),
    riskScore,
    riskLevel,
    riskSummary: riskSummaryFrom(input.risk, report),
    publicCandidateCount,
    buyCount: numberValue(report?.report?.ml_overview?.buy_count),
    holdCount: numberValue(report?.report?.ml_overview?.hold_count),
    sellCount: numberValue(report?.report?.ml_overview?.sell_count),
    breadthLabel: positiveFlows.length >= negativeFlows.length ? '公開熱區偏多' : '公開熱區偏弱',
    themeFlows: flows,
    positiveFlows,
    negativeFlows,
    dailyDigest: buildDigest(report, flows, riskLevel),
    informationBoundary: 'Home 只顯示公開聚合情報；真正交易目標、價位與執行脈絡留在 Bot。',
  }
}
