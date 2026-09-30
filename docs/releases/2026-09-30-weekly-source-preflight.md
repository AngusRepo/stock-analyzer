# Weekly source preflight

## Cause and change

The 2026-09-27 Weekly run selected a research snapshot without the
`corporate_source_records` component. The dispatcher allocated a Cloud Run Job
before discovering the missing input. Detect this known manifest failure before
creating the Jobs client, and check it again inside the replay owner.

The authenticated GET `/backtest/research-bundle/preflight` inspects only the
selected manifest. It returns explicit ready/blocked data, never dispatches a Job,
and never downloads replay artifacts. The POST dispatch returns HTTP 409 with
`triggered=false` for known source blockers. Infrastructure failures propagate.
Ready means component presence only; original receipt, universe and session PIT
validation remain mandatory. This patch does not supply missing historical data
or declare Weekly recovered.

## Verification and release boundary

- 65 focused local tests cover missing/invalid manifests, future snapshots,
  source/schema validation, exception propagation, dispatch ordering and read-only
  GET behavior. The suites are now included in P9.
- This patch changes three Python runtime modules and three test files. It does
  not change native execution identity inputs, approval/equivalence records,
  Worker runtime, retention policy or database schemas.
- Publish one verified image to the Controller and `weekly-backtest-research`
  only. Keep CPU, memory, timeout, retries, environment, secret references, IAM,
  network, scaling, other Jobs and existing traffic tags unchanged.
- Check exact main/production provenance before every release transition;
  preserve concurrent releases. Stage with no traffic, verify the authenticated
  GET, update only the Weekly image, then route to the exact verified revision.
  Do not start a paid replay to test a known missing source.

Production acceptance requires image/source/native-byte verification, immutable
image digest and matching service/Job readback. Missing upstream originals remain
an explicit blocker after this efficiency fix.
