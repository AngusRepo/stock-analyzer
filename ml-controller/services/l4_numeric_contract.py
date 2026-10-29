"""Named L4 engineering constants; not trading decisions, so not KV-owned.

`worker/src/lib/l4NumericContract.ts` mirrors WEIGHT_SUPPORT and a contract
test pins both sides to the same value.
"""

# A target or holding weight above this counts as a held position.
WEIGHT_SUPPORT = 1e-7
# Daily return observations a symbol needs before risk can price it.
MIN_RETURN_OBSERVATIONS = 20
# Daily volatility floor for Ledoit-Wolf / similarity estimates.
DAILY_VOL_FLOOR = 0.01
