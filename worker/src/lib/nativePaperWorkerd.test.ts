import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'

test('native execution scope also works in real local workerd with the deployed compatibility flags', async () => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { runNativePaperExecutionFrame } from './src/lib/nativePaperExecutionFrame'
    import { paperAccountId } from './src/lib/paperExecutionScope'
    export default { async fetch(request, env) {
      const output = await Promise.all([2,3].map(accountId => {
        const environment = { DB: env.PRIVATE_DB, KV: {} }
        return runNativePaperExecutionFrame({ environment, accountId,
          nowMs: Date.parse('2026-09-06T02:00:00Z'), databases: { paper: env.PRIVATE_DB },
          transaction: callback => callback(),
          fetchFrozen: async () => { throw new Error('network forbidden') }
        }, 'intraday')
      }))
      return Response.json({ accounts: output.map(x => x.result.account_id),
        credits: output.map(x => x.result.nav_maturity_credit), after: paperAccountId() })
    } }
  ` }, bundle: true, format: 'esm', platform: 'neutral', packages: 'external', write: false })
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2024-07-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['PRIVATE_DB'], d1Persist: false })
  try {
    const db = await mf.getD1Database('PRIVATE_DB')
    await db.exec('CREATE TABLE paper_accounts(id INTEGER PRIMARY KEY); INSERT INTO paper_accounts VALUES(2),(3); CREATE TABLE paper_orders(id INTEGER,account_id INTEGER,symbol TEXT,side TEXT,shares REAL,price REAL,commission REAL,tax REAL,note TEXT,created_at TEXT);')
    const response = await mf.dispatchFetch('http://localhost/native-scope')
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), { accounts: [2, 3], credits: [0, 0], after: 1 })
  } finally { await mf.dispose() }
})
