# Workflow A release handoff

Deployment owner is Claude via CI/CD; Wei approves the exact SHA. Codex opens PRs only.

## Protected identity files / c3592857

`c3592857` changes the execution owner in `services/native_execution_behavior_release.json`
and `services/strategy_nav_source_release.json`. This integration preserves both files
from the base branch, byte for byte. It does not reset them to the old R30 snapshot,
set source_equivalence, disable admission, or declare changed runtime bytes equivalent.

Before release, Claude must regenerate these two files and Paper admission using
the final merged Worker/controller source. Any identity rejection before that step
remains a real release gate. A passing private-account fixture is not admission.

## Jobs

`workflow_a_jobs.json` contains the entrypoints and triggers. Claude must reconcile
them with the CI application-job inventory and source/image alignment checks before
creating/updating provider jobs. This PR does not execute provider commands.

- `postclose-research-dispatch` invokes the GCP dispatcher after close; it starts
  the source-aligned dataset snapshot job. No Worker cron is required.
- `l4-shadow-daily` validates the current registry, every full-chain source and the
  preopen clock before preparing persistent private accounts. It never infers an
  old entry using active/new L3 output or resets its ledger each morning.
- `l4-shadow-execution` calls the existing native tick; missing registry, daily
  sources or expired frames cannot report success.
- Explicit bootstrap runs only after B gate and formal L3/L4 pointer publication.
  It requires reviewed entry/opening receipts and GCS approval. Normal jobs cannot
  register candidates or switch the production pointer.

## Still required before A2 can be called end-to-end complete

The full-chain daily inference owner must publish each registered entry's native
day source and the generation/SHA-bound index. The producer deliberately rejects
missing or mismatched source identity; the new input-contract code alone does not
prove the old c53 complete chain has run. Bind the publisher to source completion,
then validate two real trading sessions and original native fills. The current
two-day fixture covers isolated state/cash continuity, not real-market execution.

GCS bootstrap/daily writes need their own scope approval; the A5 US$25 approval
covers only its research full-fit outputs, not these account namespaces.

## Other pending gates

- Claude's uncommitted risk changes are not copied or redone in this worktree.
  After N/risk merge into main, rebase and rerun affected source/behavior tests.
- P6-a B is conditional on the new inner metrics. No R16 b or checkpoint can stand
  in for a newly trained candidate. EB remains unregistered.
- No live-order validation is authorized by a local fixture. Odd-lot broker test
  credentials/environment and the precise run approval remain separate.
- Nine-day full-chain TimesFM parity, all-archive solver metrics, live recorder
  connection and premarket timing acceptance remain explicit gates, not waived by PR.
