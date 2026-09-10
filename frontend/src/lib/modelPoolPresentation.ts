import type { ModelChampionPointersResponse } from './api'

export type PoolTone = 'ok' | 'info' | 'warn' | 'error' | 'neutral'
export type PoolMembership = 'selected' | 'not_selected' | 'unknown'

export function modelPoolHealth(pointers?: ModelChampionPointersResponse) {
  const bundle = pointers?.active8_bundle
  const selected = [...new Set(bundle?.selected_models ?? [])]
  const blockers = [...(bundle?.blockers ?? [])]
  let ready = 0
  const readyModels: string[] = []
  if (!bundle) return { selected, ready, readyModels, blockers, tone: 'neutral' as PoolTone, label: '未知' }
  for (const name of selected) {
    const expected = bundle.base_artifacts?.[name]
    const actual = pointers?.models?.[name]
    const matches = actual?.readiness === 'v5_serving'
      && Boolean(expected?.artifact_id && expected.version && expected.checksum)
      && actual.serving_artifact_id === expected?.artifact_id
      && actual.serving_version === expected?.version
      && actual.serving_checksum === expected?.checksum
    if (matches) {
      ready += 1
      readyModels.push(name)
    }
    else blockers.push(`${name}: bundle 成員尚未就緒或 identity 不一致`)
  }
  if (selected.length !== (bundle.selected_models ?? []).length) blockers.push('bundle 成員重複')
  if (Object.keys(bundle.base_artifacts ?? {}).some(name => !selected.includes(name))) blockers.push('bundle identity 成員不一致')
  const active = bundle.production_effect === true && bundle.status === 'production' && selected.length > 0
  const tone: PoolTone = active && ready === selected.length && blockers.length === 0 ? 'ok'
    : blockers.length || bundle.status.startsWith('invalid') || bundle.status === 'validation_failed' ? 'error' : 'neutral'
  return { selected, ready, readyModels, blockers: [...new Set(blockers)], tone, label: tone === 'ok' ? '可服務' : tone === 'error' ? '受阻' : '尚未就緒' }
}

export function modelMembership(name: string, pointers?: ModelChampionPointersResponse): PoolMembership {
  const bundle = pointers?.active8_bundle
  if (bundle?.selected_models?.includes(name)) return 'selected'
  if (bundle?.production_effect && bundle.status === 'production' && bundle.selected_models.length > 0
      && pointers?.models?.[name]?.readiness === 'evidence_only_no_action') return 'not_selected'
  return 'unknown'
}

export function membershipLabel(role: PoolMembership): string {
  return role === 'selected' ? '本輪入選' : role === 'not_selected' ? '本輪未入選' : '角色待確認'
}

export function presentationTime(value?: string | number | null): string {
  if (value == null) return '尚未取得'
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(' ', 'T') + 'Z' : value
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? '日期未知' : new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}


export function ensembleQualificationPresentation(pointers?: ModelChampionPointersResponse) {
  const q = pointers?.active8_bundle?.qualifications
  const signals = Object.values(q?.directional.signals ?? {})
  const unreachable = signals.length > 0 && signals.every(signal => signal.reachable === false)
  return {
    ranking: q?.ranking.decision === 'PASS' ? '排名資格通過' : q ? '排名資格未通過' : '排名資格待確認',
    calibration: q?.calibration.decision === 'PASS' ? '區間 coverage 通過' : '區間校準證據不足或待確認',
    direction: !q ? '訊號資格待確認' : q.directional.allowed_signals.length
      ? `已具備訊號資格：${q.directional.allowed_signals.join('、')}` : '方向訊號資格受阻',
    detail: unreachable ? '目前模型輸出無法跨過訊號門檻；預測與排名仍可服務。'
      : q?.directional.decision === 'BLOCKED' ? '方向訊號證據不足；不影響排名資格晉級。'
      : '交易訊號資格與 ensemble 排名晉級分開判定。',
  }
}
