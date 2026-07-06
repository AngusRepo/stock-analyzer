export interface L4SparseAllocationSizingEvidence {
  weight: number
  allocationRank: number | null
  allocationCapacity: number | null
  expectedReturn: number | null
  riskEstimate: number | null
  selectionReason: string | null
  s12ContextMultiplier: number | null
  s12ContextHaircuts: string[]
  vwapFastAcceptance: boolean | null
  vwapSlowContext: string | null
  htfHardBlock: boolean | null
}

const WATCH_PREFIX = 'l4_sparse_allocation:'

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clampWeight(value: unknown): number | null {
  const n = finiteNumber(value)
  if (n == null || n <= 0) return null
  if (n <= 1) return n
  if (n <= 100) return n / 100
  return null
}

function compactNumber(value: unknown, digits = 6): string | null {
  const n = finiteNumber(value)
  if (n == null) return null
  return String(Math.round(n * 10 ** digits) / 10 ** digits)
}

function compactText(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  return text.replace(/[;:=\s]+/g, '_').slice(0, 80)
}

function compactBoolean(value: unknown): string | null {
  if (value === true || value === 1 || String(value ?? '').trim().toLowerCase() === 'true') return '1'
  if (value === false || value === 0 || String(value ?? '').trim().toLowerCase() === 'false') return '0'
  return null
}

function parseCompactBoolean(value: unknown): boolean | null {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '1' || text === 'true') return true
  if (text === '0' || text === 'false') return false
  return null
}

function compactStringList(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const items = value.map(compactText).filter(Boolean).slice(0, 4)
  return items.length ? items.join('|') : null
}

function parseCompactStringList(value: unknown): string[] {
  const text = String(value ?? '').trim()
  if (!text) return []
  return text.split('|').map((item) => item.trim()).filter(Boolean)
}

export function buildL4SparseAllocationWatchPoint(source: {
  allocation_weight?: number | null
  allocation_rank?: number | null
  allocation_capacity?: number | null
  buy_signal_count?: number | null
  expected_return?: number | null
  risk_estimate?: number | null
  selection_reason?: string | null
  s12_context_multiplier?: number | null
  s12_context_haircuts?: string[] | null
  vwap_fast_acceptance?: boolean | null
  vwap_slow_context?: string | null
  htf_hard_block?: boolean | null
} | null | undefined): string | null {
  const weight = clampWeight(source?.allocation_weight)
  if (weight == null) return null
  const parts = [
    `weight=${compactNumber(weight)}`,
    compactNumber(source?.allocation_rank, 0) ? `rank=${compactNumber(source?.allocation_rank, 0)}` : null,
    compactNumber(source?.allocation_capacity ?? source?.buy_signal_count, 0)
      ? `capacity=${compactNumber(source?.allocation_capacity ?? source?.buy_signal_count, 0)}`
      : null,
    compactNumber(source?.expected_return) ? `expected_return=${compactNumber(source?.expected_return)}` : null,
    compactNumber(source?.risk_estimate) ? `risk_estimate=${compactNumber(source?.risk_estimate)}` : null,
    compactText(source?.selection_reason) ? `reason=${compactText(source?.selection_reason)}` : null,
    compactNumber(source?.s12_context_multiplier) ? `s12_ctx_mult=${compactNumber(source?.s12_context_multiplier, 4)}` : null,
    compactBoolean(source?.vwap_fast_acceptance) ? `s12_fast_vwap=${compactBoolean(source?.vwap_fast_acceptance)}` : null,
    compactText(source?.vwap_slow_context) ? `s12_slow_vwap=${compactText(source?.vwap_slow_context)}` : null,
    compactBoolean(source?.htf_hard_block) ? `s12_htf_block=${compactBoolean(source?.htf_hard_block)}` : null,
    compactStringList(source?.s12_context_haircuts) ? `s12_haircuts=${compactStringList(source?.s12_context_haircuts)}` : null,
  ].filter(Boolean)
  return `${WATCH_PREFIX}${parts.join(';')}`
}

export function parseL4SparseAllocationWatchPoint(point: string | null | undefined): L4SparseAllocationSizingEvidence | null {
  const text = String(point ?? '').trim()
  if (!text.startsWith(WATCH_PREFIX)) return null
  const fields = new Map<string, string>()
  for (const part of text.slice(WATCH_PREFIX.length).split(';')) {
    const [key, ...rest] = part.split('=')
    if (!key || rest.length === 0) continue
    fields.set(key, rest.join('='))
  }
  const weight = clampWeight(fields.get('weight'))
  if (weight == null) return null
  return {
    weight,
    allocationRank: finiteNumber(fields.get('rank')),
    allocationCapacity: finiteNumber(fields.get('capacity')),
    expectedReturn: finiteNumber(fields.get('expected_return')),
    riskEstimate: finiteNumber(fields.get('risk_estimate')),
    selectionReason: fields.get('reason') ?? null,
    s12ContextMultiplier: finiteNumber(fields.get('s12_ctx_mult')),
    s12ContextHaircuts: parseCompactStringList(fields.get('s12_haircuts')),
    vwapFastAcceptance: parseCompactBoolean(fields.get('s12_fast_vwap')),
    vwapSlowContext: fields.get('s12_slow_vwap') ?? null,
    htfHardBlock: parseCompactBoolean(fields.get('s12_htf_block')),
  }
}

export function l4SparseSizingFromWatchPoints(points: unknown): L4SparseAllocationSizingEvidence | null {
  if (!Array.isArray(points)) return null
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const parsed = parseL4SparseAllocationWatchPoint(String(points[index] ?? ''))
    if (parsed) return parsed
  }
  return null
}

export function resolveL4SparseBudgetFloor(input: {
  totalPortfolio: number
  baseBudget: number
  allocationWeight: number | null | undefined
}): { budget: number; allocationTarget: number | null; sizingMode: 'risk_parity' | 'l4_sparse_weight' } {
  const baseBudget = Math.max(0, finiteNumber(input.baseBudget) ?? 0)
  const weight = clampWeight(input.allocationWeight)
  if (weight == null) return { budget: baseBudget, allocationTarget: null, sizingMode: 'risk_parity' }
  const allocationTarget = Math.max(0, (finiteNumber(input.totalPortfolio) ?? 0) * weight)
  if (allocationTarget > baseBudget) {
    return { budget: allocationTarget, allocationTarget, sizingMode: 'l4_sparse_weight' }
  }
  return { budget: baseBudget, allocationTarget, sizingMode: 'risk_parity' }
}
