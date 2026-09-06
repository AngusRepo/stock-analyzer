import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { metricWriteStatements } from './strategyEvidenceMetrics'

async function main() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE strategy_evidence_metric_snapshot_runs_v1(snapshot_run_id TEXT PRIMARY KEY,payload_checksum TEXT);
    CREATE TABLE strategy_evidence_metrics_v1(strategy_id TEXT,strategy_version TEXT,strategy_status TEXT,alpha_bucket TEXT,
    primary_horizon_days INTEGER,metric_name TEXT,metric_value REAL,metric_status TEXT,sample_count INTEGER,mature_dates INTEGER,
    date_start TEXT,date_end TEXT,outcome_as_of_date TEXT,definition_version TEXT,evidence_json TEXT,updated_at TEXT,
    PRIMARY KEY(strategy_id,strategy_version,primary_horizon_days,metric_name,outcome_as_of_date));
    INSERT INTO strategy_evidence_metric_snapshot_runs_v1 VALUES ('original','abc');`)
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: any[]) {
          return { async run() { return sqlite.prepare(sql).run(...values) } }
        },
      }
    },
  } as unknown as D1Database
  const row={strategy_id:'s8',strategy_version:'v1',strategy_status:'active',alpha_bucket:'test',primary_horizon_days:5,
    metric_name:'rank_ic',metric_value:0.2,metric_status:'ready',sample_count:50,mature_dates:4,date_start:'2026-08-25',
    date_end:'2026-08-28',outcome_as_of_date:'2026-09-04',definition_version:'v4',evidence_json:'{}'} as any
  for (const statement of metricWriteStatements(db,[row],'original','abc')) await statement.run()
  assert.equal(sqlite.prepare('SELECT metric_value FROM strategy_evidence_metrics_v1').get()!.metric_value,0.2)
  for (const statement of metricWriteStatements(db,[{...row,metric_value:-0.4}],'conflicting-replay','def')) await statement.run()
  assert.equal(sqlite.prepare('SELECT metric_value FROM strategy_evidence_metrics_v1').get()!.metric_value,0.2,
    'a conflicting immutable receipt must not change published metric values')
  sqlite.exec("INSERT INTO strategy_evidence_metric_snapshot_runs_v1 VALUES ('restated-today','def')")
  for (const statement of metricWriteStatements(db,[{...row,outcome_as_of_date:'2026-09-06',metric_value:-0.4}],'restated-today','def')) await statement.run()
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM strategy_evidence_metrics_v1').get()!.n,2)
  sqlite.close()
  console.log('strategyEvidenceMetricSnapshotAtomic: PASS')
}
main().catch(error=>{console.error(error);process.exitCode=1})
