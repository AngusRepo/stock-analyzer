-- The scheduler status read (loadSchedulerExecutionTickets / loadLatestSchedulerRootTickets:
-- business_date IN (7 dates) ORDER BY updated_at DESC) had no business_date-leading index, so every
-- /api/scheduler/status call scanned the whole ticket table (prod 11/25: 51,882 rows per call for
-- ~2,759 rows in the 7-day window). business_date only, on purpose: with updated_at in the key the
-- planner moved the per-job LIMIT 1 lookup off idx_scheduler_execution_tickets_job_date to save its sort.
CREATE INDEX IF NOT EXISTS idx_scheduler_execution_tickets_business_date
  ON scheduler_execution_tickets_v1(business_date);
