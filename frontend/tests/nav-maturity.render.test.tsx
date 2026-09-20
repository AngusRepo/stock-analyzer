import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import PipelineMaturityContribution from '../src/components/PipelineMaturityContribution'

const source = process.env.NAV_ORIGINAL_FIXTURE
assert.ok(source, 'original evaluator fixture required')
const packet = JSON.parse(fs.readFileSync(`${source}.maturity.json`, 'utf8'))
const render = (data: any) => renderToStaticMarkup(<PipelineMaturityContribution data={data} loading={false} onRetry={() => {}} />)
const html = render(packet)
assert.ok(!packet.stages.some((stage: any) => ['l4', 'fusion'].includes(stage.id)))
assert.ok(html.includes('新 L3＋三頭 L4 · 尚未正式採用'))
assert.ok(html.includes('目前尚未讀到新 L4 的正式設定'))
assert.ok(!html.includes('成本後配對 NAV 正式升級判定'))
assert.ok(!html.includes('已核對 NAV 10/10 日'))
assert.ok(!html.includes('滿 10 日才依 LCB90 判定'))
// A stale API/cache packet must not restore retired current-flow cards.
const stale = structuredClone(packet)
for (const id of ['l4', 'fusion']) stale.stages.push({ id, title: `retired-${id}`,
  nav_gate: { availability: 'available', decision: 'PASS', evaluable_dates: 10 } })
const staleHtml = render(stale)
assert.ok(!staleHtml.includes('retired-l4') && !staleHtml.includes('retired-fusion'))
assert.ok(staleHtml.includes('尚未正式採用'))
console.log('Original API -> React render: retired NAV cards remain hidden; new L4 activation requires actual config')
