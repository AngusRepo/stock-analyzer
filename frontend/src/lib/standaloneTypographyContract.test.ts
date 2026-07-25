import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const css = fs.readFileSync('src/components/observability/StandaloneJobRegistry.css', 'utf8').replace(/\r\n/g, '\n')

assert(css.includes('.obs-standalone__group-header p { margin: 0; color: #e2e8ef; font-size: 14px; font-weight: 600;'), 'group headings must use the homepage-aligned 14px title role')
assert(css.includes('.obs-standalone__identity strong { display: block; overflow: hidden; color: #e0e7ee; font-size: 14px; font-weight: 600;'), 'job names must use the homepage-aligned 14px title role')
assert(css.includes('.obs-standalone__status { display: flex; flex: none; align-items: center; gap: 5px; color: #8496a9; font-size: 12px; font-weight: 600;'), 'job status must remain readable at 12px')
assert(css.includes('.obs-standalone__summary { display: -webkit-box; min-height: 40px; max-height: 40px;'), 'summary height must accommodate the enlarged two-line body')
assert(css.includes('font-size: 12px; line-height: 20px;'), 'summary body must use the readable 12px/20px role')

console.log('standaloneTypographyContract: OK')
