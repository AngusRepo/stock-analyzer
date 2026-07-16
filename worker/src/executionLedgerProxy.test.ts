import assert from 'node:assert/strict'
import { handleExecutionLedgerProxy } from './executionLedgerProxy'


class FakeStatement {
  params: unknown[] = []

  constructor(private readonly db: FakeD1, readonly sql: string) {}

  bind(...params: unknown[]) {
    this.params = params
    return this
  }

  async first<T>() {
    return (this.db.identityValid ? {
      purpose: 'real_trading_execution_only',
      schema_version: 'stockvision-execution-ledger-v1',
      instance_id: this.db.identityInstanceId,
    } : null) as T
  }
}

class FakeD1 {
  identityValid = true
  identityInstanceId = 'execution-instance-test'
  statements: FakeStatement[] = []

  prepare(sql: string) {
    const statement = new FakeStatement(this, sql)
    this.statements.push(statement)
    return statement
  }

  async batch(statements: FakeStatement[]) {
    return statements.map((statement) => ({
      success: true,
      results: statement.sql.startsWith('SELECT') ? [{ ok: 1 }] : [],
      meta: { changes: statement.sql.startsWith('SELECT') ? 0 : 1, served_by_primary: true },
    }))
  }
}

function request(body: unknown, token = 'ledger-token', instanceId = 'execution-instance-test'): Request {
  return new Request('https://execution-ledger.invalid/v1/d1/query', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Execution-Ledger-Instance-ID': instanceId,
    },
    body: JSON.stringify(body),
  })
}

async function main() {
  const unauthorized = await handleExecutionLedgerProxy(
    request({ sql: 'SELECT * FROM broker_execution_intents', params: [] }, 'wrong'),
    { EXECUTION_DB: new FakeD1() as any, EXECUTION_LEDGER_TOKEN: 'ledger-token', EXECUTION_LEDGER_INSTANCE_ID: 'execution-instance-test' },
  )
  assert.equal(unauthorized.status, 401)

  const wrongInstanceHeader = await handleExecutionLedgerProxy(
    new Request('https://execution-ledger.invalid/v1/d1/query', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ledger-token',
        'Content-Type': 'application/json',
        'X-Execution-Ledger-Instance-ID': 'wrong-instance',
      },
      body: JSON.stringify({ sql: 'SELECT * FROM broker_execution_intents', params: [] }),
    }),
    { EXECUTION_DB: new FakeD1() as any, EXECUTION_LEDGER_TOKEN: 'ledger-token', EXECUTION_LEDGER_INSTANCE_ID: 'execution-instance-test' },
  )
  assert.equal(wrongInstanceHeader.status, 403)

  for (const sql of [
    'SELECT * FROM users',
    'DELETE FROM broker_execution_intents',
    'DROP TABLE broker_execution_intents',
    "UPDATE execution_control_state SET kill_switch_active=0 WHERE control_key='live_trading'",
    "UPDATE execution_database_identity SET instance_id='attacker' WHERE identity_key='primary'",
    'SELECT * FROM sqlite_master',
    'SELECT * FROM broker_execution_intents, sqlite_master',
    'SELECT * FROM broker_execution_intents UNION SELECT * FROM "sqlite_master"',
    "SELECT LOAD_EXTENSION('x') FROM broker_execution_intents",
    'UPDATE broker_execution_intents SET status=?; DELETE FROM broker_execution_legs',
  ]) {
    const response = await handleExecutionLedgerProxy(
      request({ sql, params: ['BLOCKED'] }),
      { EXECUTION_DB: new FakeD1() as any, EXECUTION_LEDGER_TOKEN: 'ledger-token', EXECUTION_LEDGER_INSTANCE_ID: 'execution-instance-test' },
    )
    assert.equal(response.status, 400, sql)
  }

  const wrongDb = new FakeD1()
  wrongDb.identityValid = false
  const wrongIdentity = await handleExecutionLedgerProxy(
    request({ sql: 'SELECT * FROM broker_execution_intents', params: [] }),
    { EXECUTION_DB: wrongDb as any, EXECUTION_LEDGER_TOKEN: 'ledger-token', EXECUTION_LEDGER_INSTANCE_ID: 'execution-instance-test' },
  )
  assert.equal(wrongIdentity.status, 503)

  const wrongInstanceDb = new FakeD1()
  wrongInstanceDb.identityInstanceId = 'different-execution-instance'
  const wrongInstance = await handleExecutionLedgerProxy(
    request({ sql: 'SELECT * FROM broker_execution_intents', params: [] }),
    { EXECUTION_DB: wrongInstanceDb as any, EXECUTION_LEDGER_TOKEN: 'ledger-token', EXECUTION_LEDGER_INSTANCE_ID: 'execution-instance-test' },
  )
  assert.equal(wrongInstance.status, 503)

  const unprovisioned = await handleExecutionLedgerProxy(
    request({ sql: 'SELECT * FROM broker_execution_intents', params: [] }, 'ledger-token', 'UNPROVISIONED'),
    { EXECUTION_DB: new FakeD1() as any, EXECUTION_LEDGER_TOKEN: 'ledger-token', EXECUTION_LEDGER_INSTANCE_ID: 'UNPROVISIONED' },
  )
  assert.equal(unprovisioned.status, 503)

  const oversized = await handleExecutionLedgerProxy(
    new Request('https://execution-ledger.invalid/v1/d1/query', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ledger-token',
        'Content-Type': 'application/json',
        'X-Execution-Ledger-Instance-ID': 'execution-instance-test',
      },
      body: JSON.stringify({ sql: 'SELECT * FROM broker_execution_intents', params: ['x'.repeat(513_000)] }),
    }),
    { EXECUTION_DB: new FakeD1() as any, EXECUTION_LEDGER_TOKEN: 'ledger-token', EXECUTION_LEDGER_INSTANCE_ID: 'execution-instance-test' },
  )
  assert.equal(oversized.status, 413)

  const db = new FakeD1()
  const response = await handleExecutionLedgerProxy(
    request({
      batch: [
        {
          sql: "UPDATE broker_execution_legs SET status='SUBMITTING' WHERE leg_id=? RETURNING *",
          params: ['leg-1'],
        },
        {
          sql: 'SELECT * FROM broker_execution_intents WHERE intent_id=?',
          params: ['intent-1'],
        },
      ],
    }),
    { EXECUTION_DB: db as any, EXECUTION_LEDGER_TOKEN: 'ledger-token', EXECUTION_LEDGER_INSTANCE_ID: 'execution-instance-test' },
  )
  assert.equal(response.status, 200)
  const payload = await response.json() as any
  assert.equal(payload.success, true)
  assert.equal(payload.result.length, 2)
  assert.equal(db.statements.length, 3)
  assert.deepEqual(db.statements[1]?.params, ['leg-1'])

  console.log('executionLedgerProxy tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
