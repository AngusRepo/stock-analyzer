import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const adminWriteRoutes = fs.readFileSync('src/routes/adminWriteRoutes.ts', 'utf8')
const adminReadRoutes = fs.readFileSync('src/routes/adminReadRoutes.ts', 'utf8')
const entryModelReplay = fs.readFileSync('src/lib/entryModelReplay.ts', 'utf8')
const schema = fs.readFileSync('schema.sql', 'utf8')

assert(
  adminWriteRoutes.includes("/api/admin/entry-model-v2/replay"),
  'Entry Model V2 replay must expose an admin write endpoint for dry-run/persisted replay evidence',
)
assert(
  adminWriteRoutes.includes('X-Confirm-Entry-Model-Replay'),
  'Entry Model V2 replay persistence must require an explicit confirmation header',
)
assert(
  adminWriteRoutes.includes('buildEntryModelReplayReportFromD1'),
  'Entry Model V2 replay route must build the report from D1 evidence',
)
assert(
  adminWriteRoutes.includes('persistEntryModelReplayReport'),
  'Entry Model V2 replay route must be able to persist promotion-gate evidence',
)
assert(
  adminReadRoutes.includes("/api/admin/entry-model-v2/replay/latest"),
  'Entry Model V2 replay must expose a read endpoint for latest replay/promotion-gate report',
)
assert(
  entryModelReplay.includes('CREATE TABLE IF NOT EXISTS entry_model_replay_reports'),
  'Entry Model V2 replay persistence must self-create its D1 table before writes',
)
assert(
  schema.includes('CREATE TABLE IF NOT EXISTS entry_model_replay_reports'),
  'D1 canonical schema must include entry_model_replay_reports',
)
