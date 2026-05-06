const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const app = fs.readFileSync('../frontend/src/App.tsx', 'utf8')
const shell = fs.readFileSync('../frontend/src/components/AppShell.tsx', 'utf8')
const obs = fs.readFileSync('../frontend/src/pages/ObservabilityPage.tsx', 'utf8')
const pagePath = '../frontend/src/pages/DataQualityPage.tsx'

assert(app.includes('DataQualityPage'), 'App should lazy-load DataQualityPage')
assert(app.includes('/data-quality'), 'App should expose /data-quality route')
assert(!shell.includes("href: '/data-quality'"), 'Primary admin nav should not duplicate OBS data-quality drilldown')
assert(obs.includes('Data Quality') && obs.includes('/data-quality'), 'OBS should expose Data Quality as a compact drilldown deep link')
assert(fs.existsSync(pagePath), 'DataQualityPage should exist')

const page = fs.readFileSync(pagePath, 'utf8')
assert(page.includes('dataQualityApi.status'), 'DataQualityPage should load P6 data quality report')
assert(!page.includes('deployGateApi.predeploy'), 'DataQualityPage should not duplicate release gate ownership')
assert(page.includes('缺口'), 'DataQualityPage should show actionable gaps, not only raw numbers')
