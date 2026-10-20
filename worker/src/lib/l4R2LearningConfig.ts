type Reference = { path: string; sha256: string }
export type L4R2LearningConfig = {
  native_observation: {
    l3_identity: Record<string, string>
    serving_context: Reference
    timesfm_context?: Reference // Accepted only for immutable historical configurations.
    training_cutoffs: Reference
    classification: Reference
  }
  shadow: { bundle: Reference; baseline: Reference; evaluation_policy: Reference; classification: Reference }
  monthly: { classification: Reference }
}

/** Learning configuration cannot grant trading or promotion permission. */
export function validateR2Learning(value: unknown): string[] {
  if (value == null) return []
  const c = value as any
  const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
  const ref = (v: any) => v && typeof v.path === 'string'
    && v.path.startsWith('l4_distribution/') && !v.path.includes('..')
    && hex(v.sha256) && Object.keys(v).every(k => ['path','sha256'].includes(k))
  const identity = c.native_observation?.l3_identity
  const sameRef = (a: any,b: any) => a?.path === b?.path && a?.sha256 === b?.sha256
  if (typeof c !== 'object' || Array.isArray(c)
      || Object.keys(c).some(k => !['native_observation','shadow','monthly'].includes(k))
      || !identity || !identity.artifact_id || !identity.cohort_id
      || !hex(identity.payload_checksum) || !hex(identity.base_artifact_set_checksum)
      || !['serving_context','training_cutoffs','classification'].every(k => ref(c.native_observation?.[k]))
      || !['bundle','baseline','evaluation_policy','classification'].every(k => ref(c.shadow?.[k]))
      || !ref(c.monthly?.classification)
      || !sameRef(c.native_observation.classification,c.shadow.classification)
      || !sameRef(c.native_observation.classification,c.monthly.classification)) {
    return ['l4R2Learning requires complete checksum-bound native, shadow and monthly configuration']
  }
  for (const [name, allowed] of Object.entries({
    native_observation: ['l3_identity','serving_context','timesfm_context','training_cutoffs','classification'],
    shadow: ['bundle','baseline','evaluation_policy','classification'], monthly: ['classification'],
  })) {
    if (Object.keys(c[name]).some(k => !allowed.includes(k))) return ['l4R2Learning contains unsupported activation fields']
  }
  return []
}
