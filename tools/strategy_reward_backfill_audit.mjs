import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerDir = join(root, 'worker')
const gcloudCommand = process.platform === 'win32'
  ? 'C:/Users/Wei/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe'
  : 'gcloud'
const gcloudPrefix = process.platform === 'win32'
  ? ['-S', 'C:/Users/Wei/AppData/Local/Google/Cloud SDK/google-cloud-sdk/lib/gcloud.py']
  : []
const npxCommand = process.platform === 'win32' ? process.execPath : 'npx'
const npxPrefix = process.platform === 'win32'
  ? ['C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js']
  : []

function argsMap(argv) {
  const result = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      result._.push(token)
      continue
    }
    const key = token.slice(2).replaceAll('-', '_')
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      result[key] = next
      index += 1
    } else {
      result[key] = true
    }
  }
  return result
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    shell: options.shell === true,
  }).trim()
}

function schedulerAuthorization() {
  const raw = run(gcloudCommand, [
    ...gcloudPrefix, 'scheduler', 'jobs', 'describe', 'evening-chain',
    '--location=asia-east1', '--format=json',
  ])
  const job = JSON.parse(raw)
  const authorization = job?.httpTarget?.headers?.Authorization
  if (typeof authorization !== 'string' || authorization.length < 20) {
    throw new Error('evening-chain scheduler Authorization header unavailable')
  }
  return authorization
}

