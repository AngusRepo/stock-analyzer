import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

for (const timezone of ['UTC', 'Asia/Taipei', 'America/Los_Angeles']) {
  test(`Taiwan schedule calendar is independent of host timezone: ${timezone}`, () => {
    const checked = spawnSync(process.execPath, ['--import', 'tsx', 'src/lib/schedulerStatusDisplay.test.ts'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(checked.status, 0, `${checked.error ?? ''}\n${checked.stdout}\n${checked.stderr}`)
  })
}
