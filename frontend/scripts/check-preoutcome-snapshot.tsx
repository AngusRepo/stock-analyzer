/** Read-only local rendering of an existing release audit; no API calls. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import PipelineMaturityContribution from '../src/components/PipelineMaturityContribution'
import type { PipelineDecisionMaturityPacket } from '../src/lib/pipelineMaturityContract'

// The repository's standalone tsx runner emits classic JSX for this script.
// Vite uses automatic JSX; this shim is local to the rendering verifier.
Object.assign(globalThis, { React })

assert.ok(process.argv[2], 'provide a saved release final-state.json')
const snapshot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
assert.equal(snapshot.maturity.status_code, 200)
const packet: PipelineDecisionMaturityPacket = snapshot.maturity.body
for (const stage of packet.stages.filter(s => ['l4', 'fusion'].includes(s.id))) {
  const count = stage.metrics.find(m => m.key === 'prospective_evaluable_dates')!
  const latest = stage.metrics.find(m => m.key === 'prospective_prediction_max_date')!
  assert.equal(count.availability, 'available')
  assert.equal(typeof count.value, 'number')
  const html = renderToStaticMarkup(<PipelineMaturityContribution
    data={{ ...packet, stages: [stage] }} loading={false} />)
  assert.ok(html.includes(`已成熟 ${count.value} 日`))
  assert.ok(html.includes(`最新成熟預測日 ${latest.value}`))
  assert.ok(html.includes(`已核對 NAV ${stage.nav_gate!.evaluable_dates}/${stage.nav_gate!.minimum_dates} 日`))
  assert.ok(html.includes('NAV 審查進度（非 pre-outcome 成熟度）'))
  assert.ok(html.includes('原鎖定候選 pre-outcome 持續累積'))
  console.log(JSON.stringify({ stage: stage.id, preoutcome_dates: count.value,
    latest_prediction: latest.value, nav_dates: stage.nav_gate!.evaluable_dates,
    nav_decision: stage.nav_gate!.decision, rendered: true }))
}
