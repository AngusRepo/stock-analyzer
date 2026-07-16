import assert from 'node:assert'
import { resolveRouteAccessPolicy } from './routePolicy'

assert.equal(resolveRouteAccessPolicy('/api/health'), 'public')
assert.equal(resolveRouteAccessPolicy('/api/auth/google'), 'public')
assert.equal(resolveRouteAccessPolicy('/api/stocks/2330/prices'), 'public')
assert.equal(resolveRouteAccessPolicy('/api/market/indices'), 'public')
assert.equal(resolveRouteAccessPolicy('/api/stocks', 'POST'), 'admin_or_service')
assert.equal(resolveRouteAccessPolicy('/api/stocks/1', 'DELETE'), 'admin_or_service')
assert.equal(resolveRouteAccessPolicy('/api/stocks/1/refresh', 'POST'), 'admin_or_service')
assert.equal(resolveRouteAccessPolicy('/api/news/1/crawl', 'POST'), 'authenticated')
assert.equal(resolveRouteAccessPolicy('/api/market/news', 'POST'), 'deny')

assert.equal(resolveRouteAccessPolicy('/api/recommendations/daily'), 'authenticated')
assert.equal(resolveRouteAccessPolicy('/api/dashboard/v4/data-runtime/status'), 'authenticated')
assert.equal(resolveRouteAccessPolicy('/api/admin/config'), 'admin_or_service')
assert.equal(resolveRouteAccessPolicy('/api/internal/d1/batch'), 'service')
assert.equal(resolveRouteAccessPolicy('/api/full-analysis/run'), 'admin_or_service')

assert.equal(resolveRouteAccessPolicy('/api/new-privileged-feature/run'), 'deny')
assert.equal(resolveRouteAccessPolicy('/not-api'), 'deny')
