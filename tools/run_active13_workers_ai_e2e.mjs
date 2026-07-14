import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const ACCOUNT_ID = '619a83ac9f20847d9e2f2920823b727d'
const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql'
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run`
const SOFT_LIMIT = 8_000
const EXTERNAL_RESERVED_NEURONS = 2_200
const RUN_RESERVATION_NEURONS = 2_280
const PROMPT_VERSION = 'active13-attack-prompts-v1'
const SCHEMA_VERSION = 'active13-attack-schema-v1'
const REQUIRED_RESULT_FILES = [
  'final-verdict.json', 'final-report.md', 'strategy-verdicts.json', 'candidate-verdicts.json', 'issue-verdicts.json',
  'tests-executed.json', 'repository-evidence.json', 'unresolved-evidence.json', 'candidate-recommendations.json',
]
const FORBIDDEN_KEYS = new Set([
  'strategy_id', 'strategy_ids', 'feature_id', 'feature_ids', 'data_source', 'data_sources', 'system_profile',
  'governance', 'dsl', 'threshold', 'thresholds', 'parameters', 'entry_rules', 'exit_rules', 'exact_rules',
])
const MODEL_CONFIG = {
  DATA_PROSECUTOR: { model: '@cf/qwen/qwen3-30b-a3b-fp8', mode: 'json_schema', input: 4625, output: 30475 },
  EXECUTION_PROSECUTOR: { model: '@cf/zai-org/glm-4.7-flash', mode: 'json_schema', input: 5500, output: 36400 },
  ECONOMIC_PROSECUTOR: { model: '@cf/google/gemma-4-26b-a4b-it', mode: 'json_schema', input: 9091, output: 27273 },
  CROSS_EXAMINER: { model: '@cf/mistralai/mistral-small-3.1-24b-instruct', mode: 'guided_json', input: 31876, output: 50488 },
}

function stable(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stable)
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]))
}
function stableStringify(value) { return JSON.stringify(stable(value)) }
function sha256(value) { return createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest('hex') }
function hashJson(value) { return sha256(stableStringify(value)) }
function jsonText(value) { return `${JSON.stringify(value, null, 2)}\n` }

function tokenFromToml(text) {
  const match = text.match(/^oauth_token\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('wrangler_oauth_token_not_found')
  return match[1]
}

async function graphql(token, query, variables) {
  const response = await fetch(GRAPHQL, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) })
  const payload = await response.json()
  if (!response.ok || payload.errors?.length) throw new Error(`cloudflare_usage_query_failed:${response.status}:${JSON.stringify(payload.errors ?? payload)}`)
  return payload.data
}

async function currentUsage(token) {
  const observed = new Date()
  const start = new Date(observed); start.setUTCHours(0, 0, 0, 0)
  const data = await graphql(token, `query Usage($accountTag: string, $start: Time, $end: Time) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      aiInferenceAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end }) {
        count sum { totalNeurons totalInputTokens totalOutputTokens }
      }
    } }
  }`, { accountTag: ACCOUNT_ID, start: start.toISOString(), end: observed.toISOString() })
  const row = data.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups?.[0]
  if (!row) throw new Error('workers_ai_usage_row_not_found')
  const total = Number(row.sum?.totalNeurons ?? 0)
  const projected = total + EXTERNAL_RESERVED_NEURONS + RUN_RESERVATION_NEURONS
  if (!Number.isFinite(total) || projected > SOFT_LIMIT) throw new Error(`workers_ai_budget_blocked:${total}:${projected}:${SOFT_LIMIT}`)
  return { schema_version: 'workers-ai-usage-preflight-v1', source: 'Cloudflare GraphQL aiInferenceAdaptiveGroups', account_id: ACCOUNT_ID,
    period_start_utc: start.toISOString(), observed_at_utc: observed.toISOString(), inference_count: Number(row.count ?? 0),
    total_neurons: total, input_tokens: Number(row.sum?.totalInputTokens ?? 0), output_tokens: Number(row.sum?.totalOutputTokens ?? 0),
    external_reserved_neurons: EXTERNAL_RESERVED_NEURONS, run_reservation_neurons: RUN_RESERVATION_NEURONS,
    projected_neurons: projected, soft_limit_neurons: SOFT_LIMIT, decision: 'PASS' }
}

function scanPrivacy(value, exactIds, requireFullDocument = true) {
  const leaks = []
  function walk(node, path = '$') {
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${path}[${index}]`))
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) leaks.push(`${path}.${key}:forbidden_key`)
      walk(child, `${path}.${key}`)
    }
  }
  walk(value)
  const serialized = stableStringify(value)
  for (const id of exactIds) if (id && serialized.includes(id)) leaks.push(`exact_identifier:${id}`)
  const contract = value.schema_version ?? value.contract_version
  if (contract !== 'stockvision-active-strategy-attack-privacy-v1') leaks.push('schema_version_invalid')
  if (value.active_strategy_count !== 13 || !Array.isArray(value.issues ?? value.original_issues)) leaks.push('active13_shape_invalid')
  if (requireFullDocument && value.issues.length !== 11) leaks.push('active13_issue_count_invalid')
  for (const key of ['exact_rules_removed', 'numeric_parameters_removed', 'internal_identifiers_removed', 'data_sources_removed', 'governance_fields_removed']) {
    if (value.redaction?.[key] !== true) leaks.push(`redaction_flag_missing:${key}`)
  }
  if (leaks.length) throw new Error(`privacy_scan_failed:${leaks.join(',')}`)
  return { status: 'PASS', forbidden_key_leaks: 0, exact_identifier_leaks: 0, outbound_contract: 'stockvision-active-strategy-attack-privacy-v1' }
}

