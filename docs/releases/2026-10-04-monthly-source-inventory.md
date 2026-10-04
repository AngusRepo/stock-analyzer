# Monthly source inventory recovery

Production 092b981f OOF root fc-01M43KA7PKCJGEYGNAV925MJC1 failed TimeXer in both initial windows: adjusted prep rebuilt source_checksums from NPZ files only, dropping feature_names.json included in the verified immutable receipt. Full-fit independently requires identical inventories and would also fail. Stopped this exact root; observed root and active tree children TERMINATED. Completed artifacts retained. No model promotion.

Fix: preserve the complete verified source inventory; recheck shard and metadata bytes at consumption; reject stale idempotent manifests lacking the full inventory. TimeXer additionally verifies feature_names bytes. Regression builds real adjusted artifacts and passes them to both TimeXer materialization and Controller full-fit verification; mutated metadata is rejected. Related tests: 39 passed.

Includes pending research source enrichment 153bd2d3. Filter announcements on behalf of important subsidiaries before parent-stock enrichment; historical research remains blocked until exact missing evidence is verified. Native Paper execution unchanged; deployment requires same existing Paper runtime PASS. Resume original monthly scheduler ticket after consistent source deployment, promote=false.
