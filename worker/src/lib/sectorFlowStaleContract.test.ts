const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const route = fs.readFileSync('src/routes/other.ts', 'utf8')

assert(
  route.includes('stale_date') && route.includes('requested_date'),
  'sector-flow fallback must expose stale_date/requested_date instead of silently pretending data is fresh',
)
assert(
  !route.includes("date: 'latest'"),
  'sector-flow fallback must not return date=latest because the UI cannot tell which trading date is stale',
)
