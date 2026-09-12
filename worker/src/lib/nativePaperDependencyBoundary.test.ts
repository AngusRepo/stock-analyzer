import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { build } from 'esbuild'

test('the actual native dependency bundle has no unscoped clock or direct fetch escape', async () => {
  const bundle = await build({ entryPoints: ['src/lib/nativePaperExecutionFrame.ts'], bundle: true,
    write: false, metafile: true, platform: 'neutral', packages: 'external' })
  const violations: string[] = []
  const files = Object.keys(bundle.metafile!.inputs).filter(file => !file.endsWith('paperExecutionScope.ts'))
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node: ts.Node) {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'Date' && !node.arguments?.length) {
        violations.push(`${file}:unscoped_new_Date`)
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'Date.now') {
        violations.push(`${file}:unscoped_Date_now`)
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'crypto.randomUUID') {
        violations.push(`${file}:unscoped_random_UUID`)
      }
      if (ts.isIdentifier(node) && node.text === 'fetch' && !ts.isTypeQueryNode(node.parent)) {
        violations.push(`${file}:unscoped_fetch_reference`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.ok(files.length > 20, 'audit must traverse the real native dependency graph')
  assert.deepEqual(violations, [])
  console.log(`native dependency boundary: ${files.length} modules checked`)
})
