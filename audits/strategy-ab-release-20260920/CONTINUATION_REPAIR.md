# Formal compute continuation repair

Observed production failure: 2026-09-20 20:41:05 UTC, active8-oof-daily reported `oof_cohort_continuation_exhausted:status=pending:attempt=12`, although the bound Modal A call remained running and had completed two windows. The old five-minute, twelve-poll budget was shorter than complete five-window CPCV training, queue time, and full-fit work.

The controller now probes the original immutable cohort call. Only verified running compute gets the bounded 64-poll budget; unknown/failed dependencies retain the twelve-poll limit. Worker polling backs off 5, 10, 20, then 30 minutes. The total delay covers two serialized eight-hour OOF ceilings plus the five-hour full-fit ceiling. No wait grants retraining, serving, NAV credit, or promotion. Provider liveness replaces the unsafe six-hour age shortcut for duplicate dispatch protection. Exact A/B cohort identity stays pinned; a concurrent manifest publication is re-read rather than misclassified as failure.

Validation: 128 controller tests passed, including actual lifecycle requests for both variants beyond poll twelve, original dependency-failure exhaustion, NAV/adoption ordering, and full-fit contracts. Worker policy, collision, scheduler-source contract, five dispatch cases, fourteen real SQLite callback/ticket cases, and type-check passed. Added these controller regressions to P9. Preceding release 7653d33f passed complete remote P9 (run35535499010).

The source repair does not alter any model algorithm or feature. Formal OOF jobs remain on source d9949ab8 while running. At 21:00:47 UTC Modal reported a platform preemption, then restarted the same tree-window input; this was not an OOM report. Existing completed windows remain in the orchestrator. Deployment of the controller/Modal source transition must preserve in-flight artifacts and their actual provenance.

Not complete yet: both formal five-window OOF manifests, exact-eight full-fit/L4 candidate registration, matched A/B declarations, prospective account/UI readback. A is selected, not active. L3 NAV remains required.
