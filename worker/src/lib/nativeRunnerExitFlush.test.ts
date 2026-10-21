import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// The native Paper runner ends with one large JSON line on a pipe, then exits.
// The parent (ml-controller native_paper_sandbox) must receive that line whole.
test('final protocol line far larger than a pipe buffer reaches the parent intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-exit-'))
  try {
    const helper = pathToFileURL(join(__dirname, '../node-runner/exitAfterWrite.ts')).href
    const child = join(dir, 'child.ts')
    writeFileSync(child, `import { writeLineThenExit } from ${JSON.stringify(helper)}
writeLineThenExit({ type: 'complete', result: 'x'.repeat(4 * 1024 * 1024) }, 0)\n`)
    const proc = spawn(process.execPath, ['--import', 'tsx', child], { stdio: ['ignore', 'pipe', 'inherit'] })
    const chunks: Buffer[] = []
    // Read slowly so the child's write cannot finish before it would exit.
    proc.stdout.on('data', chunk => { chunks.push(chunk); proc.stdout.pause(); setTimeout(() => proc.stdout.resume(), 2) })
    const code = await new Promise<number | null>(resolve => proc.on('close', resolve))
    const text = Buffer.concat(chunks).toString('utf8')
    assert.equal(code, 0)
    assert.ok(text.endsWith('\n'), `line truncated at ${text.length} chars`)
    assert.equal(JSON.parse(text).result.length, 4 * 1024 * 1024)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
