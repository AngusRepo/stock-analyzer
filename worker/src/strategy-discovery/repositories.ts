import { STRATEGY_DISCOVERY_PROMPT_VERSION, STRATEGY_DISCOVERY_SCHEMA_VERSION, WORKFLOW_STEPS } from './config'
import type { AnalysisRunRecord, AuditIssue, FeatureCard, FeatureCluster, PortfolioGapMap, RegimeSampleEvidence, SnapshotManifest, StaticValidationResult, StrategyCandidate, StrategyCard, StrategyHypothesis } from './domain'

type RunRow = Omit<AnalysisRunRecord, 'blockers' | 'warnings' | 'fixture_mode'> & {
  blockers_json: string
  warnings_json: string
  fixture_mode: number
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch { return [] }
}

function mapRun(row: RunRow | null): AnalysisRunRecord | null {
  if (!row) return null
  return {
    run_id: row.run_id,
    status: row.status,
    idempotency_key: row.idempotency_key,
    workflow_instance_id: row.workflow_instance_id,
    workflow_attempt: Number(row.workflow_attempt ?? 0),
    feature_version: row.feature_version,
    strategy_version: row.strategy_version,
    feature_snapshot_hash: row.feature_snapshot_hash,
    strategy_snapshot_hash: row.strategy_snapshot_hash,
    system_profile_hash: row.system_profile_hash,
    input_hash: row.input_hash,
    prompt_set_version: row.prompt_set_version,
    schema_set_version: row.schema_set_version,
    completed_steps: Number(row.completed_steps ?? 0),
    total_steps: Number(row.total_steps ?? WORKFLOW_STEPS.length),
    current_step: row.current_step,
    blockers: parseJsonArray(row.blockers_json),
    warnings: parseJsonArray(row.warnings_json),
    fixture_mode: Number(row.fixture_mode) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    heartbeat_at: row.heartbeat_at,
  }
}

export interface ArtifactManifestInput {
  artifact_id: string
  run_id: string
  artifact_type: string
  r2_key: string
  artifact_hash: string
  content_type: string
  byte_size: number
  schema_version?: string | null
  metadata?: Record<string, unknown>
  metadata_json?: string
  created_at?: string
}

export interface CheckpointRecord {
  run_id: string
  step_id: string
  input_hash: string
  output_hash: string
  artifact_r2_key: string
  artifact_hash: string
  status: 'COMPLETED' | 'INVALIDATED'
  metadata_json: string
}

export interface ModelCallRecord {
  call_id: string
  run_id: string
  step_id: string
  model_id: string
  role: string
  model_version: string
  prompt_version: string
  schema_version: string
  input_hash: string
  raw_response_r2_key: string | null
  parsed_response_r2_key: string | null
  prompt_tokens: number
  output_tokens: number
  estimated_neurons: number
  started_at: string
  ended_at: string | null
  retry_count: number
  repair_count: number
  validation_status: string
  source_type: 'REAL' | 'FIXTURE'
  error_code: string | null
}

export interface CodexImportRow {
  import_id: string
  run_id: string
  idempotency_key: string
  result_hash: string
  bundle_hash: string
  validation_status: string
  zip_r2_key: string | null
  imported_at: string
}

export class StrategyDiscoveryRepository {
  constructor(readonly db: D1Database) {}

  async latestRun(): Promise<AnalysisRunRecord | null> {
    const row = await this.db.prepare('SELECT * FROM analysis_runs ORDER BY created_at DESC LIMIT 1').first<RunRow>()
    return mapRun(row)
  }

  async getRun(runId: string): Promise<AnalysisRunRecord | null> {
    return mapRun(await this.db.prepare('SELECT * FROM analysis_runs WHERE run_id=?').bind(runId).first<RunRow>())
  }

  async getRunByIdempotencyKey(key: string): Promise<AnalysisRunRecord | null> {
    return mapRun(await this.db.prepare('SELECT * FROM analysis_runs WHERE idempotency_key=?').bind(key).first<RunRow>())
  }

