# Advisory debate and HMM semantic release

## Scope

- The prior evening produces L3 only. New US news and night futures feed the morning L4 plan; the published pending buys remain available while debate runs afterward as an observation.
- Debate verdicts and failures are recorded without deleting candidates, reducing allocations, requesting a debate-only replan, or blocking intraday entry. Deterministic execution and risk gates remain in force.
- Existing GaussianHMM artifacts are relabeled from their emission statistics at inference time. An unsupported bear state falls back to the effective sideways policy, and the exposed label, posterior, policy, and index agree. This release does not retrain or replace a model.

## Exact Paper identity

- Previous key: `ml:active8:paper_runtime_approval:v1:2026-10-05-atr5-once`
- New key: `ml:active8:paper_runtime_approval:v1:2026-10-05-advisory-debate-hmm`
- Previous native owner: `native-paper-v1:5eacd16f4e32cc637cbd020265c98c86d6d080bc51f26ef79659650277558001`
- New native owner: `native-paper-v1:46f923110d6a7b6323402d091d360f057e615b183c0c88c1d9f2508a34b80a74`
- Scope: Paper only. Source equivalence and NAV maturity transfer are false. Original admission and previous release keys remain unchanged. Real-order flags remain disabled.

The new key must be validated against the current original admission and full configuration, staged with an exact readback before routing the new Controller and Paper runtime. A missing or revoked new key fails closed. The previous revision continues to use its previous key.

## Verification

- Worker TypeScript application and tests type-check.
- Affected Worker event-chain, L4, debate and native Paper tests: 34 passed.
- Paper authority, native identity, HMM and Controller tests: 80 passed.
- Integrated native bundle identity computed from the release source using the locked esbuild package.
- Live original admission and prior ATR5 approval read back unchanged. Local injection of the candidate approval produced a Paper serving grant `PASS` with zero production writes and zero real-order writes.
- Unapproved proposal checksum: `553bb3c450825ceb2f03b512824f46615b0a0c6f68ed47b8972b3a445f72d0e2`.

No training job or real order is part of this release. Deploy Controller, Jobs, Modal and Worker from one committed source SHA; verify their provenance and the Paper serving grant after routing.
