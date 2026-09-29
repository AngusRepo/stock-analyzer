import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { test } from 'node:test'
import { buildAuditJsonCompareAndSwap } from './auditJsonArchive'

type Target = Parameters<typeof buildAuditJsonCompareAndSwap>[0]
const targets: Target[] = [
  { id: 'strategy_decision_log', table: 'strategy_decision_log', dateColumn: 'date', keyColumn: 'decision_id',
    selectedColumns: ['decision_id','date','symbol','name','strategy_id','strategy_version','strategy_status',
      'alpha_bucket','matched','match_score','reason_code','context_json','evidence_json','created_at'],
    blobColumns: ['context_json','evidence_json'] },
  ...(['screener_funnel_items','canonical_screener_funnel_items'] as const).map(id => ({
    id, table: 'screener_funnel_items' as const, dateColumn: 'date', keyColumn: 'id',
    selectedColumns: ['id','run_id','date','symbol','name','stage','decision','reason_code','score_before',
      'score_after','rank','evidence','created_at'], blobColumns: ['evidence'],
  })),
  { id: 'paper_execution_events', table: 'paper_execution_events', dateColumn: 'trade_date', keyColumn: 'id',
    selectedColumns: ['id','account_id','trade_date','symbol','side','event_type','status','reason','detail_json',
      'order_id','pending_run_id','source','created_at'], blobColumns: ['detail_json'] },
]

// Frozen pre-fix scrub query, including every original-value and eligibility check.
function previousQuery(target: Target): string {
  const key = `json_extract(b.value,'$.original.${target.keyColumn}') IS ${target.table}.${target.keyColumn}`
  const same = target.selectedColumns.map(c => `json_extract(b.value,'$.original.${c}') IS ${target.table}.${c}`).join(' AND ')
  const set = target.blobColumns.map(c => `${c}=(SELECT json_extract(b.value,'$.pointers.${c}') FROM backed_up b WHERE ${key})`).join(',')
  const canonical = `EXISTS (SELECT 1 FROM canonical_run_heads h WHERE h.run_id = screener_funnel_items.run_id)`
  const latest = `COALESCE((SELECT latest.run_id FROM screener_funnel_runs latest
    WHERE latest.date = screener_funnel_items.date AND latest.status = 'success'
    ORDER BY latest.created_at DESC LIMIT 1), '')`
  const eligibility = target.id === 'strategy_decision_log'
    ? 'strategy_decision_log.context_id IS NOT NULL AND strategy_decision_log.evidence_artifact_id IS NOT NULL'
    : target.id === 'canonical_screener_funnel_items' ? `(${canonical} OR screener_funnel_items.run_id = ${latest})`
      : target.id === 'screener_funnel_items' ? `NOT ${canonical} AND screener_funnel_items.run_id <> ${latest}` : '1=1'
  return `WITH backed_up AS MATERIALIZED (SELECT value FROM json_each(?)) UPDATE ${target.table} SET ${set}
    WHERE ${target.dateColumn}<? AND (${eligibility}) AND EXISTS(SELECT 1 FROM backed_up b WHERE ${key} AND ${same})`
}

function fixture(target: Target) {
  const db = new DatabaseSync(':memory:')
  for (const [domain,tables] of [['learning',['strategy_decision_log']],
    ['ops',['screener_funnel_items','screener_funnel_runs','canonical_run_heads']],
    ['paper',['paper_execution_events']]] as const) {
    const schema = readFileSync(`domain-schemas/${domain}.sql`, 'utf8')
    for (const table of tables) {
      const ddl = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
      assert.ok(ddl); db.exec(ddl[0])
      const indices = [...schema.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? [\s\S]*?;/g)]
        .map(match => match[0]).filter(sql => new RegExp(`\\bON\\s+${table}\\s*\\(`,'i').test(sql))
      for (const sql of indices) db.exec(sql)
    }
  }
  db.exec(`CREATE INDEX scrub_date ON ${target.table}(${target.dateColumn});
    INSERT INTO screener_funnel_runs(run_id,date,status,created_at) VALUES('obsolete','2026-01-01','success','2026-01-01');
    INSERT INTO screener_funnel_runs(run_id,date,status,created_at) VALUES('canonical','2026-01-01','success','2026-01-02');
    INSERT INTO canonical_run_heads(logical_run_key,run_id,promoted_at) VALUES('head','canonical','2026-01-02')`)
  const blob = JSON.stringify({ original: '證據😀"\\', unchanged: true })
  db.exec('BEGIN')
  for (let i=1;i<=6000;i++) {
    if (target.id==='strategy_decision_log') db.prepare(`INSERT INTO strategy_decision_log
      (decision_id,date,symbol,strategy_id,strategy_version,strategy_status,alpha_bucket,matched,reason_code,context_json,evidence_json,context_id,evidence_artifact_id)
      VALUES(?,'2026-01-01',?,'s','v1','active','trend',1,'matched',?,?,'ctx','artifact')`)
      .run(`d${String(i).padStart(6,'0')}`,String(i),blob,blob)
    else if (target.id==='paper_execution_events') db.prepare(`INSERT INTO paper_execution_events
      (id,trade_date,symbol,side,event_type,status,detail_json) VALUES(?,'2026-01-01',?,'buy','entry','completed',?)`).run(i,String(i),blob)
    else db.prepare(`INSERT INTO screener_funnel_items(id,run_id,date,symbol,stage,decision,reason_code,evidence)
      VALUES(?,?,'2026-01-01',?,'L3','pass','ok',?)`).run(i,target.id==='canonical_screener_funnel_items'?'canonical':'obsolete',String(i),blob)
  }
  db.exec('COMMIT')
  const rows = db.prepare(`SELECT ${target.selectedColumns.join(',')} FROM ${target.table}
    ORDER BY ${target.keyColumn} LIMIT 20`).all() as Record<string, SQLInputValue>[]
  return {db,rows}
}

