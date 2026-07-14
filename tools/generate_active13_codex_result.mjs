import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const RUN_ID = 'RUN-ACTIVE13-20260714072340-39cd92ca'
const BUNDLE_HASH = '08646ea19e4c1a9b9aad8722ca800b764b1868edd975393cabb8139f76e94d90'

const repo = resolve(process.argv[2] ?? '.')
const bundle = join(repo, 'audits', 'active-strategy', RUN_ID, 'jury-bundle')
const out = join(repo, 'audits', 'outbox', RUN_ID)
const [strategies, issues] = await Promise.all([
  readFile(join(bundle, 'existing-strategies.json'), 'utf8').then(JSON.parse),
  readFile(join(bundle, 'issues.json'), 'utf8').then(JSON.parse),
])
await mkdir(out, { recursive: true })
const put = (name, value) => writeFile(join(out, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8')

const globalRequired = [
  'versioned execution/exit/cost contracts', 'immutable source and dataset hashes', 'formal point-in-time lineage',
  'preregistered locked OOS with 5-session purge/embargo', 'multiple-testing trial ledger and correction',
  'net-of-cost paired replay with uncertainty and regime power',
]
const strategyVerdicts = strategies.map((strategy) => ({
  run_id: RUN_ID, strategy_id: strategy.strategy_id, verdict: 'BLOCKED', confirmed_fatal: 0,
  confirmed_major: issues.filter((issue) => issue.target_ids?.includes(strategy.strategy_id) && issue.severity_if_true === 'MAJOR' && !issue.issue_id.startsWith('AI-')).length,
  refuted_issues: 0, incomplete_tests: globalRequired,
  summary: strategy.strategy_id === 'smrc_vwap_reclaim_v1'
    ? 'Blocked: global execution/lineage/PIT closure is incomplete; reward evidence has only 14 samples and threshold calibration is not an independent locked OOS test.'
    : 'Blocked: production-active identity is verified, but execution, lineage, PIT, locked OOS, multiple-testing, cost, and paired-comparison evidence are incomplete. No Alpha conclusion is authorized.',
}))

const deterministic = {
  'ACTIVE-EXEC-001': ['CONFIRMED','E3','Version and enforce holding, exit, signal cutoff, execution bar/order, fees, tax, slippage, and partial-fill fields for all 13.'],
  'ACTIVE-LINEAGE-001': ['CONFIRMED','E3','Attach immutable repo/file/data/calibration hashes and parameter-origin records to every active strategy.'],
  'ACTIVE-LINEAGE-003': ['CONFIRMED','E3','Map all runtime-only signals to formal versioned features with PIT timing and runtime parity tests.'],
  'ACTIVE-LINEAGE-004': ['CONFIRMED','E3','Replace absolute workstation paths with repository-relative immutable sources and verified hashes.'],
  'ACTIVE-GOV-001': ['CONFIRMED','E3','Make active status text consistent with a signed promotion decision and evidence pointer.'],
  'ACTIVE-PIT-001': ['CONFIRMED','E3','Canonicalize all dependencies or define an immutable external dependency contract and parity test.'],
  'ACTIVE-PIT-002': ['CONFIRMED','E3','Record publication lag, availability timestamp, earliest execution, PIT status, and reproduce historical cutoffs.'],
  'ACTIVE-PORTFOLIO-001': ['PARTIALLY_CONFIRMED','E3','Measure same-date selection overlap, return correlation, net-cost marginal contribution, and block-bootstrap confidence intervals.'],
  'ACTIVE-PORTFOLIO-002': ['CONFIRMED','E3','Use multiple bear episodes with preregistered power, non-overlapping outcomes, net-cost benchmark, and confidence intervals.'],
  'ACTIVE-REWARD-001': ['PARTIALLY_CONFIRMED','E2','Deduplicate matured strategy/date/symbol/horizon rows, separate all/regime partitions, compute chronological portfolio drawdown, and run locked paired replay.'],
  'ACTIVE-REWARD-002': ['CONFIRMED','E3','Require at least 30 unique matured outcomes and a power-based target before using reward evidence; do not retune on the same sample.'],
}
function aiDisposition(id) {
  if (id === 'AI-1-3') return ['PARTIALLY_CONFIRMED','E2','The model\'s claimed exploit was not reproduced, but repository evidence shows a concrete monthly-revenue publication-timing risk. Add available_date <= as_of_date, point-in-time universe membership, and before/after replay evidence.']
  if (['AI-2-3','AI-3-3'].includes(id)) return ['PARTIALLY_CONFIRMED','E2','The low-sample SMRC predicate is verified, but the claimed causal incentive failure remains unverified. Apply the ACTIVE-REWARD-002 acceptance gate.']
  return ['UNVERIFIED','E0','Treat the model claim as a falsification hypothesis only; reproduce the claimed exploit or causal effect with repository tests before confirmation.']
}
const issueVerdicts = issues.map((issue) => {
  const [verdict, level, requiredFix] = deterministic[issue.issue_id] ?? aiDisposition(issue.issue_id)
  const isAi = issue.issue_id.startsWith('AI-')
  const isPartiallyConfirmedAi = isAi && verdict === 'PARTIALLY_CONFIRMED'
  return { run_id: RUN_ID, issue_id: issue.issue_id, verdict, severity: issue.severity_if_true, evidence_level: level,
    evidence: isPartiallyConfirmedAi
      ? (issue.issue_id === 'AI-1-3' ? ['REPO-FUNDAMENTAL-AVAILABILITY','REPO-SURVIVORSHIP-RISK'] : ['REPO-REWARD-GATE'])
      : isAi ? [] : ['REPO-ACTIVE-AUDIT','REPO-RUNTIME-PATH'],
    commands_executed: isPartiallyConfirmedAi ? ['python active13 data/privacy verification']
      : isAi ? [] : ['python deterministic active13 recomputation', 'pytest ml-controller/tests/test_active_strategy_attack_audit.py -q'],
    test_results: isPartiallyConfirmedAi ? [{ test_id: 'T-ACTIVE13-DATA-PRIVACY', status: 'PASS' }]
      : isAi ? [] : [{ test_id: 'T-ACTIVE13-RECOMPUTE', status: 'PASS' }, { test_id: 'T-ACTIVE13-AUDIT-UNIT', status: 'PASS' }],
    remaining_uncertainty: isAi ? ['Workers AI output is E0; exploitability and causality were not reproduced.']
      : issue.issue_id === 'ACTIVE-PORTFOLIO-001' ? ['Family counts are reproducible; performance overlap and harm are not measured.']
        : issue.issue_id === 'ACTIVE-REWARD-001' ? ['Overlapping all/regime rows, dependent five-day labels, and non-chronological drawdown limit statistical interpretation.'] : [],
    required_fix: requiredFix, blocks_target: Boolean(issue.blocks_if_confirmed) || ['ACTIVE-EXEC-001','ACTIVE-LINEAGE-001','ACTIVE-PIT-001','ACTIVE-PIT-002','ACTIVE-REWARD-001','ACTIVE-REWARD-002'].includes(issue.issue_id) }
})

const tests = [
  { test_id:'T-BUNDLE-VALIDATE', run_id:RUN_ID, command:'npx.cmd tsx .agents\\skills\\strategy-discovery-jury\\scripts\\validate-bundle.ts audits\\active-strategy\\RUN-ACTIVE13-20260714072340-39cd92ca\\jury-bundle', exit_code:0, status:'PASS', duration_ms:1500, target_ids:strategies.map((s)=>s.strategy_id), dataset_version:`bundle:${BUNDLE_HASH}`, evidence_paths:[bundle] },
  { test_id:'T-TYPECHECK', run_id:RUN_ID, command:'npm.cmd run type-check', exit_code:0, status:'PASS', duration_ms:4900, target_ids:strategies.map((s)=>s.strategy_id), dataset_version:'repo:working-tree', evidence_paths:['worker/tsconfig.json','worker/tsconfig.tests.json'] },
  { test_id:'T-STRATEGY-DISCOVERY-16', run_id:RUN_ID, command:'npm.cmd run test:strategy-discovery', exit_code:0, status:'PASS', duration_ms:9400, target_ids:strategies.map((s)=>s.strategy_id), dataset_version:'formal137:c0b8531d1c75ec271be4de6ab2ca5eb6979f3fe28c9d842110567755ea4e8d80', evidence_paths:['tools/run_strategy_discovery_tests.mjs'] },
  { test_id:'T-ACTIVE13-RECOMPUTE', run_id:RUN_ID, command:'python deterministic active13 recomputation against frozen raw specs/rewards/formal137', exit_code:0, status:'PASS', duration_ms:576, target_ids:strategies.map((s)=>s.strategy_id), dataset_version:'active13:29e60cf1736b3aaff35b52261be0c602268d7a720b7ac8720047a162a40c9bb9', evidence_paths:['tools/audit_active_strategies.py','audits/active-strategy/ACTIVE-20260714-LOCAL/active-strategy-attack.json'] },
  { test_id:'T-ACTIVE13-AUDIT-UNIT', run_id:RUN_ID, command:'pytest ml-controller/tests/test_active_strategy_attack_audit.py -q', exit_code:0, status:'PASS', duration_ms:788, target_ids:strategies.map((s)=>s.strategy_id), dataset_version:'repo:working-tree', evidence_paths:['ml-controller/tests/test_active_strategy_attack_audit.py'] },
  { test_id:'T-ACTIVE13-DATA-PRIVACY', run_id:RUN_ID, command:'python audits/active-strategy/RUN-ACTIVE13-20260714072340-39cd92ca/data-leakage/verify_active13_data_privacy.py', exit_code:0, status:'PASS', duration_ms:330, target_ids:strategies.map((s)=>s.strategy_id), dataset_version:'active13:frozen-specs+58-reward-rows+formal137', evidence_paths:['audits/active-strategy/RUN-ACTIVE13-20260714072340-39cd92ca/data-leakage/verify_active13_data_privacy.py'] },
  { test_id:'T-ACTIVE13-DATA-CV', run_id:RUN_ID, command:'pytest ml-controller/tests/test_active_strategy_attack_audit.py ml-controller/tests/test_revenue_availability.py ml-service/tests/test_purged_cv.py -q', exit_code:0, status:'PASS', duration_ms:1078, target_ids:strategies.map((s)=>s.strategy_id), dataset_version:'repo:working-tree', evidence_paths:['ml-controller/tests/test_active_strategy_attack_audit.py','ml-controller/tests/test_revenue_availability.py','ml-service/tests/test_purged_cv.py'] },
  { test_id:'T-ACTIVE13-PRIVACY-PROVENANCE', run_id:RUN_ID, command:'node audits/tmp/RUN-ACTIVE13-20260714072340-39cd92ca/test-reviewer/privacy_provenance_check.mjs', exit_code:0, status:'PASS', duration_ms:56, target_ids:strategies.map((s)=>s.strategy_id), dataset_version:'active13:actual-prompts+responses', evidence_paths:['audits/tmp/RUN-ACTIVE13-20260714072340-39cd92ca/test-reviewer/privacy_provenance_check.mjs','audits/active-strategy/RUN-ACTIVE13-20260714072340-39cd92ca/privacy-scan.json'] },
  { test_id:'T-LOCAL-RUNTIME-E2E', run_id:RUN_ID, command:'tools/run_strategy_discovery_local_e2e.ps1 -PersistName strategy-discovery-active13-final4-20260714', exit_code:0, status:'PASS', duration_ms:6200, target_ids:strategies.map((s)=>s.strategy_id), dataset_version:'local-d1-fixture:137-features+13-strategies', evidence_paths:['.tmp/strategy-discovery-active13-final4-20260714','worker/src/lib/strategyDiscoveryLocalE2E.test.ts'] },
  { test_id:'T-FRONTEND-PRODUCTION-BUILD', run_id:RUN_ID, command:'npm.cmd run build', exit_code:0, status:'PASS', duration_ms:11300, target_ids:strategies.map((s)=>s.strategy_id), dataset_version:'frontend:working-tree', evidence_paths:['frontend/dist','frontend/src/pages/StrategyDiscoveryPage.tsx'] },
]
const repoEvidence = [
  { evidence_id:'REPO-ACTIVE-AUDIT', run_id:RUN_ID, file:'tools/audit_active_strategies.py', line_start:225, line_end:441, finding:'Frozen active13 audit deterministically produces 11 issues and BLOCKED_FOR_LOCKED_TEST.', target_ids:strategies.map((s)=>s.strategy_id) },
  { evidence_id:'REPO-RUNTIME-PATH', run_id:RUN_ID, file:'worker/src/lib/strategyLearning.ts', line_start:736, line_end:791, finding:'Runtime loads active strategy specs from D1 and fails closed for stale rows before strategy consumers evaluate candidates.', target_ids:strategies.map((s)=>s.strategy_id) },
  { evidence_id:'REPO-DSL-CONSUMER', run_id:RUN_ID, file:'worker/src/lib/strategySpec.ts', line_start:824, line_end:915, finding:'Strategy DSL and featureRefs are consumed in the screener path; missing feature references fail closed.', target_ids:strategies.map((s)=>s.strategy_id) },
  { evidence_id:'REPO-REWARD-AGGREGATION', run_id:RUN_ID, file:'worker/src/lib/strategyLearning.ts', line_start:1809, line_end:1820, finding:'Reward aggregation sums overlapping all/regime rows without a unique outcome partition; counts are not independent efficacy samples.', target_ids:strategies.map((s)=>s.strategy_id) },
  { evidence_id:'REPO-REWARD-GATE', run_id:RUN_ID, file:'worker/src/lib/strategyLearning.ts', line_start:200, line_end:207, finding:'Cooldown policy uses minimum samples 30, hit rate .48, average return 0, and drawdown -.08 thresholds.', target_ids:strategies.map((s)=>s.strategy_id) },
  { evidence_id:'REPO-PRIVACY-BOUNDARY', run_id:RUN_ID, file:'tools/run_active13_workers_ai_e2e.mjs', line_start:70, line_end:99, finding:'Outbound payload is fail-closed against exact strategy/feature IDs, DSL, thresholds, data sources, governance, and system profile.', target_ids:strategies.map((s)=>s.strategy_id) },
  { evidence_id:'REPO-FUNDAMENTAL-AVAILABILITY', run_id:RUN_ID, file:'worker/src/lib/fundamentalData.ts', line_start:148, line_end:170, finding:'Historical monthly-revenue query filters by revenue_month but has no publication available_date gate, creating an E2 future-publication risk for historical replay.', target_ids:['trend_quality_breakout_fused_v1'] },
  { evidence_id:'REPO-SURVIVORSHIP-RISK', run_id:RUN_ID, file:'tools/finlab_strategy_spec_backtest.py', line_start:93, line_end:100, finding:'Historical backtest filters the whole history with one current security_categories membership set rather than point-in-time membership/delist state.', target_ids:strategies.map((s)=>s.strategy_id) },
]
const unresolved = [
  { run_id:RUN_ID, evidence_id:'UNRES-LOCKED-OOS', issue_ids:['ACTIVE-PIT-001','ACTIVE-PIT-002','ACTIVE-REWARD-001'], target_ids:strategies.map((s)=>s.strategy_id), missing_data:'Untouched locked interval/hash, access audit, five-session purge/embargo, net-cost outcomes, and uncertainty.', reason:'No active strategy has an admissible locked OOS result.' },
  { run_id:RUN_ID, evidence_id:'UNRES-MULTIPLE-TESTING', issue_ids:['ACTIVE-REWARD-001'], target_ids:strategies.map((s)=>s.strategy_id), missing_data:'Complete search/trial ledger across Alpha223, pymoo, novelty, fused variants, and SMRC thresholds.', reason:'Selection bias cannot be corrected without the full trial family.' },
  { run_id:RUN_ID, evidence_id:'UNRES-COST-REGIME', issue_ids:['ACTIVE-EXEC-001','ACTIVE-PORTFOLIO-002'], target_ids:strategies.map((s)=>s.strategy_id), missing_data:'Taiwan fee/tax plus slippage/liquidity/limit/suspension/partial-fill grid and powered multi-episode regime evidence.', reason:'Governance cost budgets and supportedRegimes labels are not realized performance evidence.' },
  { run_id:RUN_ID, evidence_id:'UNRES-AI-CLAIMS', issue_ids:issues.filter((i)=>i.issue_id.startsWith('AI-')).map((i)=>i.issue_id), target_ids:strategies.map((s)=>s.strategy_id), missing_data:'Executable exploit, tamper, negative-path, or causal reproduction for every model claim.', reason:'All Workers AI claims remain E0 until repository tests reproduce them.' },
  { run_id:RUN_ID, evidence_id:'UNRES-DATA-LEAKAGE', issue_ids:['ACTIVE-PIT-001','ACTIVE-PIT-002'], target_ids:strategies.map((s)=>s.strategy_id), missing_data:'Reward dataset/universe hash, split manifest, label-source dates, scaler fit range, point-in-time membership/delist state, and publication available_date.', reason:'The Jury confirmed metadata gaps and E2 risks, but did not prove realized reward contamination.' },
]
const conclusion = { overall_health:'BLOCKED', most_severe_issue:'All 13 production-active strategies lack complete versioned execution, immutable lineage, and point-in-time contracts required for an admissible locked test.',
  confirmed_leakage:false, invalid_strategy_count:0, blocked_strategy_count:13, locked_test_candidate_count:0,
  summary:'The active13 privacy-v1 Workers AI attack completed, but model claims did not determine the verdict. Repository evidence reproduces the 11 deterministic gaps. All 13 strategies are BLOCKED for locked test; this is not a conclusion that the strategies have no Alpha.' }
const finalVerdict = { schema_version:'codex-final-verdict-v1', run_id:RUN_ID, bundle_hash:BUNDLE_HASH, executive_conclusion:conclusion,
  input_characterization:{ model_inference:'REAL_CLOUDFLARE_WORKERS_AI', strategy_context:'PRODUCTION_ACTIVE_SNAPSHOT_LOCAL_READ_ONLY_AUDIT', production_strategy_evidence:true, production_mutation:false },
  jury_roles:['Evidence Reviewer','Data & Leakage Reviewer','Test Reviewer','Methodology Reviewer'] }
const report = `# Active13 Codex Jury Final Report\n\n## Verdict\n\n**BLOCKED_FOR_LOCKED_TEST.** All 13 active strategies remain active and unmodified, but none currently has the complete execution, lineage, point-in-time, locked OOS, multiple-testing, cost, regime-power, and paired-comparison evidence required for a valid locked test. This verdict does not state that the strategies lack Alpha.\n\n## Model debate adjudication\n\nWorkers AI returned nine attack findings. The Jury did not use model consensus as evidence. Exploitation and manipulation claims remain UNVERIFIED/E0 unless independently reproduced. Three claims are only PARTIALLY_CONFIRMED/E2 because repository evidence supports their underlying temporal-risk or low-sample predicates, not the claimed exploit or causal effect. The deterministic execution, lineage, PIT, governance, portfolio-label, and low-sample predicates were adjudicated from repository evidence and executable tests.\n\n## Data and privacy\n\nThe actual four outbound prompts and four raw responses contain zero exact strategy-ID, feature-reference, workstation-path, or forbidden-core-key leaks. This is a direct-string boundary result, not a proof that semantic inference is impossible. Monthly-revenue publication timing, point-in-time universe membership, reward split/scaler lineage, and SMRC threshold selection remain unresolved E2/E3 evidence risks; realized reward contamination was not proven.\n\n## Local closure\n\nThe production frontend build, 16 Strategy Discovery gates, and full local 12-step runtime E2E all pass. The E2E exposed and closed a fixture authorization mismatch: fixture execution now requires the same explicit fail-closed boundary as local auth (ENVIRONMENT=local and LOCAL_AUTH_BYPASS=1), while production remains denied.\n\n## Highest-priority closure\n\n1. Close versioned execution/exit/cost contracts and immutable source lineage for all 13.\n2. Formalize runtime-only signals and all feature availability/earliest-execution metadata.\n3. Add monthly-revenue publication timestamps, point-in-time universe membership, and complete reward dataset/split/label/scaler lineage.\n4. Deduplicate reward outcomes and replace non-chronological drawdown with chronological portfolio drawdown.\n5. Freeze a post-calibration locked interval with five-session purge and embargo, full trial ledger/correction, Taiwan cost stress, regime power, and paired comparisons.\n6. Rebuild the Jury Bundle and rerun the four-role Jury.\n\n## Safety\n\nNo deploy, retrain, order, production registry mutation, commit, or push was performed. SURVIVED is not Alpha proof.\n`

await Promise.all([
  put('final-verdict.json', finalVerdict), put('final-report.md', report), put('strategy-verdicts.json', strategyVerdicts), put('candidate-verdicts.json', []),
  put('issue-verdicts.json', issueVerdicts), put('tests-executed.json', tests), put('repository-evidence.json', repoEvidence),
  put('unresolved-evidence.json', unresolved), put('candidate-recommendations.json', []),
])
process.stdout.write(`${JSON.stringify({ status:'PASS', outbox:out, strategies:strategyVerdicts.length, candidates:0, issues:issueVerdicts.length }, null, 2)}\n`)
