import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  dataDomainWriterEpochTriggerStatements,
  dataDomainWriterEpochTriggerName,
} from './dataDomainWriterEpoch'

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE data_domain_writer_epochs (
    domain TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL DEFAULT 0,
    writer_state TEXT NOT NULL DEFAULT 'open',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE data_domain_table_writer_epochs (
    domain TEXT NOT NULL,
    table_name TEXT NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(domain, table_name)
  );
  CREATE TABLE sample_ops (id INTEGER PRIMARY KEY, value TEXT);
  INSERT INTO data_domain_writer_epochs(domain, epoch, writer_state)
  VALUES ('ops', 0, 'open');
`)
for (const statement of dataDomainWriterEpochTriggerStatements('ops', ['sample_ops'])) {
  db.exec(statement)
}

db.exec("INSERT INTO sample_ops(id, value) VALUES (1, 'a')")
db.exec("UPDATE sample_ops SET value='b' WHERE id=1")
db.exec('DELETE FROM sample_ops WHERE id=1')
assert.equal(
  (db.prepare("SELECT epoch FROM data_domain_writer_epochs WHERE domain='ops'").get() as any).epoch,
  3,
  'every committed write operation must advance the shared domain epoch',
)
assert.equal(
  (db.prepare("SELECT epoch FROM data_domain_table_writer_epochs WHERE domain='ops' AND table_name='sample_ops'").get() as any).epoch,
  3,
  'every committed write operation must advance the table epoch',
)

db.exec("UPDATE data_domain_writer_epochs SET writer_state='quiescing' WHERE domain='ops'")
assert.throws(
  () => db.exec("INSERT INTO sample_ops(id, value) VALUES (2, 'blocked')"),
  /data_domain_writer_quiescing/,
  'quiescence must reject new source writes before final parity and route CAS',
)
assert.equal(
  (db.prepare("SELECT epoch FROM data_domain_writer_epochs WHERE domain='ops'").get() as any).epoch,
  3,
  'rejected writes must not advance the epoch',
)

assert.equal(
  dataDomainWriterEpochTriggerName('ops', 'sample_ops', 'insert'),
  'trg_dd_epoch_ops_sample_ops_insert',
)
assert.throws(
  () => dataDomainWriterEpochTriggerStatements('ops', ['unsafe-table']),
  /data_domain_writer_epoch_identifier_invalid/,
)

for (const file of [
  'migrations/0113_data_domain_writer_epoch_fence.sql',
  'domain-migrations/ops/0003_data_domain_writer_epoch_fence.sql',
]) {
  const sql = fs.readFileSync(file, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS data_domain_writer_epochs/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS data_domain_table_writer_epochs/)
}