test('nullable TEXT primary key retains the previous IS match semantics', () => {
  const target = targets[0]
  const {db} = fixture(target)
  try {
    db.exec(`INSERT INTO strategy_decision_log
      (decision_id,date,symbol,strategy_id,strategy_version,strategy_status,alpha_bucket,matched,reason_code,context_json,evidence_json,context_id,evidence_artifact_id)
      VALUES(NULL,'2026-01-01','nullable','s','v1','active','trend',1,'matched','original context','original evidence','ctx','artifact')`)
    const rows = db.prepare(`SELECT ${target.selectedColumns.join(',')} FROM strategy_decision_log WHERE decision_id IS NULL`).all()
    assert.equal(rows.length,1)
    const candidate = buildAuditJsonCompareAndSwap(target,rows,()=>'{"archived_to_r2":true}')
    const execute = (sql:string) => {
      db.exec('BEGIN')
      try {
        const changes = Number(db.prepare(sql).run(candidate.rowsJson,'2026-06-01').changes)
        return {changes,rows:db.prepare('SELECT * FROM strategy_decision_log ORDER BY decision_id').all()}
      } finally {db.exec('ROLLBACK')}
    }
    const expected = execute(previousQuery(target))
    assert.equal(expected.changes,1)
    assert.deepEqual(execute(candidate.sql),expected)
  } finally {db.close()}
})

for (const target of [targets[0],targets[2]]) {
  test(`${target.id}: changed source eligibility prevents scrub after archive`, () => {
    const {db,rows} = fixture(target)
    try {
      const original = rows[0]
      const candidate = buildAuditJsonCompareAndSwap(target,[original],()=>'{"archived_to_r2":true}')
      if (target.id==='strategy_decision_log') {
        db.prepare('UPDATE strategy_decision_log SET context_id=NULL,evidence_artifact_id=NULL WHERE decision_id=?')
          .run(original.decision_id)
      } else {
        db.exec(`INSERT INTO screener_funnel_runs(run_id,date,status,created_at)
          VALUES('replacement','2026-01-01','success','2026-01-03');
          UPDATE canonical_run_heads SET run_id='replacement' WHERE logical_run_key='head'`)
      }
      const expected = db.prepare(previousQuery(target)).run(candidate.rowsJson,'2026-06-01')
      const actual = db.prepare(candidate.sql).run(candidate.rowsJson,'2026-06-01')
      assert.equal(Number(expected.changes),0)
      assert.equal(Number(actual.changes),0)
      const stored = db.prepare(`SELECT ${target.blobColumns.join(',')} FROM ${target.table} WHERE ${target.keyColumn}=?`)
        .get(original[target.keyColumn])!
      for (const column of target.blobColumns) assert.equal(stored[column],original[column])
    } finally {db.close()}
  })
}

for (const target of targets) for (const changed of [false,true]) {
  test(`${target.id}: bounded primary-key scrub preserves exact output${changed?' with concurrent revisions':''}`, () => {
    const {db,rows} = fixture(target)
    try {
      const pointer = (_row: Record<string,unknown>, column: string) => JSON.stringify({archived_to_r2:true,column})
      const candidate = buildAuditJsonCompareAndSwap(target,rows,pointer)
      if (changed) {
        db.prepare(`UPDATE ${target.table} SET symbol='revised-symbol' WHERE ${target.keyColumn}=?`).run(rows[1][target.keyColumn])
        db.prepare(`UPDATE ${target.table} SET ${target.blobColumns[0]}='newer evidence' WHERE ${target.keyColumn}=?`).run(rows[2][target.keyColumn])
        db.prepare(`UPDATE ${target.table} SET ${target.dateColumn}='2026-12-01' WHERE ${target.keyColumn}=?`).run(rows[3][target.keyColumn])
      }
      const plan = db.prepare('EXPLAIN QUERY PLAN '+candidate.sql).all(candidate.rowsJson,'2026-06-01')
        .map(r=>String(r.detail))
      assert.ok(plan.some(p=>p.startsWith(`SEARCH ${target.table} `) &&
        (p.includes(`(${target.keyColumn}=?)`) || p.includes('(rowid=?)'))),JSON.stringify(plan))
      assert.ok(!plan.some(p=>p.startsWith(`SCAN ${target.table}`) || p.includes('USING INDEX scrub_date')),JSON.stringify(plan))
      function execute(sql: string) {
        db.exec('BEGIN')
        try {
          const changes = Number(db.prepare(sql).run(candidate.rowsJson,'2026-06-01').changes)
          const result = db.prepare(`SELECT * FROM ${target.table} ORDER BY ${target.keyColumn}`).all()
          return {changes,result}
        } finally { db.exec('ROLLBACK') }
      }
      const expected = execute(previousQuery(target))
      const actual = execute(candidate.sql)
      assert.equal(actual.changes,changed?17:20)
      assert.deepEqual(actual,expected)
      if(changed) assert.equal(actual.result[2][target.blobColumns[0]],'newer evidence')
    } finally {db.close()}
  })
}
