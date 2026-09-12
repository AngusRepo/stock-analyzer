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
assert.equal((html.match(/成本後配對 NAV 正式升級判定/g) ?? []).length, 2)
assert.equal((html.match(/已核對 NAV 10\/10 日/g) ?? []).length, 2)
assert.ok(html.includes('家族調整後 p 值'))
assert.ok(html.includes('≤'))
assert.ok(html.includes('PASS 不代表 serving pointer 已移動'))
assert.ok(!html.includes('滿 10 日才依 LCB90 判定'))
assert.ok(!html.includes('離線已拒絕 · 每日 pre-outcome 門檻不適用'))
assert.ok(!html.includes('鎖定候選 freeze'))
assert.equal((html.match(/本頁 NAV 評估候選/g) ?? []).length, 2)
assert.equal((html.match(/最新候選紀錄/g) ?? []).length, 2)
assert.ok(html.includes('候選來源日'))
assert.ok(!html.includes('候選生成日'))
assert.ok(html.includes('new-unverified'))
assert.ok(html.includes('候選身分或 NAV 證據驗證受阻'))
const missing = structuredClone(packet)
for (const stage of missing.stages.filter((s: any) => s.nav_gate)) {
  Object.assign(stage.nav_gate, { evaluable_dates: null, availability: 'missing', decision: null })
}
assert.equal((render(missing).match(/已核對 NAV 未知\/10 日/g) ?? []).length, 2)
console.log('Original API -> React render: both owners, NAV labels, unknown count and no duplicate formal LCB90 passed')
