import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import fs from 'node:fs'
import { alertPointerChanges, alertPointerChangesGuarded } from './pointerChangeAlert'

test('pointer changes in the last week are logged once each; older ones are not', async () => {
  const f = l4NativeFixture(); f.ports.nowMs = Date.parse('2026-10-30T06:20:00Z')   // D1 'now' follows the fixture clock
  try {
    const learning = f.sqls.learning
    learning.exec(`CREATE TABLE IF NOT EXISTS model_champion_pointers (model_name TEXT PRIMARY KEY, champion_version TEXT NOT NULL,
      champion_artifact_id TEXT, rollback_version TEXT, rollback_artifact_id TEXT, promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      promotion_reason TEXT, promotion_evidence_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS active8_ensemble_pointer_v1 (singleton_id INTEGER PRIMARY KEY, artifact_id TEXT NOT NULL,
      cohort_id TEXT NOT NULL, payload_checksum TEXT NOT NULL, base_artifact_set_checksum TEXT NOT NULL,
      promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, promotion_reason TEXT NOT NULL, promotion_evidence_json TEXT NOT NULL DEFAULT '{}')`)
    learning.exec(`DELETE FROM model_champion_pointers; DELETE FROM active8_ensemble_pointer_v1;
      INSERT INTO model_champion_pointers(model_name,champion_version,champion_artifact_id,promotion_reason,promoted_at,updated_at)
        VALUES('GNN','GNN-v2','GNN:c2','r33_cutover','2026-10-29 06:00:00','2026-10-29 06:00:00'),
              ('TabM','TabM-v1','TabM:c1','old','2026-10-01 00:00:00','2026-10-01 00:00:00'),
              ('PatchTST','PatchTST-v1','PatchTST:c1','repaired','2026-09-20 00:00:00','2026-10-20 00:00:00');
      INSERT INTO active8_ensemble_pointer_v1 VALUES(1,'r33-roster:c2:abc','c2','${'a'.repeat(64)}','${'b'.repeat(64)}',
        '2026-10-30 04:00:00','r33_cutover','{}')`)
    assert.deepEqual(await alertPointerChanges(f.env), { changes: 3, logged: 3 })
    assert.deepEqual(await alertPointerChanges(f.env), { changes: 3, logged: 0 })
    const rows = f.sqls.ops.prepare("SELECT level,message FROM system_logs WHERE cron_name='pointer-change' ORDER BY id").all() as any[]
    assert.equal(rows.length, 3)
    assert.ok(rows.every(r => r.level === 'warn'))
    assert.match(rows[0].message, /^pointer changed: champion:GNN -> GNN:c2 \(GNN-v2\) at /)
    assert.match(rows[1].message, /^pointer changed: champion:PatchTST -> PatchTST:c1/)   // updated_at only
    assert.match(rows[2].message, /^pointer changed: ensemble -> r33-roster:c2:abc/)
  } finally { f.close() }
})


test('the post-close guard never throws or waits past its timeout, and the task calls it before dispatch', async () => {
  const broken = { MULTI_D1_ACTIVE_DOMAINS: 'learning', MULTI_D1_STRICT: 'true' } as any   // no LEARNING_DB binding
  assert.equal(await alertPointerChangesGuarded(broken), null)
  const hanging = { DB: { prepare: () => ({ bind: () => ({ all: () => new Promise(() => {}) }) }) } } as any
  assert.equal(await alertPointerChangesGuarded(hanging, 5), null)
  const task = fs.readFileSync(new URL('./adminTriggerWorkerDomainTasks.ts', import.meta.url), 'utf8')
  const body = task.slice(task.indexOf("'postclose-research-dispatch': async"), task.indexOf("'daily-snapshot'"))
  assert.ok(body.indexOf('alertPointerChangesGuarded(c.env)') > 0)
  assert.ok(body.indexOf('alertPointerChangesGuarded(c.env)') < body.indexOf('return runPostcloseResearch('))
  assert.match(body, /\.catch\(/)
})
