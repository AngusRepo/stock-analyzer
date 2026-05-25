import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const panel = readFileSync('src/components/MarketRiskPanel.tsx', 'utf8')

assert(panel.includes('const centerX = 110'), 'gauge should use a compact centered geometry')
assert(panel.includes('h-24'), 'gauge should use a compact SVG height')
assert(panel.includes('text-3xl'), 'gauge score should be smaller than the previous oversized text')
assert(!panel.includes('-mt-8'), 'gauge score must not be pulled into the needle area with negative margin')
assert(
  panel.includes('lg:grid-cols-[minmax(0,1fr)_220px]'),
  'market panel should reserve a compact fixed gauge column',
)
assert(panel.includes('BusinessCycleLightValue'), 'business cycle tile should render light transition badges')
assert(panel.includes('景氣對策燈號'), 'business cycle group should use a clear Traditional Chinese label')
assert(panel.includes('貪婪') && panel.includes('極恐慌'), 'gauge labels should be readable Chinese text')