const stringArray = { type: 'array', items: { type: 'string' } }
const findingSchema = { type: 'object', additionalProperties: false,
  required: ['finding_ref', 'source_issue_handles', 'target_handles', 'category', 'claim', 'attack_mechanism', 'severity_if_true', 'missing_evidence', 'falsification_tests', 'optimization_actions'],
  properties: { finding_ref: { type: 'string' }, source_issue_handles: { ...stringArray, maxItems: 8 }, target_handles: { ...stringArray, maxItems: 13 },
    category: { type: 'string' }, claim: { type: 'string' }, attack_mechanism: { type: 'string' }, severity_if_true: { enum: ['FATAL','MAJOR','MINOR','INFO'] },
    missing_evidence: { ...stringArray, maxItems: 8 }, falsification_tests: { ...stringArray, maxItems: 8 }, optimization_actions: { ...stringArray, maxItems: 8 } } }
const prosecutorSchema = { type: 'object', additionalProperties: false, required: ['findings','overall_assessment','limitations'], properties: {
  findings: { type: 'array', minItems: 1, maxItems: 3, items: findingSchema }, overall_assessment: { type: 'string' }, limitations: { ...stringArray, maxItems: 6 } } }
const crossSchema = { type: 'object', additionalProperties: false, required: ['assessments','executive_conclusion','prioritized_actions','limitations'], properties: {
  assessments: { type: 'array', minItems: 1, maxItems: 9, items: { type: 'object', additionalProperties: false,
    required: ['finding_ref','status','severity_if_true','reason','remaining_evidence'], properties: { finding_ref: { type: 'string' },
      status: { enum: ['VALID_CLAIM','POSSIBLE_BUT_UNVERIFIED','OVERSTATED','DUPLICATE','NOT_APPLICABLE','UNSUBSTANTIATED'] },
      severity_if_true: { enum: ['FATAL','MAJOR','MINOR','INFO'] }, reason: { type: 'string' }, remaining_evidence: { ...stringArray, maxItems: 8 } } } },
  executive_conclusion: { type: 'string' }, prioritized_actions: { ...stringArray, maxItems: 12 }, limitations: { ...stringArray, maxItems: 8 } } }