  async createRun(input: { runId: string; idempotencyKey: string; fixtureMode: boolean }): Promise<AnalysisRunRecord> {
    await this.db.prepare(`
      INSERT INTO analysis_runs (
        run_id,status,idempotency_key,prompt_set_version,schema_set_version,total_steps,fixture_mode,heartbeat_at
      ) SELECT ?,'CREATED',?,?,?,?,?,CURRENT_TIMESTAMP
       WHERE NOT EXISTS (
         SELECT 1 FROM analysis_runs WHERE status IN ('CREATED','PREFLIGHT','RUNNING')
       )
      ON CONFLICT(idempotency_key) DO NOTHING
    `).bind(
      input.runId,
      input.idempotencyKey,
      STRATEGY_DISCOVERY_PROMPT_VERSION,
      STRATEGY_DISCOVERY_SCHEMA_VERSION,
      WORKFLOW_STEPS.length,
      input.fixtureMode ? 1 : 0,
    ).run()
    const run = await this.getRunByIdempotencyKey(input.idempotencyKey)
    if (!run) throw new Error('analysis_active_run_conflict')
    return run
  }

  async updateRun(runId: string, update: {
    status?: AnalysisRunRecord['status']
    workflowInstanceId?: string | null
    workflowAttempt?: number
    featureVersion?: string | null
    strategyVersion?: string | null
    featureSnapshotHash?: string | null
    strategySnapshotHash?: string | null
    systemProfileHash?: string | null
    inputHash?: string | null
    completedSteps?: number
    currentStep?: string | null
    blockers?: string[]
    warnings?: string[]
    errorCode?: string | null
    errorDetail?: string | null
    heartbeat?: boolean
  }): Promise<void> {
    const fields: string[] = ['updated_at=CURRENT_TIMESTAMP']
    const values: unknown[] = []
    const put = (sql: string, value: unknown) => { fields.push(sql); values.push(value) }
    if (update.status !== undefined) put('status=?', update.status)
    if (update.workflowInstanceId !== undefined) put('workflow_instance_id=?', update.workflowInstanceId)
    if (update.workflowAttempt !== undefined) put('workflow_attempt=?', update.workflowAttempt)
    if (update.featureVersion !== undefined) put('feature_version=?', update.featureVersion)
    if (update.strategyVersion !== undefined) put('strategy_version=?', update.strategyVersion)
    if (update.featureSnapshotHash !== undefined) put('feature_snapshot_hash=?', update.featureSnapshotHash)
    if (update.strategySnapshotHash !== undefined) put('strategy_snapshot_hash=?', update.strategySnapshotHash)
    if (update.systemProfileHash !== undefined) put('system_profile_hash=?', update.systemProfileHash)
    if (update.inputHash !== undefined) put('input_hash=?', update.inputHash)
    if (update.completedSteps !== undefined) put('completed_steps=?', update.completedSteps)
    if (update.currentStep !== undefined) put('current_step=?', update.currentStep)
    if (update.blockers !== undefined) put('blockers_json=?', JSON.stringify(update.blockers))
    if (update.warnings !== undefined) put('warnings_json=?', JSON.stringify(update.warnings))
    if (update.errorCode !== undefined) put('error_code=?', update.errorCode)
    if (update.errorDetail !== undefined) put('error_detail=?', update.errorDetail)
    if (update.heartbeat) fields.push('heartbeat_at=CURRENT_TIMESTAMP')
    values.push(runId)
    await this.db.prepare(`UPDATE analysis_runs SET ${fields.join(',')} WHERE run_id=?`).bind(...values).run()
  }

  async activeStrategyRows(): Promise<Record<string, unknown>[]> {
    const result = await this.db.prepare(`
      SELECT strategy_id,version,name,status,owner,alpha_bucket,family_id,variant_id,owner_type,
             promotion_status,supported_regimes_json,thesis,thresholds_json,candidate_policy_json,
             risk_notes_json,source_refs_json,created_by,updated_at
        FROM strategy_spec_registry
       WHERE status='active'
       ORDER BY strategy_id
    `).all<Record<string, unknown>>()
    return result.results ?? []
  }

  async regimeSampleEvidence(): Promise<RegimeSampleEvidence[]> {
    const result = await this.db.prepare(`SELECT regime, MAX(samples) AS max_samples, COUNT(*) AS evidence_rows
      FROM strategy_reward_ledger WHERE regime <> 'all' AND samples > 0 GROUP BY regime ORDER BY regime`).all<{ regime: string; max_samples: number; evidence_rows: number }>()
    const allowed = new Set(['bull', 'bear', 'volatile', 'sideways'])
    return (result.results ?? []).filter((row) => allowed.has(row.regime)).map((row) => ({
      regime: row.regime as RegimeSampleEvidence['regime'], max_samples: Number(row.max_samples), evidence_rows: Number(row.evidence_rows),
      source: 'd1:strategy_reward_ledger', count_policy: 'MAX_PER_EVIDENCE_ROW_NO_SUM',
    }))
  }

