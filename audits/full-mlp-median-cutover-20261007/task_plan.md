# Full MLP median Paper champion cutover — 2026-10-07

User: switch formal TabPack to Full MLP median; Half and fixed TabPack remain shadow/forward. No partial/hardcoded score implementation.
Base: live Worker bdf904c74e2e1e72b3c3889aa7b5e4a884905612. Managed isolated worktree. Preserve HMM/fee fixes.

## Phases
1. [complete] Recall wiki, inspect formal config/source/forward dependencies.
2. [complete] Exact 3-seed residual ensemble export/inference, fail-closed identity, generalized Paper mode.
3. [complete] Lifecycle, Worker/config/release/OPB identities, UI, frozen shadow continuation (both original and risk-v3 cohorts).
4. [complete] Real-checkpoint golden parity and native Paper full-chain acceptance, reviewable rollback packet.
5. [pending] Authorized publication + runtime verification (commit/push/deploy require explicit approval per AGENTS).

## Source findings
- Single B serving, Worker/config/UI, refresh/lifecycle tied to single_b_tabpack_v1.
- Cloud forward_models.source_rows blocks if live champion differs from frozen T; changing champion requires explicit transition contract, never relabel T or old samples.
- Research 3-seed w22 checkpoints/Anchor/recipes are existing original E0; not retrain. All 34 inputs and exact FP32 operations must survive portable export.
- Serving L3 identity is separate from original training L3 identity and needs explicit provenance, not falsified lineage.
- Preserve current sparse allocator, OPB policy space, no top K, Paper ledger/OR15/VWAP/hard exits, real gates OFF.
- Forward original 120 mature days AND6 full months, day60 check; do not rewrite protocol to40.
- At plan creation, no code edits/deploys were completed. Candidate implementation and local checks are now complete; no commit/push/deploy/config switch occurred.

## Final local evidence
- Full model 3ecdc98a80b22dede5fe99649225f98865cde83e08c348a30572b9a5623e7928, original 66 tensors exact; immutable GCS weights staged and real loader cold-read verified.
- 700 full native rows, no preselection, certified allocation gap0; diagnostic only, not a new prospective plan.
- 43 model/weights/cutover/monthly tests, 41 lifecycle tests, 17 native Worker contract tests passed. Earlier73 regression tests overlap; do not add counts.
- Two zero-sample frozen forward successors pass700 nine-column parity; must recheck live heads before deployment. Keep120 mature common days AND6 complete months protocol.
- Final local native owner bd5664cc7791ac18797c66f8c181709a18a2a3118badbecd19fb749433dbd1f5; Linux image attestation required at release.
- Current production canonical bundle HTTP200 PASS/no drift after a no-available-instance HTTP500. Current formal champion is still TabPack.
- Release review: docs/releases/2026-10-07-full-mlp-median-paper-champion.md. Complete private cutover/rollback packet is gitignored under output/mlp-cutover.