function parseJson(value) {
  if (value && typeof value === 'object') return value
  const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text)
}
function responseValue(result) { return parseJson(result?.response ?? result?.result ?? result?.choices?.[0]?.message?.content ?? result) }
function validateProsecutor(value, allowedIssues, allowedTargets) {
  if (!value || !Array.isArray(value.findings) || value.findings.length < 1 || value.findings.length > 3 || typeof value.overall_assessment !== 'string' || !Array.isArray(value.limitations)) return false
  const refs = new Set()
  return value.findings.every((row) => row && typeof row.finding_ref === 'string' && !refs.has(row.finding_ref) && refs.add(row.finding_ref)
    && Array.isArray(row.source_issue_handles) && row.source_issue_handles.every((id) => allowedIssues.has(id))
    && Array.isArray(row.target_handles) && row.target_handles.every((id) => allowedTargets.has(id))
    && ['FATAL','MAJOR','MINOR','INFO'].includes(row.severity_if_true) && Array.isArray(row.missing_evidence)
    && Array.isArray(row.falsification_tests) && Array.isArray(row.optimization_actions) && typeof row.claim === 'string' && typeof row.attack_mechanism === 'string')
}
function validateCross(value, findingRefs) {
  if (!value || !Array.isArray(value.assessments) || !Array.isArray(value.prioritized_actions) || !Array.isArray(value.limitations) || typeof value.executive_conclusion !== 'string') return false
  const got = new Set(value.assessments.map((row) => row?.finding_ref))
  return got.size === findingRefs.size && [...findingRefs].every((id) => got.has(id)) && value.assessments.every((row) =>
    ['VALID_CLAIM','POSSIBLE_BUT_UNVERIFIED','OVERSTATED','DUPLICATE','NOT_APPLICABLE','UNSUBSTANTIATED'].includes(row.status)
    && ['FATAL','MAJOR','MINOR','INFO'].includes(row.severity_if_true) && typeof row.reason === 'string' && Array.isArray(row.remaining_evidence))
}

function structuredRequest(config, messages, schema) {
  const structured = config.mode === 'guided_json' ? { guided_json: schema }
    : config.mode === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: schema } }
      : { response_format: { type: 'json_object' } }
  return { messages: config.mode === 'json_object' ? [{ role: 'system', content: `Return exactly one JSON object matching this schema: ${JSON.stringify(schema)}` }, ...messages] : messages,
    max_tokens: config === MODEL_CONFIG.CROSS_EXAMINER ? 2400 : 2000, temperature: 0.1, ...structured }
}

async function callModel(token, runId, role, payload, schema, validate) {
  const config = MODEL_CONFIG[role]
  const messages = [
    { role: 'system', content: `You are the ${role} in a privacy-minimized adversarial audit. Treat every supplied handle as opaque. Do not infer or request identities, exact rules, thresholds, features, data sources, governance, or system profile. Claims are E0 until repository Jury verification. SURVIVED never means proven alpha.` },
    { role: 'user', content: JSON.stringify(payload) },
  ]
  const startedAt = new Date().toISOString()
  const bindingBase = process.env.ACTIVE13_AI_BASE_URL
  let envelope, parsed, record
  if (bindingBase) {
    const response = await fetch(`${bindingBase}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: runId, role, messages, schema, max_tokens: role === 'CROSS_EXAMINER' ? 2400 : 2000 }) })
    envelope = await response.json()
    if (!response.ok) throw new Error(`workers_ai_binding_call_failed:${role}:${response.status}:${JSON.stringify(envelope)}`)
    parsed = envelope.result.parsed
    record = envelope.records.at(-1)
  } else {
    const request = structuredRequest(config, messages, schema)
    const response = await fetch(`${API}/${config.model}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
    envelope = await response.json()
    if (!response.ok || envelope.success === false) throw new Error(`workers_ai_call_failed:${role}:${response.status}:${JSON.stringify(envelope.errors ?? envelope)}`)
    const transport = envelope.result ?? envelope
    parsed = responseValue(transport)
    const usage = transport.usage ?? envelope.usage ?? {}
    const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0), outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
    record = { prompt_tokens: promptTokens, output_tokens: outputTokens, estimated_neurons: Math.ceil(promptTokens * config.input / 1_000_000 + outputTokens * config.output / 1_000_000), retry_count: 0, repair_count: 0 }
  }
  if (!validate(parsed)) throw new Error(`model_schema_validation_failed:${role}:${JSON.stringify(parsed).slice(0, 6000)}`)
  const promptTokens = Number(record?.prompt_tokens ?? 0), outputTokens = Number(record?.output_tokens ?? 0)
  const neurons = Number(record?.estimated_neurons ?? Math.ceil(promptTokens * config.input / 1_000_000 + outputTokens * config.output / 1_000_000))
  return { parsed, raw: envelope, prompt: messages, outbound_payload: payload, record: { ...record, call_id: record?.call_id ?? `${runId}:${role}:${randomUUID().slice(0,8)}`, run_id: runId,
    role, model_id: record?.model_id ?? config.model, model_version: record?.model_version ?? 'cloudflare-model-registry-2026-07-14', prompt_version: PROMPT_VERSION, schema_version: SCHEMA_VERSION,
    input_hash: hashJson({ role, messages, schema }), started_at: startedAt, ended_at: new Date().toISOString(), prompt_tokens: promptTokens,
    output_tokens: outputTokens, estimated_neurons: neurons, retry_count: Number(record?.retry_count ?? 0), repair_count: Number(record?.repair_count ?? 0), validation_status: 'VALID', source_type: 'REAL' } }
}

