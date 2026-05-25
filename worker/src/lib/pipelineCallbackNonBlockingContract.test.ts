import assert from 'node:assert/strict'
import fs from 'node:fs'

const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')

assert(
  adminControlRoutes.includes("body.task === 'pipeline'") &&
    adminControlRoutes.includes('c.executionCtx.waitUntil((async () => {') &&
    adminControlRoutes.includes('runPostPipelineCallbackChain(c.env'),
  'pipeline scheduler callback must detach post-pipeline closure with waitUntil so Cloud Run pipeline-v2 is not held open',
)

assert(
  !adminControlRoutes.includes(
    "const { runPostPipelineCallbackChain } = await import('../lib/postMarketChain')\n        await runPostPipelineCallbackChain",
  ),
  'pipeline scheduler callback must not synchronously await runPostPipelineCallbackChain before responding to ml-controller',
)

assert(
  adminControlRoutes.includes("await c.env.KV.delete(`lock:ml-predict:${callbackRunDate}`).catch(() => {})"),
  'pipeline callback should still release the ml-predict lock before returning',
)
