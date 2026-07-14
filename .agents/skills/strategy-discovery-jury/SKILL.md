---
name: strategy-discovery-jury
description: Verify a StockVision strategy-discovery Jury Bundle with repository evidence and executable tests, adjudicate existing strategies, candidates, and red-team issues, then create a schema-validated codex-result.zip. Use only for the final evidence-based review of a strategy-discovery run or when given jury-bundle.zip / audits/inbox/RUN_ID.
---

# Strategy Discovery Jury

Treat Cloud LLM findings as E0/E1 hypotheses. Produce E2–E4 only from repository files, deterministic data lineage, and executable tests.

## 1. Validate the input

Run from repository root:

```powershell
npx tsx .agents/skills/strategy-discovery-jury/scripts/validate-bundle.ts <jury-bundle.zip-or-directory>
```

Stop on any run, bundle, file, schema, candidate-hash, or issue-ID mismatch. Never repair the input silently.

Read [references/output-contract.md](references/output-contract.md) before writing verdicts. Read [references/test-catalog.md](references/test-catalog.md) when selecting tests.

## 2. Isolate all work

Use a detached worktree when available; otherwise use `audits/tmp/RUN_ID/`. Put new tests and scratch artifacts only in the isolated location. Preserve the user's dirty worktree.

Do not deploy, retrain, commit, push, merge, modify production strategies, change schedulers, call brokers, or place orders.

## 3. Spawn four bounded reviewers

Spawn exactly four subagents for this review. Give each the validated bundle path, run ID, repository root, and only its bounded task. Require file paths with line ranges, commands, exit codes, and uncertainty. Do not reveal intended verdicts.

- Evidence reviewer: locate feature, strategy, timing, configuration, and source-of-truth code.
- Data & Leakage reviewer: test availability lag, point-in-time behavior, scaler/train boundaries, label overlap, survivorship, and future data.
- Test reviewer: run relevant existing tests and minimal reproductions; record commands, duration, exit code, dataset version, and artifact paths.
- Methodology reviewer: assess whether tests prove claims; audit multiple testing, split design, regime samples, costs, and extrapolation.

The main jury adjudicates evidence; never decide by vote count.

## 4. Apply evidence rules

- E0 is not a formal defect.
- E1 remains `UNVERIFIED`; an LLM claim cannot promote itself.
- E2 requires a concrete repository/config/data-lineage reference.
- E3 requires executable reproduction.
- E4 requires an independent confirming method.
- `CONFIRMED` + `FATAL` normally requires E3; deterministic leakage may use E2 only with exact file evidence.
- Without file or test evidence, use `UNVERIFIED`, `REFUTED`, or `NOT_APPLICABLE`.
- `SURVIVED` and `READY_FOR_LOCKED_TEST` never mean Alpha is proven.

## 5. Write and package results

Write every required file to `audits/outbox/RUN_ID/`. Keep commands and evidence machine-readable. Render no secrets or credentials.

```powershell
npx tsx .agents/skills/strategy-discovery-jury/scripts/package-result.ts audits/outbox/RUN_ID <jury-bundle.zip-or-directory>
```

The packager must create `audits/outbox/RUN_ID/codex-result.zip`. If it fails, fix the outputs and rerun; do not hand-build or rename a ZIP.