  async saveFeatureVersion(input: { featureVersion: string; sourcePath: string; sourceHash: string; snapshotHash: string; cards: FeatureCard[] }): Promise<void> {
    const statements = [
      this.db.prepare(`INSERT INTO feature_versions(feature_version,source_path,source_hash,snapshot_hash,schema_version,feature_count)
        VALUES (?,?,?,?,?,?) ON CONFLICT(feature_version) DO UPDATE SET source_hash=excluded.source_hash,snapshot_hash=excluded.snapshot_hash,feature_count=excluded.feature_count`)
        .bind(input.featureVersion, input.sourcePath, input.sourceHash, input.snapshotHash, STRATEGY_DISCOVERY_SCHEMA_VERSION, input.cards.length),
      ...input.cards.map((card) => this.db.prepare(`INSERT INTO features(
        feature_version,feature_id,name,family,definition,data_source_json,availability_lag,earliest_execution,lookback_days,metrics_json,governance_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(feature_version,feature_id) DO UPDATE SET
        name=excluded.name,family=excluded.family,definition=excluded.definition,data_source_json=excluded.data_source_json,
        availability_lag=excluded.availability_lag,earliest_execution=excluded.earliest_execution,lookback_days=excluded.lookback_days,
        metrics_json=excluded.metrics_json,governance_json=excluded.governance_json`)
        .bind(input.featureVersion, card.feature_id, card.name, card.family, card.definition, JSON.stringify(card.data_source),
          card.availability_lag, card.earliest_execution, card.lookback_days === 'UNKNOWN' ? null : card.lookback_days,
          JSON.stringify({ missing_rate: card.missing_rate, outlier_rate: card.outlier_rate, turnover_proxy: card.turnover_proxy, ic_summary: card.ic_summary, regime_summary: card.regime_summary, factor_exposure: card.factor_exposure }),
          JSON.stringify(card.governance))),
    ]
    await this.db.batch(statements)
  }

  async saveStrategyVersion(input: { strategyVersion: string; source: string; snapshotHash: string; cards: StrategyCard[]; cardHashes: Record<string, string> }): Promise<void> {
    const statements = [
      this.db.prepare(`INSERT INTO strategy_versions(strategy_version,source,snapshot_hash,schema_version,strategy_count)
        VALUES (?,?,?,?,?) ON CONFLICT(strategy_version) DO UPDATE SET snapshot_hash=excluded.snapshot_hash,strategy_count=excluded.strategy_count`)
        .bind(input.strategyVersion, input.source, input.snapshotHash, STRATEGY_DISCOVERY_SCHEMA_VERSION, input.cards.length),
      ...input.cards.map((card) => this.db.prepare(`INSERT INTO strategies(strategy_version,strategy_id,version,name,card_json,card_hash)
        VALUES (?,?,?,?,?,?) ON CONFLICT(strategy_version,strategy_id) DO UPDATE SET card_json=excluded.card_json,card_hash=excluded.card_hash,name=excluded.name`)
        .bind(input.strategyVersion, card.strategy_id, card.version, card.name, JSON.stringify(card), input.cardHashes[card.strategy_id])),
    ]
    await this.db.batch(statements)
  }

  async saveSnapshot(snapshot: SnapshotManifest, type: string, version: string, hash: string, r2Key: string, count: number): Promise<void> {
    await this.db.prepare(`INSERT INTO input_snapshots(snapshot_id,run_id,snapshot_type,version,snapshot_hash,r2_key,item_count,schema_version)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id,snapshot_type) DO UPDATE SET version=excluded.version,snapshot_hash=excluded.snapshot_hash,r2_key=excluded.r2_key,item_count=excluded.item_count`)
      .bind(`${snapshot.run_id}:${type}`, snapshot.run_id, type, version, hash, r2Key, count, snapshot.schema_version).run()
  }

  async recordArtifact(input: ArtifactManifestInput): Promise<void> {
    await this.db.prepare(`INSERT INTO artifacts(artifact_id,run_id,artifact_type,r2_key,artifact_hash,content_type,byte_size,schema_version,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET r2_key=excluded.r2_key,artifact_hash=excluded.artifact_hash,byte_size=excluded.byte_size,metadata_json=excluded.metadata_json`)
      .bind(input.artifact_id, input.run_id, input.artifact_type, input.r2_key, input.artifact_hash, input.content_type,
        input.byte_size, input.schema_version ?? null, JSON.stringify(input.metadata ?? {})).run()
  }

