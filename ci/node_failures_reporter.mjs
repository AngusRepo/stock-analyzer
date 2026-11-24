// node --test reporter: one "<suite>: <file> :: <test path>" line per failed test
// (suite = $NODE_FAILURE_SUITE, default worker).
// A file that crashes outside node:test (custom main()) fails as its own entry.
import { relative } from 'node:path'

export default async function* failures(source) {
  const suite = process.env.NODE_FAILURE_SUITE || 'worker'
  const stack = []
  for await (const event of source) {
    if (event.type !== 'test:start' && event.type !== 'test:fail' && event.type !== 'test:pass') continue
    const { name, nesting = 0, file } = event.data
    if (event.type === 'test:start') { stack[nesting] = name; stack.length = nesting + 1; continue }
    if (event.type === 'test:fail') {
      const rel = file ? relative(process.cwd(), file).replaceAll('\\', '/') : '?'
      const path = name === file ? '<file>' : [...stack.slice(0, nesting), name].join(' > ')
      yield `${suite}: ${rel} :: ${path}\n`
    }
  }
}
