-- Every shadow mutation requires an explicit inactive cutover authority row.
-- Missing authority is fail-closed in application code; this migration only
-- seeds absent domains and never advances an existing cutover state.
INSERT INTO data_domain_cutovers(domain, status, source_binding, target_binding)
VALUES
  ('core', 'legacy', 'DB', 'CORE_DB'),
  ('market', 'legacy', 'DB', 'MARKET_DB'),
  ('learning', 'legacy', 'DB', 'LEARNING_DB'),
  ('ops', 'legacy', 'DB', 'OPS_DB'),
  ('execution', 'legacy', 'DB', 'EXECUTION_DB'),
  ('paper', 'legacy', 'DB', 'PAPER_DB'),
  ('research', 'legacy', 'DB', 'RESEARCH_DB')
ON CONFLICT(domain) DO NOTHING;