async function putJson(path, value) { await writeFile(path, jsonText(value), 'utf8') }
async function buildBundle({ runId, runDir, privacy, rawSpecs, handleMap, modelResults, cross, inputHash }) {
  const root = join(runDir, 'jury-bundle')
  await mkdir(join(root, 'raw-model-responses'), { recursive: true }); await mkdir(join(root, 'prompts'), { recursive: true })
  const reverse = Object.fromEntries(Object.entries(handleMap).map(([internal, handle]) => [handle, internal]))
  const strategies = rawSpecs.map((spec) => ({ strategy_id: spec.id, ...spec }))
  const deterministicIssues = privacy.issues.map((issue) => ({ issue_id: issue.issue_handle, run_id: runId, target_type: 'STRATEGY',
    target_ids: issue.target_handles.map((handle) => reverse[handle]).filter(Boolean), category: issue.category, claim: `Deterministic active-strategy audit flagged ${issue.category}.`,
    attack_mechanism: 'Repository and runtime contract evidence requires adjudication.', observed_evidence: [], missing_evidence: ['Repository Jury verification'],
    severity_if_true: issue.severity, evidence_level: 'E1', critic_model: 'local-deterministic-audit', critic_confidence: 1,
    falsification_test: { tests: [] }, blocks_if_confirmed: issue.blocks_locked_test, cross_exam_status: 'POSSIBLE_BUT_UNVERIFIED', duplicate_of: null }))
  const aiFindings = modelResults.flatMap(({ parsed, record }, roleIndex) => parsed.findings.map((finding, index) => ({ issue_id: `AI-${roleIndex+1}-${index+1}`, run_id: runId,
    target_type: finding.target_handles.length ? 'STRATEGY' : 'SYSTEM', target_ids: finding.target_handles.map((handle) => reverse[handle]).filter(Boolean), category: finding.category,
    claim: finding.claim, attack_mechanism: finding.attack_mechanism, observed_evidence: [], missing_evidence: finding.missing_evidence,
    severity_if_true: finding.severity_if_true, evidence_level: 'E0', critic_model: record.model_id, critic_confidence: 0.5,
    falsification_test: { tests: finding.falsification_tests, optimization_actions: finding.optimization_actions }, blocks_if_confirmed: ['FATAL','MAJOR'].includes(finding.severity_if_true),
    cross_exam_status: cross.parsed.assessments.find((row) => row.finding_ref === finding.finding_ref)?.status ?? 'POSSIBLE_BUT_UNVERIFIED', duplicate_of: null,
    source_finding_ref: finding.finding_ref, source_issue_handles: finding.source_issue_handles })))
  const files = new Map()
  const addJson = (name, value) => files.set(name, jsonText(value))
  files.set('jury-bundle/run-summary.md', `# ${runId}\n\nActive13 privacy-v1 real Workers AI adversarial attack. Model findings are E0 until repository Jury adjudication. SURVIVED is not Alpha proof.\n`)
  addJson('jury-bundle/feature-registry-summary.json', { feature_count: 0, features: [], scope: 'not externally disclosed' })
  addJson('jury-bundle/feature-clusters.json', { deterministic: {}, llm_feature_map: {}, scope: 'active-strategy-attack-only' })
  addJson('jury-bundle/portfolio-gap-map.json', { active_strategy_count: 13, privacy_summary: privacy })
  addJson('jury-bundle/existing-strategies.json', strategies); addJson('jury-bundle/hypotheses.json', []); addJson('jury-bundle/candidates.json', [])
  addJson('jury-bundle/candidate-lineage.json', []); addJson('jury-bundle/static-validation.json', [])
  addJson('jury-bundle/issues.json', [...deterministicIssues, ...aiFindings])
  addJson('jury-bundle/cross-examination.json', cross.parsed)
  addJson('jury-bundle/evidence-requests.json', [...deterministicIssues, ...aiFindings].map((row) => ({ issue_id: row.issue_id, target_ids: row.target_ids, missing_evidence: row.missing_evidence, falsification_test: row.falsification_test })))
  addJson('jury-bundle/test-plan.json', { scope: 'active13', requirements: ['repository evidence', 'executable tests', 'no majority-vote truth', 'UNVERIFIED when evidence is absent'] })
  addJson('jury-bundle/source-map.json', { active_strategy_specs: 'audits/active-strategy/ACTIVE-20260714-LOCAL/raw-active-strategy-specs.json',
    deterministic_audit: 'audits/active-strategy/ACTIVE-20260714-LOCAL/active-strategy-attack.json', privacy_input_hash: inputHash,
    audit_tool: 'tools/audit_active_strategies.py', real_model_runner: 'tools/run_active13_workers_ai_e2e.mjs' })
  for (const result of [...modelResults, cross]) {
    const role = result.record.role
    addJson(`jury-bundle/raw-model-responses/${role}.json`, result.raw); addJson(`jury-bundle/prompts/${role}.json`, result.prompt)
  }
  for (const [name, text] of files) { const target = join(runDir, ...name.split('/')); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, text, 'utf8') }
  const fileHashes = Object.fromEntries([...files].map(([name, text]) => [name, sha256(text)]))
  const createdAt = new Date().toISOString()
  const manifestRoot = { run_id: runId, created_at: createdAt, feature_snapshot_hash: hashJson({ undisclosed: true }), strategy_snapshot_hash: hashJson(rawSpecs),
    schema_versions: { bundle: 'jury-bundle-v1', attack: SCHEMA_VERSION, privacy: privacy.schema_version }, candidate_hashes: {}, required_codex_outputs: REQUIRED_RESULT_FILES, files: fileHashes }
  const manifest = { schema_version: 'jury-bundle-v1', ...manifestRoot, bundle_hash: hashJson(manifestRoot) }
  await putJson(join(root, 'manifest.json'), manifest)
  return { root, manifest, strategies: strategies.length, issues: deterministicIssues.length + aiFindings.length }
}

