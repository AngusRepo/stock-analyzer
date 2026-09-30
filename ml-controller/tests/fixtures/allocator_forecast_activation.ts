// Synthetic evidence for local tests only. Never import from production source.
export function allocatorForecastActivationFixture() {
  const evidence = { uri: 'fixture://complete-inventory', sha256: 'sha256:' + 'a'.repeat(64), observed_at: '2026-09-30T00:00:00Z' }
  return {
    schema_version: 'allocator-forecast-writer-activation-v1', enabled: true,
    activation_id: 'fixture-activation', worker_version_id: 'fixture-worker',
    controller_url: 'https://controller.fixture.invalid', reader_contract: 'allocator-forecast-reader-v1',
    approval: { reference: 'fixture-only-explicit-approval', approved_at: '2026-09-30T00:01:00Z' },
    deployment_inventory: { ...evidence, complete: true, resource_count: 28, job_entrypoint_audit_sha256: 'sha256:' + 'b'.repeat(64) },
    controller: {
      resource: 'projects/fixture/locations/asia-east1/services/ml-controller', inventory_count: 2,
      full_reader_routes: ['/allocator_ev_fusion/refresh', '/opb_arm_prior/refresh'],
      revisions: [
        { revision: 'ml-controller-reader-v1', image_digest: 'sha256:' + 'c'.repeat(64), source_commit: 'd'.repeat(40),
          reachable: true, reader_contract: 'allocator-forecast-reader-v1' },
        { revision: 'ml-controller-old-v0', image_digest: 'sha256:' + 'e'.repeat(64), source_commit: 'f'.repeat(40),
          reachable: false, quiescence: { ...evidence, method: 'revision_unreachable_and_drained', inflight_requests: 0, background_work: 0 } },
      ],
    },
  }
}
