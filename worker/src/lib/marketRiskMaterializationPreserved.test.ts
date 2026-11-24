import assert from 'node:assert/strict'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { fixtureQuality } from './riskProtocol.testSupport'
import { recomputeDailyMarketRisk } from './marketRiskMaterialization'
import { DEFAULT_RISK_CONFIG, FAIL_CLOSED_RISK_CONFIG, getRiskConfig, normalizeRiskConfig, riskConfigUnavailable } from './riskConfig'
import { marketRiskLevelPolicy, storedRiskV2Drift } from './marketRiskStressV2'

// Backfill (preserved) path: a complete receipt for a past date is kept as is; v2 and the packet are rebuilt
// from it under the current KV and read back. A missing / unreadable trading:risk_config writes nothing.
const date = '2026-09-11'
const inputs = { vix: 22, twiiClose: 30000, twiiVol20: 19, twiiBias: -4, foreignConsecutiveSell: -2, foreignNet5d: -10,
  marginRatio: 3.75, adlTrend: 'down', bullAlignmentPct: 25 }
const counts = (f: ReturnType<typeof l4NativeFixture>) => ({
  risk: (f.sqls.core.prepare('SELECT COUNT(*) AS n FROM market_risk').get() as any).n,
  quality: (f.sqls.core.prepare('SELECT COUNT(*) AS n FROM market_risk_quality_v1 WHERE date=?').get(date) as any).n,
  v2: (f.sqls.core.prepare('SELECT COUNT(*) AS n FROM market_risk_stress_v2').get() as any).n,
  packet: (f.sqls.market.prepare('SELECT COUNT(*) AS n FROM market_regime_factor_packets WHERE date=?').get(date) as any).n,
})

