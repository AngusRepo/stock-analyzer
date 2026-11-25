import assert from 'node:assert/strict'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { fixtureQuality } from './riskProtocol.testSupport'
import { storedRiskV2Drift, storedRiskV2FromQuality } from './marketRiskStressV2'
import { runStoredRiskV2DriftCheck } from './marketRiskMaterialization'
import { DEFAULT_RISK_CONFIG } from './riskConfig'
import { canonicalRiskJson, riskPacketChecksum } from './riskPacketCodec'

// A stored v2 row must equal a recompute of its quality receipt under the KV policy echoed in it.
const portfolio = DEFAULT_RISK_CONFIG.portfolio
const altPortfolio = { ...portfolio, riskLevelThresholds: { ...portfolio.riskLevelThresholds, storedV2: [1, 2, 3, 4] as [number, number, number, number] } }
const inputs = { vix: 22, twiiVol20: 19, twiiBias: -4, foreignConsecutiveSell: -2, foreignNet5d: -10, marginRatio: 3.75, adlTrend: 'down', bullAlignmentPct: 25 }

async function storedRow(date: string, quality: any, written: typeof portfolio, updatedAt = date + 'T14:05:00Z') {
  const stress = storedRiskV2FromQuality(JSON.parse(quality.json), written)!
  return { date, schema_version: stress.schema_version, status: stress.status, score: stress.score, calibrated_score: stress.calibrated_score,
    level: stress.level, quality_checksum: quality.checksum, json: canonicalRiskJson(stress), checksum: await riskPacketChecksum(stress), updated_at: updatedAt }
}