  async artifact(runId: string, artifactType: string): Promise<ArtifactManifestInput | null> {
    return this.db.prepare('SELECT * FROM artifacts WHERE run_id=? AND artifact_type=? ORDER BY created_at DESC LIMIT 1')
      .bind(runId, artifactType).first<ArtifactManifestInput>()
  }

  async checkpoint(runId: string, stepId: string): Promise<CheckpointRecord | null> {
    return this.db.prepare('SELECT * FROM workflow_checkpoints WHERE run_id=? AND step_id=?')
      .bind(runId, stepId).first<CheckpointRecord>()
  }

  async saveCheckpoint(input: Omit<CheckpointRecord, 'metadata_json'> & { metadata?: Record<string, unknown> }): Promise<void> {
    await this.db.prepare(`INSERT INTO workflow_checkpoints(run_id,step_id,input_hash,output_hash,artifact_r2_key,artifact_hash,status,metadata_json)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET input_hash=excluded.input_hash,output_hash=excluded.output_hash,
      artifact_r2_key=excluded.artifact_r2_key,artifact_hash=excluded.artifact_hash,status=excluded.status,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP`)
      .bind(input.run_id, input.step_id, input.input_hash, input.output_hash, input.artifact_r2_key, input.artifact_hash,
        input.status, JSON.stringify(input.metadata ?? {})).run()
  }

  async knownUsedNeurons(day: string): Promise<number> {
    const row = await this.db.prepare(`SELECT COALESCE(SUM(estimated_neurons),0) AS used FROM model_calls
      WHERE source_type='REAL' AND substr(started_at,1,10)=?`).bind(day).first<{ used: number }>()
    return Number(row?.used ?? 0)
  }