async function main() {
  const repo = resolve(process.argv[2] ?? '.')
  const sourceDir = join(repo, 'audits', 'active-strategy', 'ACTIVE-20260714-LOCAL')
  const [privacyText, manifestText, specsText, mapText, configText] = await Promise.all([
    readFile(join(sourceDir, 'active-strategy-privacy-v1.json'), 'utf8'), readFile(join(sourceDir, 'manifest.json'), 'utf8'),
    readFile(join(sourceDir, 'raw-active-strategy-specs.json'), 'utf8'), readFile(join(sourceDir, 'privacy-handle-map.local.json'), 'utf8'),
    readFile(join(process.env.APPDATA ?? '', 'xdg.config', '.wrangler', 'config', 'default.toml'), 'utf8'),
  ])
  const privacy = JSON.parse(privacyText), sourceManifest = JSON.parse(manifestText), rawSpecs = JSON.parse(specsText), handleMap = JSON.parse(mapText)
  const exactIds = rawSpecs.map((row) => row.id)
  if (sha256(Buffer.from(privacyText)) !== sourceManifest.artifacts['active-strategy-privacy-v1.json']) throw new Error('privacy_input_hash_mismatch')
  const privacyScan = scanPrivacy(privacy, exactIds)
  const token = tokenFromToml(configText)
  const usage = await currentUsage(token)
  const checkpointPath = process.env.ACTIVE13_CHECKPOINT_PATH
  let checkpoint = null
  if (checkpointPath) {
    try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) } catch {}
  }
  const runId = checkpoint?.run_id ?? `RUN-ACTIVE13-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${randomUUID().slice(0,8)}`
  const allowedTargets = new Set(Object.values(handleMap)), allowedIssues = new Set(privacy.issues.map((row) => row.issue_handle))
  const base = { contract_version: privacy.schema_version, active_strategy_count: privacy.active_strategy_count, decision: privacy.decision, redaction: privacy.redaction,
    instruction: 'Return at most three concise findings. Attack the disclosed issue classes, propose falsification tests and bounded optimization actions. Do not infer undisclosed logic.' }
  const roleFilters = {
    DATA_PROSECUTOR: /LINEAGE|PIT|SOURCE|FEATURE/,
    EXECUTION_PROSECUTOR: /EXEC|RUNTIME|COOLDOWN|SAMPLE/,
    ECONOMIC_PROSECUTOR: /PORTFOLIO|REWARD|GOV|STATUS|REGIME/,
  }
  const results = Array.isArray(checkpoint?.results) ? checkpoint.results : []
  for (const role of ['DATA_PROSECUTOR','EXECUTION_PROSECUTOR','ECONOMIC_PROSECUTOR']) {
    if (results.some((row) => row.record?.role === role)) continue
    const payload = { ...base, role, issues: privacy.issues.filter((row) => roleFilters[role].test(row.category)) }
    scanPrivacy(payload, exactIds, false)
    results.push(await callModel(token, runId, role, payload, prosecutorSchema, (value) => validateProsecutor(value, allowedIssues, allowedTargets)))
    if (checkpointPath) await putJson(checkpointPath, { schema_version: 'active13-checkpoint-v1', run_id: runId, status: 'RUNNING', completed_roles: results.map((row) => row.record.role), results })
  }
  const findings = results.flatMap((row) => row.parsed.findings)
  const findingRefs = new Set(findings.map((row) => row.finding_ref))
  if (findingRefs.size !== findings.length) throw new Error('cross_role_finding_ref_duplicate')
  const crossPayload = { ...base, role: 'CROSS_EXAMINER', original_issues: privacy.issues, prosecutor_findings: findings,
    instruction: 'Assess every finding_ref exactly once. Preserve uncertainty. Prioritize only actions justified by disclosed evidence.' }
  scanPrivacy(crossPayload, exactIds, false)
  const cross = checkpoint?.cross?.record?.role === 'CROSS_EXAMINER' ? checkpoint.cross
    : await callModel(token, runId, 'CROSS_EXAMINER', crossPayload, crossSchema, (value) => validateCross(value, findingRefs))
  if (checkpointPath) await putJson(checkpointPath, { schema_version: 'active13-checkpoint-v1', run_id: runId, status: 'MODEL_COMPLETE', completed_roles: [...results.map((row) => row.record.role), 'CROSS_EXAMINER'], results, cross })
  const runDir = join(repo, 'audits', 'active-strategy', runId); await mkdir(runDir, { recursive: true })
  const inputHash = sha256(Buffer.from(privacyText))
  await Promise.all([putJson(join(runDir, 'cloudflare-usage-preflight.json'), usage), putJson(join(runDir, 'privacy-scan.json'), privacyScan),
    writeFile(join(runDir, 'active-strategy-privacy-v1.json'), privacyText, 'utf8'), putJson(join(runDir, 'model-call-records.json'), [...results, cross].map((row) => row.record)),
    putJson(join(runDir, 'real-model-attack.json'), { schema_version: SCHEMA_VERSION, run_id: runId, input_hash: inputHash, prompt_version: PROMPT_VERSION,
      decision: privacy.decision, prosecutors: Object.fromEntries(results.map((row) => [row.record.role, row.parsed])), cross_examination: cross.parsed,
      total_estimated_neurons: [...results, cross].reduce((sum, row) => sum + row.record.estimated_neurons, 0), external_transmission: { performed: true, payload_contract: privacy.schema_version,
        exact_dsl_sent: false, thresholds_sent: false, internal_ids_sent: false, data_sources_sent: false, governance_sent: false, system_profile_sent: false } })])
  const bundle = await buildBundle({ runId, runDir, privacy, rawSpecs, handleMap, modelResults: results, cross, inputHash })
  if (checkpointPath) await putJson(checkpointPath, { schema_version: 'active13-checkpoint-v1', run_id: runId, status: 'BUNDLE_READY', run_dir: runDir, bundle_dir: bundle.root, bundle_hash: bundle.manifest.bundle_hash, completed_roles: [...results.map((row) => row.record.role), 'CROSS_EXAMINER'], results, cross })
  process.stdout.write(`${JSON.stringify({ status: 'PASS', run_id: runId, run_dir: runDir, bundle_dir: bundle.root, bundle_hash: bundle.manifest.bundle_hash,
    strategies: bundle.strategies, issues: bundle.issues, model_calls: 4, estimated_neurons: [...results, cross].reduce((sum, row) => sum + row.record.estimated_neurons, 0), usage_preflight: usage }, null, 2)}\n`)
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1 })
