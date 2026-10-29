// CI-NEW-37 (D10): Worker tests read fixtures from the repo, never from audits/ or a local path.
// audits/ is mostly untracked, so a test that reads it passes only on the machine that has it and
// blocks NEW-R03 (clearing the retained audits directories). 8d4d76d8/425039c1 moved the last three
// (hmm-risk-repair, dynamic-risk-p9, revenue-and-picks) into worker/test-fixtures; this keeps it so.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const FILE_READ = /\b(?:readFileSync|readdirSync|existsSync|statSync|createReadStream|readFile)\s*\(\s*([^)]*)\)/g
// Absolute local paths are never a portable fixture, even when held in a variable first.
const LOCAL_PATH = /['"`](?:[A-Za-z]:[/\\]|\/(?:Users|home|Volumes|private|opt)\/)[^'"`]*['"`]/g
const AUDITS = /\baudits[/\\]|['"`]audits['"`]/

export function offendingReads(source: string): string[] {
  return [...[...source.matchAll(FILE_READ)].map(match => match[1]).filter(args => AUDITS.test(args)),
    ...[...source.matchAll(LOCAL_PATH)].map(match => match[0])]
}

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? testFiles(join(dir, entry.name))
    : entry.name.endsWith('.test.ts') ? [join(dir, entry.name)] : [])
}

test('no Worker test reads a fixture from audits/ or an absolute local path', () => {
  const self = fileURLToPath(import.meta.url)
  const offenders = Object.fromEntries(testFiles(SRC).filter(path => path !== self)
    .map(path => [path.slice(SRC.length), offendingReads(readFileSync(path, 'utf8'))] as const)
    .filter(([, reads]) => reads.length))
  assert.deepEqual(offenders, {})
})

test('the scan flags audits and local-path reads but not repo fixtures or plain strings', () => {
  assert.deepEqual(offendingReads([
    "readFileSync('C:/Users/Wei/Desktop/x.json','utf8')",
    "fs.readFileSync(root + '/audits/hmm-risk-repair-20261007/a.json')",
    "const root = '/Users/wei/stockvision/audits/x'",
    "const repo = '/Volumes/FireCuda/CloudCode/stockvision-cloudflare-v12'",
    "existsSync(join(ROOT, 'audits', 'x'))",
    "readFileSync(new URL('../../test-fixtures/daily-market-risk/a.json', import.meta.url))",
    "const ref = 'audits/repair.json'",
  ].join('\n')).length, 5)
})
