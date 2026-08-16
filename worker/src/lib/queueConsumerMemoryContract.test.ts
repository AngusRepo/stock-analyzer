import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/index.ts', 'utf8')
const queueConsumer = source.slice(source.indexOf('  async queue('))
const wrangler = fs.readFileSync('wrangler.toml', 'utf8')

assert.match(queueConsumer, /for \(const msg of batch\.messages\)/)
assert.doesNotMatch(queueConsumer, /Promise\.all\(batch\.messages/)
assert.match(queueConsumer, /await processUpdateBatch\(msg\.body/)
assert.match(queueConsumer, /msg\.ack\(\)/)
assert.match(queueConsumer, /msg\.retry\(\)/)
assert.match(
  wrangler,
  /\[\[queues\.consumers\]\]\s+queue = "stockvision-update-queue"\s+max_batch_size = 1/,
)

console.log('queue consumer memory contract tests passed')
