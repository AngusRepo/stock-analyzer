import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { safeExternalUrl } from './safeUrl'

test('safeExternalUrl keeps absolute http(s) links', () => {
  assert.equal(safeExternalUrl('https://news.cnyes.com/a?b=1'), 'https://news.cnyes.com/a?b=1')
  assert.equal(safeExternalUrl(' http://mops.twse.com.tw/x '), 'http://mops.twse.com.tw/x')
})

test('safeExternalUrl drops script, data, relative and empty values', () => {
  for (const value of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '/news/1', '#', '', null, undefined, 42]) {
    assert.equal(safeExternalUrl(value), undefined, String(value))
  }
})

test('every API-sourced anchor goes through safeExternalUrl', () => {
  const root = process.cwd()
  const files = [
    ['pages', 'MarketHomePage.tsx'],
    ['components', 'RecommendationCardClean.tsx'],
    ['components', 'NewsPanel.tsx'],
    ['components', 'MarketRiskPanel.tsx'],
  ]
  for (const parts of files) {
    const source = fs.readFileSync(path.join(root, 'src', ...parts), 'utf8')
    assert.ok(source.includes('safeExternalUrl('), `${parts.join('/')} should sanitize external links`)
    assert.ok(!/href=\{(item|event|link)\.url/.test(source) && !source.includes('href={group.source}'), `${parts.join('/')} should not bind raw API URLs to href`)
  }
})
