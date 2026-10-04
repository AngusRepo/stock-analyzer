# Scoped A Paper runtime reapproval

Original authority remains the immutable D1 publication plus exact active KV admission `ml:active8:paper_admission:v1`. The new optional `ml:active8:paper_runtime_approval:v1` is explicit supplemental operator authorization; it cannot override revocation or model publication checks. Never automatically refresh it on deploy.

The supplemental record embeds the exact original admission and a complete current execution configuration, operator source reference, approval time and checksum. Scope must be Paper, efficacy unproven and maturity_transfer false. Trading/risk/allocator policy and all unknown fields must equal the original. Only the two reviewed authority-reader source hashes, native execution identity and descriptive model-roster fields may differ; the complete new source hashes remain pinned. The current roster must match the immutable ensemble observations. Real-order flags must remain disabled.

Only GA candidate_latest diagnostics are omitted from comparison, and only when the GA context explicitly declares shadow_learning_context, applies_to_trading_config=false and effect_policy.mutates_trading_config=false. Champion, effective policy and unknown data remain checked. Both original and supplemental approvals are reread before returning a grant. Original pointer/history/NAV review records are not rewritten or credited to the new runtime.

The September 29 odd-lot release adds one Paper execution setting absent from the original admission: `FINLAB_L5_ODD_LOT_MAX_QUOTE_AGE_MS="10000"`. A supplemental approval may authorize this one exact addition only when its checksum covers `approved_execution_policy_change={"schema_version":"active8-paper-odd-lot-quote-age-change-v1","variable":"FINLAB_L5_ODD_LOT_MAX_QUOTE_AGE_MS","previous":"absent","approved":"10000"}`. A missing declaration, a different value, a prior value in the original admission, or any other policy change still fails closed. This is an explicit new Paper execution policy approval; it does not certify source equivalence or transfer NAV maturity.

## Operator procedure

1. Obtain explicit authorization for the exact runtime change. Read current original admission, immutable publication, full configuration and source identities. Prepare a supplemental record with validate_runtime_approval; compare all changed fields.
2. Run drift/revocation/race/live-guard and immutable-history tests. With the supplemental value injected only into a local read, verify the real workbench returns all eight approved observations. This is a dry run, not production authorization.
3. Deploy the exact tested source to Controller, Jobs, Modal and Worker. Verify provenance. Do not run training or overwrite completed upstream data.
4. Reread original approval/pointer and current configuration. Stop if any unapproved field or source changed. Archive the proposed record and original state without secrets. Write only the supplemental KV key after explicit approval; verify its exact readback.
5. Verify authenticated Controller and Worker workbench, all eight serving identities, Paper-only flags and unchanged original publication. The final live gateway still blocks any active Paper admission.

Rollback: revoke the supplemental record (approved=false) to fail closed, or restore the archived prior supplemental value together with its matching source. Removing supplementation does not authorize changed runtime code under an old admission.

2026-09-24 source receipt: audits/model-pool-502-20260924/DIAGNOSIS.md; runtime-preflight.json; workbench-profile.json. User explicitly approved the scoped mechanism after automatic review required that authorization. No real trading authorized.

## 2026-10-04 exact TabPack/monthly retirement

The dedicated `:2026-10-04-tabpack-monthly-retirement` key has priority only in the new revision. Its signed `approved_tabpack_runtime_change` must match `TABPACK_RUNTIME_CHANGE` exactly: three pinned allocator source transitions and S12 assist 1 to 0 / gate assist_entry to observe. No unknown differences are ignored. Old production continues to use the GA release key. The original admission, incumbent model, risk settings and live-order flags remain enforced. This code declaration does not grant approval to write KV.


## 2026-10-04 monthly source recovery

The new revision reads `:2026-10-04-monthly-source-recovery` before the prior TabPack key. Old revisions keep their original key. Exact source identity changes cover verified MOPS/subscription parsing and subsidiary exclusion; Worker native bundle remains unchanged. Staging needs explicit operator authorization, local simulation, exact readback and prior-key preservation. Revocation never falls back to an older grant. Monthly candidate retraining is separately user-authorized; no serving model promotion or NAV maturity transfer.


## 2026-10-05 TabPack evaluation recovery (pending operator grant)

The dedicated `:2026-10-05-tabpack-evaluation-recovery` key is staged independently before the prior monthly source key. Old revisions retain the prior key. The sole native identity source delta is `l4_prediction_evaluation.py`: recognize validated TabPack residual EV and its float64 sum while retaining the original MLP float32 contract. This does not change predictions, portfolio decisions or serving models. The Modal stage claim additionally records the provider function-call/input owner; only a restart of that exact input may resume, and partial GPU exports require review. The new key requires explicit exact-identity authorization, local admission simulation and remote readback. Existing GPU artifacts may be finalized after verification; training provenance and evaluation provenance must remain distinct. No model promotion or NAV maturity is granted.
