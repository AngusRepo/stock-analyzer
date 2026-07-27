export type RetentionClass =
  | 'canonical_execution'
  | 'canonical_model_evidence'
  | 'paper_shadow'
  | 'superseded_run'
  | 'failed_debug'
  | 'request_debug'
  | 'raw_market_unreferenced'
  | 'staging_orphan'
  | 'incident_pinned'

export type EvidenceArtifactWriteInput = {
  domain: string
  businessDate: string
  producerRunId: string
  retentionClass: RetentionClass
  schemaVersion: string
  payload: Record<string, unknown>
  rowCount: number
  canonicalRunId?: string | null
  metadata?: Record<string, unknown>
  createdAt?: string
}

export type EvidenceArtifactManifest = {
  artifact_id: string
  retention_class: RetentionClass
  status: 'ready'
  domain: string
  business_date: string
  producer_run_id: string
  canonical_run_id: string | null
  r2_key: string
  checksum: string
  schema_version: string
  row_count: number
  byte_size: number
  created_at: string
  retain_until: string | null
  checksum_verified_at: string
  metadata_json: string
}

export interface EvidenceArtifactWriter {
  write(input: EvidenceArtifactWriteInput): Promise<EvidenceArtifactManifest>
}

export interface EvidenceArtifactReader {
  read(r2Key: string): Promise<string | null>
}
