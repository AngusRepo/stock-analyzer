/** Exact-source CPU replay checkpoints; never execution or maturity evidence. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export function atomicReplayCheckpoint(directory: string, runnerBytes: Buffer) {
  const kernel = hash(runnerBytes)
  mkdirSync(directory, { recursive: true })
  return { async run<T>(identity: unknown, compute: () => Promise<T>): Promise<T> {
    const key = hash(JSON.stringify({ kernel, identity }))
    const path = join(directory, key + '.json')
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      if (saved.key !== key || typeof saved.body !== 'string' || hash(saved.body) !== saved.sha256)
        throw new Error('atomic_replay_checkpoint_checksum_invalid')
      process.stderr.write(JSON.stringify({phase:'atomic_replay',key,status:'reused'})+'\n')
      return JSON.parse(saved.body) as T
    }
    const value = await compute()
    const body = JSON.stringify(value)
    writeFileSync(path + '.tmp', JSON.stringify({ key, body, sha256: hash(body) }))
    renameSync(path + '.tmp', path)
    process.stderr.write(JSON.stringify({phase:'atomic_replay',key,status:'checkpointed'})+'\n')
    return value
  } }
}
