import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import StrategyNavEvidence from '../src/components/StrategyNavEvidence'

const source = process.env.NAV_ATOMIC_PUBLICATION_FIXTURE
assert(source, 'original Python -> Worker evidence required')
const packets = JSON.parse(fs.readFileSync(source + '.strategy.json', 'utf8'))
const render = (data: any, loading = false, error: Error | null = null) =>
  renderToStaticMarkup(<StrategyNavEvidence data={data} loading={loading} error={error} onRetry={() => {}} />)
for (const owner of ['shadow', 'adopted']) for (const data of packets[owner]) {
  const html = render(data)
  assert.equal((html.match(/<article /g) ?? []).length, data.entry_count)
  assert(html.includes(owner === 'shadow' ? 'NAV 仍獨立觀察' : '原始配對 NAV'))
  for (const entry of data.entries) {
    assert(html.includes(entry.nav.decision_checksum))
    assert(html.includes((entry.nav.mean_daily_nav_delta * 100).toFixed(4) + '%'))
    assert(html.includes(entry.nav.holm_adjusted_p.toPrecision(5)))
  }
  assert(!render(data, true).includes('<article '), 'stale cached verdict hidden during refresh')
  assert(!render(data, false, new Error('offline')).includes('<article '), 'failed refresh must not show cached PASS')
}
const missing = structuredClone(packets.adopted[0])
missing.status = 'unavailable'
for (const entry of missing.entries) { entry.nav = null; entry.status = 'unavailable'; entry.error = 'original_source_missing' }
assert(render(missing).includes('未知'))
assert(render(missing).includes('UNAVAILABLE'))
const empty = { ...missing, status: 'not_registered', entries: [], entry_count: 0 }
assert(render(empty).includes('沒有把舊 Alpha 樣本換算成 NAV 成熟日'))
console.log('Original Python NAV -> Worker -> React: all comparisons, owners, numeric precision, missing and stale data passed')
