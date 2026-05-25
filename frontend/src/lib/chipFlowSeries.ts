import type { Time } from 'lightweight-charts'

export type NormalizedChipFlowRow = {
  date: string
  foreignNet: number
  trustNet: number
  dealerNet: number
  totalNet: number
}

export type ChipFlowHistogramPoint = {
  time: Time
  value: number
  color: string
}

export type ChipFlowSummary = {
  date: string
  foreignLots: number
  trustLots: number
  dealerLots: number
  totalLots: number
}

export type NormalizedBrokerFlowRow = {
  date: string
  netShares: number
  estimatedAmount: number
  brokerCount: number | null
  concentration: number | null
}

export type BrokerFlowSummary = {
  date: string
  windowDays: number
  netLots: number
  brokerCount: number | null
  concentration: number | null
}

function finiteNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function nullableNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function dateKey(value: unknown): string {
  return String(value ?? '').slice(0, 10)
}

export function toLots(shares: number): number {
  return Math.round(shares / 1000)
}

export function normalizeChipFlowRows(rows: unknown[]): NormalizedChipFlowRow[] {
  return rows
    .map((row: any) => {
      const date = dateKey(row?.date)
      const foreignNet = finiteNumber(row?.foreign_net ?? row?.foreignNet)
      const trustNet = finiteNumber(row?.trust_net ?? row?.trustNet)
      const dealerNet = finiteNumber(row?.dealer_net ?? row?.dealerNet)
      return {
        date,
        foreignNet,
        trustNet,
        dealerNet,
        totalNet: foreignNet + trustNet + dealerNet,
      }
    })
    .filter((row) => row.date.length === 10)
    .sort((a, b) => a.date.localeCompare(b.date))
}

export function buildChipFlowHistogram(rows: NormalizedChipFlowRow[]): ChipFlowHistogramPoint[] {
  return rows.map((row) => {
    const value = toLots(row.totalNet)
    return {
      time: row.date as Time,
      value,
      color: value >= 0 ? 'rgba(248, 113, 113, 0.58)' : 'rgba(52, 211, 153, 0.58)',
    }
  })
}

export function latestChipFlowSummary(rows: NormalizedChipFlowRow[]): ChipFlowSummary | null {
  if (!rows.length) return null
  const latest = rows[rows.length - 1]
  return {
    date: latest.date,
    foreignLots: toLots(latest.foreignNet),
    trustLots: toLots(latest.trustNet),
    dealerLots: toLots(latest.dealerNet),
    totalLots: toLots(latest.totalNet),
  }
}

export function normalizeBrokerFlowRows(rows: unknown[]): NormalizedBrokerFlowRow[] {
  return rows
    .map((row: any) => ({
      date: dateKey(row?.date),
      netShares: finiteNumber(row?.net_shares ?? row?.netShares),
      estimatedAmount: finiteNumber(row?.estimated_amount ?? row?.estimatedAmount),
      brokerCount: nullableNumber(row?.broker_count ?? row?.brokerCount),
      concentration: nullableNumber(row?.concentration),
    }))
    .filter((row) => row.date.length === 10)
    .sort((a, b) => a.date.localeCompare(b.date))
}

export function buildBrokerFlowLine(rows: NormalizedBrokerFlowRow[]): Array<{ time: Time; value: number }> {
  return rows.map((row) => ({
    time: row.date as Time,
    value: toLots(row.netShares),
  }))
}

export function brokerFlowWindowSummary(
  rows: NormalizedBrokerFlowRow[],
  windowDays = 5,
): BrokerFlowSummary | null {
  if (!rows.length) return null
  const windowRows = rows.slice(-Math.max(1, windowDays))
  const latest = windowRows[windowRows.length - 1]
  const netShares = windowRows.reduce((sum, row) => sum + row.netShares, 0)
  return {
    date: latest.date,
    windowDays: windowRows.length,
    netLots: toLots(netShares),
    brokerCount: latest.brokerCount,
    concentration: latest.concentration,
  }
}
