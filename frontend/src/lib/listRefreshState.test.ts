import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { listRefreshState } from './listRefreshState'

test('R2-6: a failed refresh over an empty list still shows the failure with retry', () => {
  assert.equal(listRefreshState({ isLoading: true, isError: false, hasData: false, count: 0 }), 'loading')
  assert.equal(listRefreshState({ isLoading: false, isError: true, hasData: false, count: 0 }), 'error')
  assert.equal(listRefreshState({ isLoading: false, isError: true, hasData: true, count: 0 }), 'empty-stale')
  assert.equal(listRefreshState({ isLoading: false, isError: false, hasData: true, count: 0 }), 'empty')
  assert.equal(listRefreshState({ isLoading: false, isError: true, hasData: true, count: 3 }), 'list-stale')
  assert.equal(listRefreshState({ isLoading: false, isError: false, hasData: true, count: 3 }), 'list')
})

test('R2-6: home recommendations and trade history branch on listRefreshState and render the empty-stale notice', () => {
  const src = path.resolve(process.cwd(), 'src')
  for (const file of ['pages/MarketHomePage.tsx', 'pages/BotDashboard.tsx']) {
    const page = fs.readFileSync(path.join(src, file), 'utf8')
    assert.ok(page.includes('listRefreshState({ isLoading, isError, hasData: !!data, count:'), file)
    const stale = page.indexOf("listState === 'empty-stale' && <DataState kind=\"stale\"")
    assert.ok(stale > 0, `${file} shows the stale notice on an empty list`)
    assert.ok(page.slice(stale, stale + 300).includes('onRetry'), `${file} offers retry`)
  }
})