void (async () => {
  const quality = fixtureQuality('2026-09-14', 40, 30000, 30000, undefined, inputs)
  const qualityRow = { date: '2026-09-14', json: quality.json, checksum: quality.checksum }
  const clean = await storedRow('2026-09-14', quality, portfolio)
  const ok = await storedRiskV2Drift(clean, qualityRow, portfolio)
  assert.deepEqual(ok.mismatches, []); assert.equal(ok.ok, true); assert.equal(ok.policyChanged, false); assert.equal(ok.currentLevel, clean.level)

  // Written under an older KV: recomputes under the echoed policy (no drift) but reports the policy change.
  const older = await storedRow('2026-09-14', quality, altPortfolio)
  const olderDrift = await storedRiskV2Drift(older, qualityRow, portfolio)
  assert.equal(olderDrift.ok, true); assert.equal(olderDrift.policyChanged, true)
  assert.equal(older.level, 'black'); assert.equal(olderDrift.currentLevel, clean.level)

  // Column edited without the json: column and checksum agree no more.
  const edited = await storedRiskV2Drift({ ...clean, level: clean.level === 'red' ? 'green' : 'red' }, qualityRow, portfolio)
  assert.equal(edited.ok, false); assert.ok(edited.mismatches.includes('column_level'))

  // Json rewritten with a consistent checksum but a score its receipt does not produce: recompute mismatch.
  const forged = JSON.parse(clean.json); forged.score = forged.score + 1
  const forgedRow = { ...clean, score: forged.score, json: canonicalRiskJson(forged), checksum: await riskPacketChecksum(forged) }
  const forgedDrift = await storedRiskV2Drift(forgedRow, qualityRow, portfolio)
  assert.deepEqual(forgedDrift.mismatches, ['recompute_score'])

  // Receipt changed after the v2 row was written.
  const otherQuality = fixtureQuality('2026-09-14', 40, 30000, 30000, undefined, { ...inputs, vix: 45 })
  const stale = await storedRiskV2Drift(clean, { date: '2026-09-14', json: otherQuality.json, checksum: otherQuality.checksum }, portfolio)
  assert.equal(stale.ok, false); assert.ok(stale.mismatches.includes('quality_checksum')); assert.ok(stale.mismatches.includes('recompute_score'))
  assert.deepEqual((await storedRiskV2Drift(clean, null, portfolio)).mismatches, ['quality_missing'])

  // Nightly scan over D1: SEARCH by date range; receipts written before v2 existed are skipped.
  const f = l4NativeFixture()
  try {
    const core = f.sqls.core
    const putQuality = (date: string, q: any, updatedAt: string) => core.prepare('INSERT OR REPLACE INTO market_risk_quality_v1(date,schema_version,status,known_score,upper_score,json,checksum,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(date, q.schema_version, q.status, q.known_score, q.upper_score, q.json, q.checksum, updatedAt)
    const putStress = (row: any) => core.prepare('INSERT OR REPLACE INTO market_risk_stress_v2(date,schema_version,status,score,calibrated_score,level,quality_checksum,json,checksum,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(row.date, row.schema_version, row.status, row.score, row.calibrated_score, row.level, row.quality_checksum, row.json, row.checksum, row.updated_at)
    const dates = ['2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15']
    const receipts = Object.fromEntries(dates.map(d => [d, fixtureQuality(d, 40, 30000, 30000, undefined, inputs)]))
    putQuality('2026-09-10', receipts['2026-09-10'], '2026-09-10T14:00:00Z')         // before v2 existed, no row
    for (const d of dates.slice(1)) putQuality(d, receipts[d], d + 'T14:00:00Z')
    putStress(await storedRow('2026-09-11', receipts['2026-09-11'], altPortfolio, '2026-09-11T14:00:00Z'))
    putStress(await storedRow('2026-09-14', receipts['2026-09-14'], portfolio, '2026-09-14T14:00:00Z'))
    putStress(await storedRow('2026-09-15', receipts['2026-09-15'], portfolio, '2026-09-15T14:00:00Z'))
    const plan = core.prepare(`EXPLAIN QUERY PLAN SELECT q.date AS q_date,q.json AS q_json,q.checksum AS q_checksum,q.updated_at AS q_updated_at,s.*
      FROM market_risk_quality_v1 q LEFT JOIN market_risk_stress_v2 s ON s.date=q.date WHERE q.date>=? ORDER BY q.date`).all('2026-09-01') as any[]
    assert.ok(plan.every(step => !/^SCAN/.test(step.detail)), JSON.stringify(plan))
    const pass = await runStoredRiskV2DriftCheck(f.env.CORE_DB, portfolio, '2026-09-01')
    assert.equal(pass.ok, true, pass.summary); assert.deepEqual(pass.policyChanged, ['2026-09-11'])
    assert.match(pass.summary, /checked=3 skipped_pre_v2=1 failed=0 policy_changed=1/)
    core.prepare('DELETE FROM market_risk_stress_v2 WHERE date=?').run('2026-09-14')
    core.prepare('UPDATE market_risk_stress_v2 SET level=? WHERE date=?').run('green', '2026-09-15')
    const fail = await runStoredRiskV2DriftCheck(f.env.CORE_DB, portfolio, '2026-09-01')
    assert.equal(fail.ok, false)
    assert.deepEqual(fail.failures.map(item => [item.date, item.mismatches[0]]), [['2026-09-14', 'row_missing'], ['2026-09-15', 'column_level']])
    await assert.rejects(runStoredRiskV2DriftCheck(f.env.CORE_DB, portfolio, "2026-09-01' OR 1"), /since_invalid/)
    // v2 went live but no row lands in the window any more: a drift, not a silent pass.
    const stopped = await runStoredRiskV2DriftCheck(f.env.CORE_DB, portfolio, '2026-09-15')
    assert.equal(stopped.ok, false)
    core.prepare('DELETE FROM market_risk_stress_v2 WHERE date=?').run('2026-09-15')
    const later = await runStoredRiskV2DriftCheck(f.env.CORE_DB, portfolio, '2026-09-14')
    assert.equal(later.ok, false); assert.deepEqual(later.failures[0].mismatches, ['v2_rows_stopped'])
    const maxPlan = core.prepare('EXPLAIN QUERY PLAN SELECT MAX(date) AS date FROM market_risk_stress_v2').all() as any[]
    assert.ok(maxPlan.every(step => !/^SCAN/.test(step.detail)), JSON.stringify(maxPlan))
    core.prepare('DELETE FROM market_risk_stress_v2').run()
    const never = await runStoredRiskV2DriftCheck(f.env.CORE_DB, portfolio, '2026-09-01')
    assert.equal(never.ok, true, 'v2 never live: receipts are pre-v2')
    console.log('marketRiskStressV2 drift tests passed')
  } finally {
    f.close()
  }
})().catch(error => { console.error(error); process.exit(1) })