  async recordModelCall(input: ModelCallRecord): Promise<void> {
    await this.db.prepare(`INSERT INTO model_calls(call_id,run_id,step_id,model_id,role,model_version,prompt_version,schema_version,input_hash,
      raw_response_r2_key,parsed_response_r2_key,prompt_tokens,output_tokens,estimated_neurons,started_at,ended_at,retry_count,repair_count,
      validation_status,source_type,error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(input.call_id, input.run_id, input.step_id, input.model_id, input.role, input.model_version, input.prompt_version,
        input.schema_version, input.input_hash, input.raw_response_r2_key, input.parsed_response_r2_key, input.prompt_tokens,
        input.output_tokens, input.estimated_neurons, input.started_at, input.ended_at, input.retry_count, input.repair_count,
        input.validation_status, input.source_type, input.error_code).run()
  }

  async startWorkflowStep(input: { runId: string; stepId: string; attempt: number; inputHash: string; modelRole?: string | null }): Promise<void> {
    await this.db.prepare(`INSERT INTO workflow_steps(run_id,step_id,attempt,step_name,status,input_hash,model_role,started_at)
      VALUES (?,?,?,?,'RUNNING',?,?,CURRENT_TIMESTAMP) ON CONFLICT(run_id,step_id,attempt) DO UPDATE SET
      status='RUNNING',input_hash=excluded.input_hash,model_role=excluded.model_role,started_at=CURRENT_TIMESTAMP,error_code=NULL,error_detail=NULL`)
      .bind(input.runId, input.stepId, input.attempt, input.stepId, input.inputHash, input.modelRole ?? null).run()
  }

  async finishWorkflowStep(input: { runId: string; stepId: string; attempt: number; status: 'COMPLETED' | 'FAILED' | 'SKIPPED_REUSED'; outputHash?: string | null; errorCode?: string | null; errorDetail?: string | null }): Promise<void> {
    await this.db.prepare(`UPDATE workflow_steps SET status=?,output_hash=?,ended_at=CURRENT_TIMESTAMP,error_code=?,error_detail=?
      WHERE run_id=? AND step_id=? AND attempt=?`).bind(input.status, input.outputHash ?? null, input.errorCode ?? null,
      input.errorDetail ?? null, input.runId, input.stepId, input.attempt).run()
  }

  async saveCrossExaminations(runId: string, rows: Array<{ issue_id: string; status: string; [key: string]: unknown }>, sourceModel: string, sourceType: 'REAL' | 'FIXTURE'): Promise<void> {
    if (!rows.length) return
    await this.db.batch(rows.map((row) => this.db.prepare(`INSERT INTO cross_examinations(run_id,issue_id,status,examination_json,source_model,source_type)
      VALUES (?,?,?,?,?,?) ON CONFLICT(run_id,issue_id) DO UPDATE SET status=excluded.status,examination_json=excluded.examination_json,source_model=excluded.source_model,source_type=excluded.source_type`)
      .bind(runId, row.issue_id, row.status, JSON.stringify(row), sourceModel, sourceType)))
  }

  async codexImportByIdempotency(runId: string, key: string): Promise<CodexImportRow | null> {
    return this.db.prepare('SELECT * FROM codex_imports WHERE run_id=? AND idempotency_key=?').bind(runId, key).first<CodexImportRow>()
  }

  async codexImportByResultHash(runId: string, hash: string): Promise<CodexImportRow | null> {
    return this.db.prepare('SELECT * FROM codex_imports WHERE run_id=? AND result_hash=?').bind(runId, hash).first<CodexImportRow>()
  }

  async persistCodexImport(input: {
    runId: string; importId: string; idempotencyKey: string; resultHash: string; bundleHash: string
    resultArtifact: ArtifactManifestInput; conclusionArtifact: ArtifactManifestInput
    strategyVerdicts: Array<Record<string, any>>; candidateVerdicts: Array<Record<string, any>>; issueVerdicts: Array<Record<string, any>>
    modelAccuracy: Array<Record<string, any>>
  }): Promise<void> {
    const artifactStatement = (row: ArtifactManifestInput) => this.db.prepare(`INSERT INTO artifacts(artifact_id,run_id,artifact_type,r2_key,artifact_hash,content_type,byte_size,schema_version,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(row.artifact_id, row.run_id, row.artifact_type, row.r2_key, row.artifact_hash, row.content_type, row.byte_size,
      row.schema_version ?? null, JSON.stringify(row.metadata ?? {}))
    const statements = [
      artifactStatement(input.resultArtifact), artifactStatement(input.conclusionArtifact),
      this.db.prepare(`INSERT INTO codex_imports(import_id,run_id,idempotency_key,result_hash,bundle_hash,validation_status,zip_r2_key)
        VALUES (?,?,?,?,?,'VALID',?)`).bind(input.importId, input.runId, input.idempotencyKey, input.resultHash, input.bundleHash, input.resultArtifact.r2_key),
      ...input.strategyVerdicts.map((row) => this.db.prepare(`INSERT INTO strategy_verdicts(run_id,strategy_id,verdict,verdict_json) VALUES (?,?,?,?)`)
        .bind(input.runId, row.strategy_id, row.verdict, JSON.stringify(row))),
      ...input.candidateVerdicts.map((row) => this.db.prepare(`INSERT INTO candidate_verdicts(run_id,candidate_id,verdict,verdict_json) VALUES (?,?,?,?)`)
        .bind(input.runId, row.candidate_id, row.verdict, JSON.stringify(row))),
      ...input.issueVerdicts.map((row) => this.db.prepare(`INSERT INTO issue_verdicts(run_id,issue_id,verdict,severity,evidence_level,verdict_json) VALUES (?,?,?,?,?,?)`)
        .bind(input.runId, row.issue_id, row.verdict, row.severity, row.evidence_level, JSON.stringify(row))),
      ...input.modelAccuracy.map((row) => this.db.prepare(`INSERT INTO model_accuracy(run_id,model_id,role,proposed_count,confirmed_count,refuted_count,duplicate_count,unsupported_count,unique_confirmed_count,metrics_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(input.runId, row.model_id, 'critic', row.proposed_count, row.confirmed_count, row.refuted_count,
        row.duplicate_count, row.unsupported_count, row.unique_confirmed_count, JSON.stringify(row))),
      this.db.prepare(`UPDATE analysis_runs SET status='RESULT_READY',updated_at=CURRENT_TIMESTAMP,heartbeat_at=CURRENT_TIMESTAMP WHERE run_id=?`).bind(input.runId),
    ]
    await this.db.batch(statements)
  }

  async saveFeatureClusters(runId: string, clusters: FeatureCluster[], source: string): Promise<void> {
    if (!clusters.length) return
    await this.db.batch(clusters.map((cluster) => this.db.prepare(`INSERT INTO feature_clusters(run_id,cluster_id,cluster_json,source)
      VALUES (?,?,?,?) ON CONFLICT(run_id,cluster_id) DO UPDATE SET cluster_json=excluded.cluster_json,source=excluded.source`)
      .bind(runId, cluster.cluster_id, JSON.stringify(cluster), source)))
  }

  async saveGapMap(runId: string, gapMap: PortfolioGapMap, artifactHash: string, r2Key: string): Promise<void> {
    await this.db.prepare(`INSERT INTO gap_maps(run_id,gap_map_json,artifact_hash,r2_key) VALUES (?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET gap_map_json=excluded.gap_map_json,artifact_hash=excluded.artifact_hash,r2_key=excluded.r2_key`)
      .bind(runId, JSON.stringify(gapMap), artifactHash, r2Key).run()
  }

  async saveHypotheses(rows: StrategyHypothesis[], hashes: Record<string, string>): Promise<void> {
    if (!rows.length) return
    await this.db.batch(rows.map((row) => this.db.prepare(`INSERT INTO hypotheses(run_id,hypothesis_id,search_mode,parent_strategy_id,source_model,source_type,hypothesis_json,hypothesis_hash)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id,hypothesis_id) DO UPDATE SET hypothesis_json=excluded.hypothesis_json,hypothesis_hash=excluded.hypothesis_hash`)
      .bind(row.run_id, row.hypothesis_id, row.search_mode, row.parent_strategy_id, row.source_model, row.source_type, JSON.stringify(row), hashes[row.hypothesis_id])))
  }

  async saveCandidates(rows: StrategyCandidate[]): Promise<void> {
    if (!rows.length) return
    const statements = rows.flatMap((row) => [
      this.db.prepare(`INSERT INTO candidates(run_id,candidate_id,search_mode,parent_strategy_id,candidate_hash,candidate_json,status,source_model,source_type)
        VALUES (?,?,?,?,?,?,'GENERATED',?,?) ON CONFLICT(run_id,candidate_id) DO UPDATE SET candidate_hash=excluded.candidate_hash,candidate_json=excluded.candidate_json,status='GENERATED'`)
        .bind(row.run_id, row.candidate_id, row.search_mode, row.parent_strategy_id, row.candidate_hash, JSON.stringify(row), row.source_model, row.source_type),
      this.db.prepare(`INSERT INTO candidate_lineage(run_id,candidate_id,parent_strategy_id,mutation_type,search_mode,lineage_json)
        VALUES (?,?,?,?,?,?) ON CONFLICT(run_id,candidate_id) DO UPDATE SET parent_strategy_id=excluded.parent_strategy_id,mutation_type=excluded.mutation_type,lineage_json=excluded.lineage_json`)
        .bind(row.run_id, row.candidate_id, row.parent_strategy_id, row.mutation_type, row.search_mode, JSON.stringify({ search_mode: row.search_mode, parent_strategy_id: row.parent_strategy_id, mutation_type: row.mutation_type })),
    ])
    await this.db.batch(statements)
  }

  async saveStaticValidation(runId: string, rows: StaticValidationResult[]): Promise<void> {
    if (!rows.length) return
    await this.db.batch(rows.map((row) => this.db.prepare(`INSERT INTO static_validation_results(run_id,candidate_id,valid,errors_json,warnings_json,candidate_hash)
      VALUES (?,?,?,?,?,?) ON CONFLICT(run_id,candidate_id) DO UPDATE SET valid=excluded.valid,errors_json=excluded.errors_json,warnings_json=excluded.warnings_json,candidate_hash=excluded.candidate_hash`)
      .bind(runId, row.candidate_id, row.valid ? 1 : 0, JSON.stringify(row.errors), JSON.stringify(row.warnings), row.candidate_hash)))
  }

  async saveAuditIssues(rows: AuditIssue[], hashes: Record<string, string>): Promise<void> {
    if (!rows.length) return
    await this.db.batch(rows.map((row) => this.db.prepare(`INSERT INTO audit_issues(run_id,issue_id,target_type,target_id,target_ids_json,category,severity_if_true,evidence_level,
      critic_model,critic_confidence,cross_exam_status,duplicate_of,issue_json,issue_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,issue_id) DO UPDATE SET cross_exam_status=excluded.cross_exam_status,duplicate_of=excluded.duplicate_of,issue_json=excluded.issue_json,issue_hash=excluded.issue_hash`)
      .bind(row.run_id, row.issue_id, row.target_type, row.target_ids[0] ?? '', JSON.stringify(row.target_ids), row.category,
        row.severity_if_true, row.evidence_level, row.critic_model, row.critic_confidence, row.cross_exam_status, row.duplicate_of,
        JSON.stringify(row), hashes[row.issue_id])))
  }
}
