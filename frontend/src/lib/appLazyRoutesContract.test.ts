import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appSource = readFileSync(resolve(srcDir, 'App.tsx'), 'utf8')

const lazyPageImports = Array.from(
  appSource.matchAll(/lazy\(\(\) => import\(['"](\.\/pages\/[^'"]+)['"]\)\)/g),
  (match) => match[1],
)

assert(lazyPageImports.length > 0, 'App.tsx should declare lazy page imports')

for (const pageImport of lazyPageImports) {
  const pagePath = resolve(srcDir, pageImport)
  const candidates = [
    `${pagePath}.tsx`,
    `${pagePath}.ts`,
    resolve(pagePath, 'index.tsx'),
    resolve(pagePath, 'index.ts'),
  ]

  assert(
    candidates.some((candidate) => existsSync(candidate)),
    `Missing lazy route module: ${pageImport}`,
  )
}
