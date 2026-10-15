import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicReplayCheckpoint } from './atomicReplayCheckpoint'

test('interrupted population resumes only exact source/kernel and rejects corrupt completed output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-checkpoint-test-'))
  try {
    let calls = 0
    const compute = async () => { calls++; return { candidate: [1, 2, 3] } }
    const first = atomicReplayCheckpoint(dir, Buffer.from('kernel1'))
    await first.run({ source: 'a', replacement: 1 }, compute)
    await assert.rejects(first.run({ source: 'a', replacement: 2 }, async () => { throw Error('interrupted') }))
    assert.equal(readdirSync(dir).length, 1)
    const second = atomicReplayCheckpoint(dir, Buffer.from('kernel1'))
    assert.deepEqual(await second.run({ source: 'a', replacement: 1 }, compute), { candidate: [1, 2, 3] })
    assert.equal(calls, 1)
    await second.run({ source: 'b', replacement: 1 }, compute)
    await atomicReplayCheckpoint(dir, Buffer.from('kernel2')).run({ source: 'a', replacement: 1 }, compute)
    assert.equal(calls, 3)
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), saved = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(path, JSON.stringify({ ...saved, body: '{}' }))
    }
    await assert.rejects(second.run({ source: 'a', replacement: 1 }, compute), /checksum_invalid/)
    assert.equal(calls, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
