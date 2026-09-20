# Date/market ranking performance correction — 2026-09-21

The ranking owner previously rebuilt each group with a Python scan over every row. A single grouping pass now records the original row indices and retains the existing stable sorting, average-tie percentile, finite-value filter and singleton-neutral semantics. No rows, dates or markets are removed.

Full corrected canonical dataset: 761,302 mature rows, 823 date/market cohorts. Isolated local processes using identical inputs: old 59.654780s / 118.336 MiB peak RSS; new 0.841799s / 136.059 MiB peak RSS. Both output arrays have identical bytes SHA-256 69ea2e2b6b3f2eaeb626fa4dfde024a83848955f4fb0cd2c14eb82d6bb182a68. This is a 70.87x speedup of the ranking function only, with about 17.72 MiB additional peak RSS. It is not an end-to-end runtime or strategy-return claim.

23 ranking, canonical-target and Controller score-semantic tests pass. Added independent SciPy rankdata comparison includes shuffled input, ties, nonfinite scores, singleton and empty groups. The remaining sorting and arithmetic code is unchanged.

Raw evidence: rank-grouping-benchmark.log, rank-grouping-tests.log, rank-benchmark/input-receipt.json, old/new-result.json and old/new-ranks.npy. Input blobs were individually verified against the immutable canonical manifest. Benchmarking does not retrain or promote a model.
