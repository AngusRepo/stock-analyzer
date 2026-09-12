# September 7 evening-chain recovery

Scope: root ticket failure/recovery only. No NAV gate, accounting migration,
model retraining, changed promotion threshold or real order is authorized here.

Observed failure: Modal inference expected a49a1cc9 but deployed aad36a98.
Do not bypass pipeline_modal_source_sha_mismatch. Deploy the exact same release
identity to Worker, Controller/jobs and Modal ML; verify remote provenance before
dispatch. A service deployment without its jobs/Modal is not release closure.

The failed pipeline callback must invoke the existing root closure owner even
when post-verify has not run. Canonical identity comes from pipeline_execution;
the ticket transition is fenced by that active identity. Old downstream runs
cannot terminalize the current pipeline. Recovery still requires all stages,
strategy-learning counts/policy, and snapshot/Active-8 lineage.

Release protocol:
1. Test these four source/test files on a clean origin/main descendant.
2. Commit and fast-forward main without overwriting the separate NAV worktree.
3. Capture runtime settings, source identities, active executions and pointers.
4. Stage Controller with no traffic; verify health and unchanged settings.
5. Deploy and read back Modal ML provenance, update matching jobs/Controller and
   Worker. Preserve all non-provenance operational settings.
6. Resume September7 through its canonical workflow owner using date-bound
   inputs, not broad KV/ticket resets or forced stage success.
7. Read the actual closure receipt and domain counts. Retain failed attempt
   evidence. Workflow completion is not model promotion or NAV maturity credit.

No database migration or frontend deployment is needed for this scoped fix.
