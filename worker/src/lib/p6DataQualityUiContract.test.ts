const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const app = fs.readFileSync('../frontend/src/App.tsx', 'utf8')
const shell = fs.readFileSync('../frontend/src/components/AppShell.tsx', 'utf8')
const pagePath = '../frontend/src/pages/DataQualityPage.tsx'

assert(app.includes('DataQualityPage'), 'App should lazy-load DataQualityPage')
assert(app.includes('/data-quality'), 'App should expose /data-quality route')
assert(shell.includes('Data Quality'), 'Admin nav should expose Data Quality')
assert(shell.includes('/data-quality'), 'Admin nav should link to /data-quality')
assert(fs.existsSync(pagePath), 'DataQualityPage should exist')

const page = fs.readFileSync(pagePath, 'utf8')
assert(page.includes('dataQualityApi.status'), 'DataQualityPage should load P6 data quality report')
assert(page.includes('deployGateApi.predeploy'), 'DataQualityPage should show P9 deploy gate result')
assert(page.includes('缺口'), 'DataQualityPage should show actionable gaps, not only raw numbers')
