/** Original Python candidate evidence -> actual second Hono publication and
 * retirement. All state is private SQLite/KV; synthetic receipts are not ROI. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { adminConfigCoreRoutes } from '../src/routes/adminConfigCoreRoutes'

async function main() {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const RealDate = globalThis.Date
  globalThis.Date = class extends RealDate {
    constructor(value?: any) { super(value === undefined ? input.now : value) }
    static now() { return RealDate.parse(input.now) }
  } as DateConstructor
  try {
    for (const mode of (input.reentry ? ['normal', 'interrupted'] : ['normal', 'missing_ancestor', 'corrupt_ancestor', 'ancestor_race', 'interrupted'])) {
      const sql = new DatabaseSync(':memory:')
      try {
        sql.function('current_timestamp', () => new RealDate(input.now).toISOString().replace('T', ' ').slice(0, 19))
        const entries = Object.entries(input.tables) as [string, any][]
        for (const [, table] of entries) sql.exec(table.schema)
        entries.sort(([a], [b]) => Number(!['model_artifact_registry','active8_ensemble_artifacts_v1'].includes(a))
          - Number(!['model_artifact_registry','active8_ensemble_artifacts_v1'].includes(b)))
        for (const [name, table] of entries) for (const row of table.rows) {
          const keys = Object.keys(row)
          sql.prepare(`INSERT INTO ${name}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
            .run(...keys.map(k => row[k]))
        }
        let before = () => {}, failAt = -1
        const db = { prepare(text: string) {
          const statement = sql.prepare(text)
          let params: any[] = []
          return { bind(...values: any[]) { params = values; return this },
            execute() { statement.run(...params) }, async first() { return statement.get(...params) ?? null },
            async all() { return { results: statement.all(...params) } } }
        }, async batch(statements: any[]) {
          before()
          sql.exec('BEGIN')
          try {
            const results = statements.map((statement, index) => {
              if (index === failAt) throw new Error('fixture_successor_interrupted')
              statement.execute(); return { success: true, results: [], meta: {} }
            })
            sql.exec('COMMIT'); return results
          } catch (error) { sql.exec('ROLLBACK'); throw error }
        } }
        const values = new Map([['trading:config', JSON.stringify(input.trading_config)],
          ['trading:risk_config', JSON.stringify(input.risk_config)]])
        let puts = 0
        const kv = { async get(key: string, type: string) {
          const raw = values.get(key); return raw ? type === 'json' ? JSON.parse(raw) : raw : null
        }, async put(key: string, value: string) { puts++; values.set(key, value) } }
        const request = async (payload = input.payload) => (await adminConfigCoreRoutes.request('/api/admin/config/opb/promote', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private-generations' },
          body: JSON.stringify(payload),
        }, { DB: db, KV: kv, STOCKVISION_AUTH_TOKEN: 'private-generations' } as any)).json() as Promise<any>
        const beforeJournal = sql.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date').all()
        const beforeReview = sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()
        const published = await request()
        assert.equal(published.success, true, JSON.stringify(published))
        assert.equal(published.pointer_committed, true)
        const config = JSON.parse(values.get('trading:config')!)
        assert.equal(config.alphaFramework.allocation.opbArmPrior.artifact_id, input.payload.artifact_id)
        const previousEvent = `opb-nav:${input.prior_payload.artifact_checksum}:${input.prior_payload.prospective_validation.nav_validation.decision_checksum}`
        const first = input.first_history.find((row: any) => row.event_id === previousEvent)
        assert(first, 'original prior publication must exist')
        const parent = sql.prepare('SELECT * FROM model_champion_history WHERE event_id=?').get(first.event_id) as any
        assert.equal(parent.evidence_json, first.evidence_json)
        assert(parent.retired_at)
        if (input.reentry) {
          assert.deepEqual({ ...parent }, first)
          assert.notEqual(input.payload.prospective_validation.nav_validation.decision_checksum,
            input.prior_payload.prospective_validation.nav_validation.decision_checksum)
          assert.equal(input.payload.artifact_checksum, input.prior_payload.artifact_checksum)
          for (const row of input.first_history) assert.deepEqual(
            { ...sql.prepare('SELECT * FROM model_champion_history WHERE event_id=?').get(row.event_id) }, row)
        } else {
          const changes = sql.prepare('SELECT total_changes() n').get()?.n, currentPuts = puts
          const rejected = await request(input.prior_payload)
          assert.equal(rejected.success, false, JSON.stringify(rejected))
          assert.match(JSON.stringify(rejected), /candidate_not_adoptable/)
          assert.equal(sql.prepare('SELECT total_changes() n').get()?.n, changes)
          assert.equal(puts, currentPuts)
        }
        assert.equal(sql.prepare("SELECT COUNT(*) n FROM model_champion_history WHERE model_name='opb_arm_prior' AND retired_at IS NULL").get()?.n, 1)
        const risk = { ...input.risk_config, maxSingleNamePct: input.reentry ? .15 : .20 }
        values.set('trading:risk_config', JSON.stringify(risk))
        if (mode === 'missing_ancestor') sql.prepare('DELETE FROM model_champion_history WHERE event_id=?').run(first.event_id)
        if (mode === 'corrupt_ancestor') sql.prepare("UPDATE model_champion_history SET evidence_json='{}' WHERE event_id=?").run(first.event_id)
        if (mode === 'ancestor_race') before = () => {
          sql.prepare("UPDATE model_champion_history SET evidence_json='{}' WHERE event_id=?").run(first.event_id)
        }
        if (mode === 'interrupted') failAt = 2
        const oldPuts = puts
        let retired = await request()
        if (mode !== 'normal') {
          assert.equal(retired.success, false, JSON.stringify(retired))
          assert.equal(sql.prepare("SELECT champion_artifact_id FROM model_champion_pointers WHERE model_name='opb_arm_prior'").get()?.champion_artifact_id,
            input.payload.artifact_id)
          if (['missing_ancestor','corrupt_ancestor'].includes(mode)) assert.equal(puts, oldPuts)
          if (mode !== 'interrupted') {
            assert.deepEqual(sql.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date').all(), beforeJournal)
            assert.deepEqual(sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all(), beforeReview)
            continue
          }
          failAt = -1
          retired = await request()
        }
        assert.equal(retired.status, 'retired', JSON.stringify(retired))
        assert.equal(retired.retirement.restored_controls.controller, 'SparseTangent')
        assert.equal(retired.retirement.fallback_history.length, input.reentry ? 0 : 1)
        if (!input.reentry) assert.equal(retired.retirement.fallback_history[0].event_id, first.event_id)
        assert.equal(retired.retirement.nav_maturity_credit, 0)
        assert.equal(JSON.parse(values.get('trading:config')!).alphaFramework.allocation.opbArmPrior, undefined)
        assert.deepEqual(JSON.parse(values.get('trading:risk_config')!), risk)
        assert.equal(sql.prepare("SELECT COUNT(*) n FROM model_champion_pointers WHERE model_name='opb_arm_prior'").get()?.n, 0)
        assert.deepEqual(sql.prepare('SELECT * FROM model_champion_history WHERE event_id=?').get(first.event_id), parent)
        const changes = sql.prepare('SELECT total_changes() n').get()?.n, committedPuts = puts
        assert.deepEqual(await request(), retired)
        assert.equal(sql.prepare('SELECT total_changes() n').get()?.n, changes)
        assert.equal(puts, committedPuts)
        assert.deepEqual(sql.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date').all(), beforeJournal)
        assert.deepEqual(sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all(), beforeReview)
        if (input.reentry) for (const row of input.first_history) assert.deepEqual(
          { ...sql.prepare('SELECT * FROM model_champion_history WHERE event_id=?').get(row.event_id) }, row)
        if (mode === 'normal') fs.writeFileSync(process.argv[2] + '.retired.json', JSON.stringify({
          now: input.now, prior_payload: input.payload,
          trading_config: JSON.parse(values.get('trading:config')!),
          risk_config: JSON.parse(values.get('trading:risk_config')!),
          tables: Object.fromEntries(entries.map(([name, table]) => [name, {
            schema: table.schema, rows: sql.prepare(`SELECT * FROM ${name}`).all(),
          }])),
        }))
      } finally { sql.close() }
    }
    console.log(`Original OPB ${input.reentry ? 're-entry' : 'successor'} publication/retirement passed; synthetic, not ROI`)
  } finally { globalThis.Date = RealDate }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
