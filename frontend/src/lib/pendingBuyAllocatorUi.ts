export type AllocatorDecisionTone = 'ok' | 'warn' | 'neutral'

export interface ParsedAllocatorDecision {
  action: string
  reason: string
  targetPosition?: number | null
  currentPosition?: number | null
  budgetCap?: number | null
  replaceSymbol?: string | null
  replaceWeakness?: number | null
  candidateRank?: number | null
  targetExposure?: number | null
}

export interface AllocatorDecisionSummary extends ParsedAllocatorDecision {
  title: string
  detail: string
  tone: AllocatorDecisionTone
}

function parseNumber(value: string | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseDetail(detail: string | undefined): Record<string, string> {
  if (!detail) return {}
  return detail.split(';').reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...rawValue] = part.split('=')
    const key = rawKey?.trim()
    const value = rawValue.join('=').trim()
    if (key) acc[key] = value
    return acc
  }, {})
}

export function parseAllocatorDecisionWatchPoint(raw: unknown): ParsedAllocatorDecision | null {
  const text = String(raw ?? '')
  if (!text.startsWith('allocator:')) return null
  const [, action, reason, ...detailParts] = text.split(':')
  if (!action || !reason) return null
  const detail = parseDetail(detailParts.join(':'))
  return {
    action,
    reason,
    targetPosition: parseNumber(detail.target),
    currentPosition: parseNumber(detail.current),
    budgetCap: parseNumber(detail.budget),
    replaceSymbol: detail.replace || null,
    replaceWeakness: parseNumber(detail.weakness),
    candidateRank: parseNumber(detail.rank),
    targetExposure: parseNumber(detail.exposure),
  }
}

function twAction(action: string): { label: string; tone: AllocatorDecisionTone } {
  if (action === 'buy') return { label: '開新倉', tone: 'ok' }
  if (action === 'add') return { label: '加碼既有持倉', tone: 'ok' }
  if (action === 'replace') return { label: '替換弱持倉', tone: 'warn' }
  if (action === 'hold') return { label: '保留，不加碼', tone: 'neutral' }
  return { label: '不新增部位', tone: 'warn' }
}

function twReason(reason: string): string {
  const map: Record<string, string> = {
    allocator_open_slot: '仍有可用槽位，依信心與風險配置資金。',
    allocator_add_underweight_slot: '已持有但低於目標部位，允許加碼到合理大小。',
    allocator_replace_weakest_slot: '候選強度足以挑戰最弱持倉，需先賣出弱持倉再買入。',
    allocator_full_requires_replacement: '五檔槽位已滿，候選尚未強到足以替換現有持倉。',
    allocator_replace_requires_sell_first: '五檔槽位已滿，必須先完成替換賣出才可買入。',
    allocator_slot_already_sized: '既有持倉已達目標部位，避免過度集中。',
    allocator_budget_below_min: '剩餘可用資金低於最小部位門檻。',
    allocator_target_exposure_zero: '目前市場風險不允許新增曝險。',
    allocator_no_plan: '資金配置器沒有產生可執行計畫。',
  }
  return map[reason] ?? reason.replace(/_/g, ' ')
}

function fmtMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `$${Math.round(value).toLocaleString('zh-TW')}`
}

export function describeAllocatorDecision(watchPoints: unknown): AllocatorDecisionSummary | null {
  const points = Array.isArray(watchPoints) ? watchPoints : []
  const parsed = [...points]
    .reverse()
    .map(parseAllocatorDecisionWatchPoint)
    .find((item): item is ParsedAllocatorDecision => Boolean(item))
  if (!parsed) return null

  const action = twAction(parsed.action)
  const parts = [
    `目標部位 ${fmtMoney(parsed.targetPosition)}`,
    `目前持有市值 ${fmtMoney(parsed.currentPosition)}`,
    `本次上限 ${fmtMoney(parsed.budgetCap)}`,
  ]
  if (parsed.targetExposure != null) parts.push(`總曝險 ${(parsed.targetExposure * 100).toFixed(0)}%`)
  if (parsed.replaceSymbol) {
    parts.push(`替換 ${parsed.replaceSymbol}${parsed.replaceWeakness != null ? `，弱度 ${parsed.replaceWeakness}` : ''}`)
  }
  if (parsed.candidateRank != null) parts.push(`候選強度 ${parsed.candidateRank.toFixed(1)}`)

  return {
    ...parsed,
    title: action.label,
    detail: `${twReason(parsed.reason)} ${parts.join(' / ')}`,
    tone: action.tone,
  }
}
