import type { MarketRegimeState } from './marketRegimeState'

export const HMM_MAX_AGE_MS = 9 * 86400_000

export interface HmmLineage {
  modelSha256: string
  modelGeneration: string
  inputChecksum: string
  qualityChecksum: string
}

export function hmmLineage(state: MarketRegimeState | null): HmmLineage | null {
  const p = state?.regime_evidence?.hmm_provenance as any
  const model = p?.model
  if (![model?.sha256, p?.input_checksum, p?.risk_quality_checksum].every(v => /^[a-f0-9]{64}$/.test(v ?? ''))
      || !/^\d+$/.test(model?.generation ?? '')) return null
  return { modelSha256: model.sha256, modelGeneration: model.generation,
    inputChecksum: p.input_checksum, qualityChecksum: p.risk_quality_checksum }
}

export function sameHmmLineage(left: unknown, right: unknown): boolean {
  const a = left as HmmLineage | null, b = right as HmmLineage | null
  return !!a && !!b && [a.modelSha256, a.inputChecksum, a.qualityChecksum]
    .every(value => /^[a-f0-9]{64}$/.test(value ?? '')) && /^\d+$/.test(a.modelGeneration ?? '')
    && ['modelSha256', 'modelGeneration', 'inputChecksum', 'qualityChecksum']
    .every(key => typeof (a as any)[key] === 'string' && (a as any)[key] === (b as any)[key])
}

export function reusableHmmState(state: MarketRegimeState | null, preflight: any, nowMs: number): boolean {
  const trained = Date.parse(preflight?.model?.trained_at ?? '')
  const asOf = Date.parse((state?.regime_evidence?.hmm_provenance as any)?.inference_as_of ?? '')
  const computed = Date.parse(state?.computed_at ?? '')
  return preflight?.ready === true && state?.source === 'hmm' && state.run_date === preflight.run_date
    && Number.isFinite(trained) && trained <= asOf && asOf <= computed && computed <= nowMs
    && nowMs - trained <= HMM_MAX_AGE_MS
    && sameHmmLineage(hmmLineage(state), {modelSha256: preflight.model.sha256,
      modelGeneration: preflight.model.generation, inputChecksum: preflight.input_checksum,
      qualityChecksum: preflight.risk_quality_checksum})
}
