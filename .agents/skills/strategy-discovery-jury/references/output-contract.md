# Output contract

Create these files directly under `audits/outbox/RUN_ID/`:

- `final-verdict.json`
- `final-report.md`
- `strategy-verdicts.json`
- `candidate-verdicts.json`
- `issue-verdicts.json`
- `tests-executed.json`
- `repository-evidence.json`
- `unresolved-evidence.json`
- `candidate-recommendations.json`

`final-verdict.json` requires `schema_version=codex-final-verdict-v1`, matching `run_id`, matching `bundle_hash`, and `executive_conclusion` with `overall_health`, `most_severe_issue`, `confirmed_leakage`, `invalid_strategy_count`, `locked_test_candidate_count`, and `summary`.

Every row in the other JSON arrays requires matching `run_id` and its owner ID.

- Strategy verdict: `INVALID | BLOCKED | RETEST_REQUIRED | SURVIVED | INSUFFICIENT_EVIDENCE`.
- Candidate verdict: `REJECTED | BLOCKED | RETEST_REQUIRED | READY_FOR_LOCKED_TEST | INSUFFICIENT_EVIDENCE`.
- Issue verdict: `CONFIRMED | PARTIALLY_CONFIRMED | REFUTED | UNVERIFIED | NOT_APPLICABLE`.

Issue verdict rows require `severity`, `evidence_level`, `evidence`, `commands_executed`, `test_results`, `remaining_uncertainty`, `required_fix`, and `blocks_target`.

`tests-executed.json` rows include `command`, `exit_code`, `duration_ms`, `status`, `target_ids`, and `evidence_paths`.

`repository-evidence.json` rows include `file`, `line_start`, `line_end`, `finding`, and `target_ids`. Use repository-relative paths and no secrets.

`unresolved-evidence.json` separates unverifiable issues and missing data. `candidate-recommendations.json` records locked-test eligibility and forward-shadow advice without promotion or deployment instructions.