void (async () => {
  // The fail-closed config is marked, scores nothing and cannot be forged from KV.
  assert.equal(riskConfigUnavailable(FAIL_CLOSED_RISK_CONFIG), true)
  assert.equal(marketRiskLevelPolicy(FAIL_CLOSED_RISK_CONFIG.portfolio), null)
  assert.equal(riskConfigUnavailable(await getRiskConfig({ get: async () => null } as any)), true)
  assert.equal(riskConfigUnavailable(await getRiskConfig({ get: async () => { throw new Error('kv_down') } } as any)), true)
  // Malformed KV values are unavailable too: [] and a portfolio that is not an object never score with defaults.
  for (const raw of [[], [1], 'x', { system: { killSwitch: false } }, { portfolio: 'x' }, { portfolio: [1] }]) {
    const cfg = await getRiskConfig({ get: async () => raw } as any)
    assert.equal(riskConfigUnavailable(cfg), true, JSON.stringify(raw)); assert.equal(marketRiskLevelPolicy(cfg.portfolio), null)
  }
  assert.equal(riskConfigUnavailable(await getRiskConfig({ get: async () => ({ portfolio: {} }) } as any)), false)
  // The admin repair view reports the same availability as the runtime.
  assert.equal(normalizeRiskConfig({ system: { killSwitch: false } }).portfolio.configUnavailable, true)
  assert.equal(normalizeRiskConfig({ portfolio: {} }).portfolio.configUnavailable, undefined)
  const forged = await getRiskConfig({ get: async () => ({ portfolio: { configUnavailable: true } }) } as any)
  assert.equal(riskConfigUnavailable(forged), false); assert.equal(forged.portfolio.configUnavailable, undefined)

  const f = l4NativeFixture()
  try {
    const q = fixtureQuality(date, 40, 30000, 29900, undefined, inputs)
    f.sqls.core.prepare('INSERT OR REPLACE INTO market_risk_quality_v1(date,schema_version,status,known_score,upper_score,json,checksum,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(date, q.schema_version, q.status, 40, 40, q.json, q.checksum, date + 'T14:00:00Z')
    f.sqls.core.prepare(`INSERT INTO market_risk(date,vix,twii_close,twii_vol20,twii_ma20,twii_bias,foreign_consecutive_sell,foreign_net_5d,
      margin_ratio,risk_score,risk_level,adl_trend,bull_alignment_pct) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(date, 22, 30000, 19, 31250, -4, -2, -10, 3.75, 40, 'yellow', 'down', 25)

    // KV present but an invalid level policy / factor packet policy: rejected before any write.
    const kv = f.env.KV
    const D = DEFAULT_RISK_CONFIG.portfolio
    f.kvs.set('trading:risk_config', JSON.stringify({ ...DEFAULT_RISK_CONFIG,
      portfolio: { ...D, riskLevelThresholds: { ...D.riskLevelThresholds, storedV2: [90, 10, 50, 20] } } }))
    await assert.rejects(recomputeDailyMarketRisk(f.env, date), /market_risk_level_policy_invalid/)
    f.kvs.set('trading:risk_config', JSON.stringify({ ...DEFAULT_RISK_CONFIG,
      portfolio: { ...D, factorPacketPolicy: { ...D.factorPacketPolicy, missingScore: 200 } } }))
    await assert.rejects(recomputeDailyMarketRisk(f.env, date), /factor_packet_policy_invalid/)
    assert.deepEqual(counts(f), { risk: 1, quality: 1, v2: 0, packet: 0 })

    // KV missing or unreadable: never a v2 row; the packet is rebuilt as main did but flagged as built on
    // built-in defaults (runtime: new risk blocked, de-risk kept); the receipt and v1 row stay untouched.
    const packetLineage = () => JSON.parse((f.sqls.market.prepare('SELECT lineage_json FROM market_regime_factor_packets WHERE date=?').get(date) as any).lineage_json)
    f.kvs.delete('trading:risk_config')
    const missing = await recomputeDailyMarketRisk(f.env, date)
    assert.equal(missing.risk_config_unavailable, true); assert.equal(missing.quality_checksum, q.checksum)
    assert.deepEqual(counts(f), { risk: 1, quality: 1, v2: 0, packet: 1 })
    assert.equal(packetLineage().risk_config, 'unavailable_builtin_defaults')
    f.env.KV = { ...kv, get: async (key: string, type?: string) => { if (key === 'trading:risk_config') throw new Error('kv_down'); return kv.get(key, type) } }
    assert.equal((await recomputeDailyMarketRisk(f.env, date)).risk_config_unavailable, true)
    assert.deepEqual(counts(f), { risk: 1, quality: 1, v2: 0, packet: 1 })
    f.env.KV = kv

    // With KV present the preserved path writes v2 + packet and leaves the receipt and v1 row untouched.
    f.kvs.set('trading:risk_config', JSON.stringify(DEFAULT_RISK_CONFIG))
    const riskBefore = f.sqls.core.prepare('SELECT * FROM market_risk WHERE date=?').get(date)
    const result = await recomputeDailyMarketRisk(f.env, date)
    assert.equal(result.quality_checksum, q.checksum); assert.equal(result.quality_status, 'complete')
    assert.deepEqual(f.sqls.core.prepare('SELECT * FROM market_risk WHERE date=?').get(date), riskBefore)
    assert.deepEqual(counts(f), { risk: 1, quality: 1, v2: 1, packet: 1 })
    assert.equal(packetLineage().risk_config, undefined, 'a KV-backed rerun replaces the flagged packet')
    assert.equal(result.risk_config_unavailable, false)
    const row: any = f.sqls.core.prepare('SELECT * FROM market_risk_stress_v2 WHERE date=?').get(date)
    assert.equal(row.quality_checksum, q.checksum)
    const drift = await storedRiskV2Drift(row, { date, json: q.json, checksum: q.checksum }, DEFAULT_RISK_CONFIG.portfolio)
    assert.equal(drift.ok, true, JSON.stringify(drift)); assert.equal(drift.policyChanged, false)
    // VOL max(vix 22 -> 15/35, vol20 19 -> 6/20) x35 = 15; TREND |bias| 4 -> 3/15 x15 = 3; FLOW net sell -> 1 x20 = 20;
    // LEV 0.5 x0 = 0; BREADTH adl down -> 1 x8 = 8. 46 / 78 x100 = 59.0 -> orange (56.4 < 59 <= 73.1).
    assert.equal(row.score, 59); assert.equal(row.level, 'orange'); assert.equal(row.status, 'complete')
    console.log('market risk preserved path + fail-closed config tests passed')
  } finally {
    f.close()
  }
})().catch(error => { console.error(error); process.exit(1) })
