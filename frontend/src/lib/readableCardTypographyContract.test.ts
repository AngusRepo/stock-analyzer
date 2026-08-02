import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(process.cwd(), 'src')
const css = fs.readFileSync(path.join(root, 'index.css'), 'utf8')
const strategy = fs.readFileSync(path.join(root, 'pages/StrategyLearningPage.tsx'), 'utf8')
const maturity = fs.readFileSync(path.join(root, 'components/PipelineMaturityContribution.tsx'), 'utf8')

test('dense decision cards share homepage readable typography', () => {
  assert(strategy.includes('sv-readable-card-content'))
  assert(maturity.includes('sv-readable-card-content'))

  for (const token of [
    '.sv-readable-card-content .text-\\[10px\\]',
    '.sv-readable-card-content .text-\\[11px\\]',
    '.sv-readable-card-content .text-xs',
    '.sv-readable-card-content .text-sm',
    '.sv-readable-card-content .text-lg',
  ]) {
    assert(css.includes(token), 'missing readable typography selector: ' + token)
  }

  assert(css.includes('.sv-readable-card-content [class*="font-["]'))
  assert(css.includes("font-family: 'Manrope', 'Noto Sans TC', system-ui, sans-serif !important"))
})