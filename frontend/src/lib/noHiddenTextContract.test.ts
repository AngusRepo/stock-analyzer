import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// 2026-11-28 FE-FOLLOWUPS-REMAINING：全站不准折疊、內捲軸、截字、只放在 title 的資訊。
const src = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8')

test('NAV research panels render in place without <details> or desktop inner scroll', () => {
  for (const rel of ['components/NavTradingRoom.tsx', 'components/StrategyCandidateComparison.tsx']) {
    const s = src(rel)
    assert(!s.includes('<details'), `${rel} must not collapse content`)
    assert(!s.includes('overflow-x-auto'), `${rel} must not scroll inside the frame`)
    assert(!/md:min-w-\[/.test(s), `${rel} tables must not force a min width`)
  }
})

test('identifiers are shown in full, not 12-char prefixes or hover-only titles', () => {
  const l4 = src('components/L4DistributionPanel.tsx')
  assert(!l4.includes('slice(0,12)'))
  assert(l4.includes('模型版本 {plan.model_checksum} · 配置 {plan.plan_id}'))
  assert(!src('components/StrategyAbLive.tsx').includes('{id.slice(0, 12)}</option>'))
  const candidate = src('components/CandidateVersionPanel.tsx')
  assert(!candidate.includes('slice(0, 12)'))
  assert(candidate.includes('模型檢查碼 ${String(candidate.checksum)}'))
  const research = src('components/ResearchValidationWorkbench.tsx')
  assert(!research.includes('title={`${t.source.pointer}'))
  assert(research.includes('來源 {t.source.pointer}'))
})

test('SimRoom allocation and header explanations are visible text', () => {
  const room = src('components/simroom/SimRoom.tsx')
  const css = src('components/simroom/simroom.css')
  assert(room.includes('className="alloclegend"'))
  assert(!/<th[^>]*title=/.test(room), 'table header explanations go in .sr-note, not title')
  assert.equal(room.match(/className="sr-note"/g)?.length, 2)
  assert(!/\.allocbar div \{[^}]*white-space: nowrap/.test(css), 'allocation segments must not clip labels')
})

test('OBS GA candidate policy uses Chinese parameter labels', () => {
  const obs = src('pages/ObservabilityPage.tsx')
  assert(!obs.includes('bull trend='))
  assert(obs.includes('多頭時趨勢追蹤權重'))
  assert(obs.includes('學到的參數：'))
})
