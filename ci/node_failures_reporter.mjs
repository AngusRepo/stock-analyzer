// node --test reporter: one "worker: <file> :: <test path>" line per failed test.
// A file that crashes outside node:test (custom main()) fails as its own entry.
// ci/node_passes_reporter.mjs writes the same ids for passed tests (CI-NEW-35 reruns).
import { relative } from 'node:path'

export function testIds(outcome) {
  return async function* ids(source) {
    const stack = []
    for await (const event of source) {
      if (event.type !== 'test:start' && event.type !== 'test:fail' && event.type !== 'test:pass') continue
      const { name, nesting = 0, file } = event.data
      if (event.type === 'test:start') { stack[nesting] = name; stack.length = nesting + 1; continue }
      if (event.type === outcome && (outcome === 'test:fail' || !(event.data.skip || event.data.todo))) {
        const rel = file ? relative(process.cwd(), file).replaceAll('\\', '/') : '?'
        const path = name === file ? '<file>' : [...stack.slice(0, nesting), name].join(' > ')
        yield `worker: ${rel} :: ${path}\n`
      }
    }
  }
}

export default testIds('test:fail')
