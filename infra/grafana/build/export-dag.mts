/** Exports the chains as the dashboards draw them: phases, main lanes, labels, dependencies (daily at the top level, the others under other_chains).
 * Run from worker/ on a checkout that has the monitoring Worker:
 *   node --import tsx ../infra/grafana/build/export-dag.mts <out file> */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const judgment = (file: string) => pathToFileURL(join(process.cwd(), 'src/monitoring/judgment', file)).href
const { STAGES, scopeById, scopeDisplayStageIds, scopeExecutionStageIds } = await import(judgment('executionChainDag.ts'))
const { DAILY_READINESS_PHASES, READINESS_MAIN_STAGES } = await import(judgment('dailyReadinessPhases.ts'))
const { PIPELINE_STAGE_CARDS } = await import(judgment('pipelineStageCards.ts'))
const { FINLAB_STAGE_CARDS } = await import(judgment('finlabStageCards.ts'))

const out = process.argv[2]
if (!out) throw new Error('usage: export-dag.mts <out file>')
const cards = new Map<string, { label: string; parent: string }>([
  ...FINLAB_STAGE_CARDS.map((card: { id: string; label: string }) => [card.id, { label: card.label, parent: 'finlab-v4-backfill' }] as const),
  ...PIPELINE_STAGE_CARDS.map((card: { id: string; label: string }) => [card.id, { label: card.label, parent: 'pipeline' }] as const),
])
const display: string[] = scopeDisplayStageIds(scopeById('daily_readiness'))
const dag = {
  chain_id: 'daily_readiness',
  phases: DAILY_READINESS_PHASES.map((phase: { id: string; title: string; caption: string; stages: readonly string[] }) => ({
    id: phase.id, title: phase.title, caption: phase.caption, main: READINESS_MAIN_STAGES[phase.id],
    side: phase.stages.filter((id) => !READINESS_MAIN_STAGES[phase.id].includes(id)),
  })),
  // The stages the state table has a row for (parents, not their cards), in chain order.
  catalog: scopeExecutionStageIds(scopeById('daily_readiness')).map((id: string) => ({ id, label: STAGES[id]?.label ?? id })),
  stages: Object.fromEntries(display.map((id) => [id, {
    label: cards.get(id)?.label ?? STAGES[id]?.label ?? id, parent: cards.get(id)?.parent ?? null,
    optional: Boolean(STAGES[id]?.optional), depends_on: STAGES[id]?.dependsOn ?? null,
  }])),
}
type Phase = { id: string; title: string; caption: string; stages: readonly string[]; main: readonly string[] }
const { OTHER_CHAIN_PHASES, chainStageIds } = await import(judgment('chainPhases.ts'))
// The intraday, weekly and monthly chains: no sub-stage cards, one phase list each.
const otherChains = Object.fromEntries(Object.entries(OTHER_CHAIN_PHASES as Record<string, Phase[]>).map(([chainId, phases]) => {
  const ids: string[] = chainStageIds(chainId)
  return [chainId, {
    phases: phases.map((phase) => ({ id: phase.id, title: phase.title, caption: phase.caption, main: [...phase.main],
      side: phase.stages.filter((id) => !phase.main.includes(id)) })),
    catalog: ids.map((id) => ({ id, label: STAGES[id]?.label ?? id })),
    stages: Object.fromEntries(ids.map((id) => [id, { label: STAGES[id]?.label ?? id, parent: null, optional: Boolean(STAGES[id]?.optional), depends_on: null }])),
  }]
}))
const chains = [dag, ...Object.values(otherChains)] as Array<{ phases: Array<{ main: string[]; side: string[] }>; stages: Record<string, unknown> }>
const missing = chains.flatMap((chain) => chain.phases.flatMap((phase) => [...phase.main, ...phase.side]).filter((id) => !chain.stages[id]))
if (missing.length) throw new Error(`phase stages outside the display list: ${missing.join(', ')}`)
writeFileSync(out, `${JSON.stringify({ ...dag, other_chains: otherChains }, null, 1)}\n`)
console.log(`${display.length} stages in ${dag.phases.length} phases, plus ${Object.entries(otherChains).map(([id, chain]) => `${id} ${chain.catalog.length}`).join(', ')} → ${out}`)