async function apiJson(path, { method = 'GET', body, confirm = false } = {}) {
  const headers = { Authorization: schedulerAuthorization() }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (confirm) headers['X-Confirm-Strategy-Learning'] = 'true'
  const response = await fetch(`https://stockvision-worker.angus-solo-dev.workers.dev${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch { payload = { raw: text } }
  if (!response.ok) {
    throw new Error(`API ${method} ${path} failed ${response.status}: ${JSON.stringify(payload)}`)
  }
  return payload
}

function wranglerQuery(sql) {
  const raw = run(npxCommand, [
    ...npxPrefix, 'wrangler@4', 'd1', 'execute', 'stockvision-learning-db',
    '--remote', '--json', '--command', sql,
  ], { cwd: workerDir })
  const payload = JSON.parse(raw)
  const first = Array.isArray(payload) ? payload[0] : payload
  if (!first?.success) throw new Error(`D1 query failed: ${raw}`)
  return { results: first.results ?? [], meta: first.meta ?? {} }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function currentGit() {
  return {
    branch: run('git', ['branch', '--show-current']),
    sha: run('git', ['rev-parse', 'HEAD']),
  }
}

function strategyRecords(learning, profiles) {
  const gates = new Map((learning.promotion_gate ?? []).map((row) => [row.strategy_id, row]))
  const profileMap = new Map((profiles.profiles ?? []).map((row) => [row.strategy_id, row]))
  const replacement = learning.replacement_gate ?? {}
  const prefilters = replacement.candidate_prefilters ?? []
  const decisions = replacement.decisions ?? []
  return (learning.specs ?? []).map((spec) => ({
    strategy_id: spec.id,
    strategy_version: spec.version,
    strategy_name: spec.name,
    strategy_status: spec.status,
    alpha_bucket: spec.alphaBucket,
    family_id: spec.familyId,
    promotion_status: spec.promotionStatus,
    supported_regimes: spec.supportedRegimes,
    spec_thresholds: spec.thresholds,
    candidate_policy: spec.candidatePolicy,
    learning: spec.learning,
    promotion_gate: gates.get(spec.id) ?? null,
    evidence_profile: profileMap.get(spec.id) ?? null,
    atomic_v7_candidate_prefilter: prefilters.find((row) => row.strategy_id === spec.id) ?? null,
    atomic_v7_replacement_decisions: decisions.filter((row) => (
      row.candidate_strategy_id === spec.id || row.replaced_strategy_id === spec.id
    )),
  })).sort((left, right) => left.strategy_id.localeCompare(right.strategy_id))
}

function pitAuditSql(rangeStart, rangeEnd, asOfDate) {
  return `
    SELECT m.signal_date,
           m.labeler_version,
           COUNT(*) AS joined_matrix_label_rows,
           SUM(CASE WHEN m.strategy_hit=1 AND m.evaluable=1 THEN 1 ELSE 0 END) AS mature_matched_rows,
           COUNT(DISTINCT m.producer_run_id) AS producer_run_count,
           MIN(l.entry_date) AS min_entry_date,
           MAX(l.exit_date) AS max_exit_date,
           MAX(l.outcome_known_date) AS max_outcome_known_date,
           SUM(CASE WHEN l.outcome_known_date > '${asOfDate}' THEN 1 ELSE 0 END) AS not_known_by_audit_date,
           SUM(CASE WHEN l.entry_date <= m.signal_date THEN 1 ELSE 0 END) AS invalid_entry_timing_rows,
           SUM(CASE WHEN l.outcome_known_date < l.exit_date THEN 1 ELSE 0 END) AS invalid_outcome_timing_rows,
           SUM(CASE WHEN r.strategy_labeler_version <> m.labeler_version THEN 1 ELSE 0 END) AS lineage_mismatch_rows
      FROM strategy_label_matrix_v4 m
      JOIN strategy_label_matrix_runs_v4 mr
        ON mr.producer_run_id=m.producer_run_id
       AND mr.labeler_version=m.labeler_version
       AND mr.status='ready'
      JOIN selection_reference_snapshots_v1 r
        ON r.signal_date=m.signal_date
       AND r.symbol=m.symbol
       AND r.producer_run_id=m.producer_run_id
      JOIN canonical_selection_labels_v4 l
        ON l.signal_date=m.signal_date
       AND l.symbol=m.symbol
       AND l.producer_run_id=m.producer_run_id
     WHERE m.signal_date BETWEEN '${rangeStart}' AND '${rangeEnd}'
       AND m.reference_contract_version='selection-reference-snapshot-v3'
       AND l.label_schema_version='canonical-strategy-selection-label-v4'
     GROUP BY m.signal_date, m.labeler_version
     ORDER BY m.signal_date, m.labeler_version;
  `.replace(/\s+/g, ' ').trim()
}

async function snapshot(options) {
  const phase = String(options.phase ?? '')
  if (!['before', 'after'].includes(phase)) throw new Error('--phase must be before or after')
  const asOfDate = String(options.as_of_date ?? '')
  const rangeStart = String(options.range_start ?? '2026-08-17')
  const rangeEnd = String(options.range_end ?? '2026-08-25')
  const outputDir = resolve(String(options.output_dir ?? 'audits/outbox/2026-09-02-strategy-reward-backfill'))
  const [learning, policy, specs, profiles] = await Promise.all([
    apiJson(`/api/admin/strategy/learning?date=${encodeURIComponent(asOfDate)}`),
    apiJson(`/api/admin/strategy/policy-state?date=${encodeURIComponent(asOfDate)}`),
    apiJson('/api/admin/strategy/specs'),
    apiJson('/api/admin/strategy/evidence-profiles'),
  ])
  const pit = wranglerQuery(pitAuditSql(rangeStart, rangeEnd, asOfDate))
  const records = strategyRecords(learning, profiles)
  const metadata = {
    schema_version: 'strategy-reward-backfill-snapshot-v1',
    phase,
    captured_at: new Date().toISOString(),
    as_of_date: asOfDate,
    replay_range: { start: rangeStart, end: rangeEnd },
    decision_effect: 'read_only_snapshot',
    git: currentGit(),
    strategy_count: records.length,
  }
  const files = {
    [`metadata.${phase}.json`]: metadata,
    [`strategy-learning.${phase}.json`]: learning,
    [`policy-state.${phase}.json`]: policy,
    [`strategy-specs.${phase}.json`]: specs,
    [`evidence-profiles.${phase}.json`]: profiles,
    [`per-strategy.${phase}.json`]: records,
    [`pit-lineage.${phase}.json`]: pit,
  }
  const written = []
  for (const [name, value] of Object.entries(files)) {
    const path = join(outputDir, name)
    writeJson(path, value)
    written.push({ name, sha256: sha256(path) })
  }
  writeJson(join(outputDir, `manifest.${phase}.json`), { ...metadata, artifacts: written })
  console.log(JSON.stringify({ phase, output_dir: outputDir, strategy_count: records.length, pit_dates: pit.results.length }))
}

async function replay(options) {
  const endDate = String(options.end_date ?? '2026-08-25')
  const outputDir = resolve(String(options.output_dir ?? 'audits/outbox/2026-09-02-strategy-reward-backfill'))
  const body = { end_date: endDate, limit: 5000, dry_run: true }
  const dryRun = await apiJson('/api/admin/strategy/reward-ledger/refresh', { method: 'POST', body })
  if (!dryRun.success || dryRun.mode !== 'dry_run' || !(dryRun.source_rows > 0) || !(dryRun.ledger_rows?.length > 0)) {
    throw new Error(`reward dry-run failed safety checks: ${JSON.stringify(dryRun)}`)
  }
  if (dryRun.ledger_rows.some((row) => row.date_end && row.date_end > endDate)) {
    throw new Error('reward dry-run returned data beyond mature frontier')
  }
  writeJson(join(outputDir, 'reward-refresh.dry-run.json'), dryRun)

  const persisted = await apiJson('/api/admin/strategy/reward-ledger/refresh', {
    method: 'POST',
    body: { end_date: endDate, limit: 5000, dry_run: false },
    confirm: true,
  })
  if (!persisted.success || persisted.mode !== 'persisted') {
    throw new Error(`reward persist failed: ${JSON.stringify(persisted)}`)
  }
  if (persisted.persisted_rows !== persisted.ledger_rows?.length || !(persisted.daily_reward_rows > 0) || !(persisted.head_rows > 0)) {
    throw new Error(`reward persist incomplete: ${JSON.stringify(persisted)}`)
  }
  writeJson(join(outputDir, 'reward-refresh.persisted.json'), persisted)
  console.log(JSON.stringify({
    mode: persisted.mode,
    end_date: endDate,
    source_rows: persisted.source_rows,
    persisted_rows: persisted.persisted_rows,
    daily_reward_rows: persisted.daily_reward_rows,
    head_rows: persisted.head_rows,
    refresh_run_id: persisted.refresh_run_id,
  }))
}

function scalar(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function flatten(value, prefix = '', output = {}) {
  if (Array.isArray(value)) {
    output[prefix] = JSON.stringify(value)
    return output
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) flatten(value[key], prefix ? `${prefix}.${key}` : key, output)
    return output
  }
  output[prefix] = value
  return output
}

function escapeCsv(value) {
  const text = scalar(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function metric(row, key) {
  return row?.learning?.[key] ?? null
}

function compare(options) {
  const outputDir = resolve(String(options.output_dir ?? 'audits/outbox/2026-09-02-strategy-reward-backfill'))
  const before = JSON.parse(readFileSync(join(outputDir, 'per-strategy.before.json'), 'utf8'))
  const after = JSON.parse(readFileSync(join(outputDir, 'per-strategy.after.json'), 'utf8'))
  const beforeMap = new Map(before.map((row) => [row.strategy_id, row]))
  const afterMap = new Map(after.map((row) => [row.strategy_id, row]))
  const ids = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()
  const changes = []
  for (const strategyId of ids) {
    const left = flatten(beforeMap.get(strategyId) ?? {})
    const right = flatten(afterMap.get(strategyId) ?? {})
    for (const path of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (JSON.stringify(left[path]) === JSON.stringify(right[path])) continue
      changes.push({ strategy_id: strategyId, path, before: left[path] ?? null, after: right[path] ?? null })
    }
  }
  writeJson(join(outputDir, 'per-strategy-changes.json'), changes)
  const csv = [
    ['strategy_id', 'path', 'before', 'after'].join(','),
    ...changes.map((row) => [row.strategy_id, row.path, row.before, row.after].map(escapeCsv).join(',')),
  ].join('\n') + '\n'
  writeFileSync(join(outputDir, 'per-strategy-changes.csv'), csv, 'utf8')

  const lines = [
    '# Strategy reward backfill before/after', '',
    `- Generated: ${new Date().toISOString()}`,
    `- Strategies: ${ids.length}`,
    `- Changed leaf fields: ${changes.length}`,
    '- PIT rule: frozen decision matrix + same-run reference snapshot + canonical T+5 labels known by audit date.',
    '',
    '| Strategy | Reward date | Samples | Win rate | Avg alpha | Rolling samples | Rolling win rate | Rolling avg alpha | Mature dates | LCB90 |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const id of ids) {
    const left = beforeMap.get(id)
    const right = afterMap.get(id)
    const pair = (key) => `${scalar(metric(left, key))} → ${scalar(metric(right, key))}`
    lines.push(`| ${id} | ${pair('latest_reward_date')} | ${pair('samples')} | ${pair('hit_rate')} | ${pair('avg_return_pct')} | ${pair('rolling_samples')} | ${pair('rolling_hit_rate')} | ${pair('rolling_avg_return_pct')} | ${pair('rolling_reward_dates')} | ${pair('rolling_date_return_lcb90')} |`)
  }
  lines.push('', '完整門檻、Atomic V7、evidence profile 與所有原始數據保存在 `per-strategy.before.json`、`per-strategy.after.json`；逐欄位差異保存在 JSON/CSV。', '')
  writeFileSync(join(outputDir, 'strategy-reward-before-after.md'), lines.join('\n'), 'utf8')
  console.log(JSON.stringify({ output_dir: outputDir, strategy_count: ids.length, changed_leaf_fields: changes.length }))
}

const options = argsMap(process.argv.slice(2))
const command = options._[0]
if (command === 'snapshot') await snapshot(options)
else if (command === 'replay') await replay(options)
else if (command === 'compare') compare(options)
else throw new Error('usage: snapshot|replay|compare [--phase before|after] [--as-of-date YYYY-MM-DD] [--output-dir PATH]')
