const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = fs.readFileSync('src/lib/s12TwEquityCalibration.ts', 'utf8')

assert(
  source.includes("WHERE status = 'approved'"),
  'serving resolver must continue to read approved calibration artifacts only',
)
assert(
  source.includes('for (const artifact of artifacts)'),
  'calibration run must persist both approved and rejected candidate evidence',
)
assert(
  source.includes("if (artifact.status === 'approved') await db.prepare"),
  'only approved artifacts may supersede the serving scope',
)
assert(source.includes('failed_gates: failedGates'), 'candidate metrics must preserve exact failed gates')
assert(source.includes('CANONICAL_SELECTION_ROUNDTRIP_COST_BPS'), 'S12 calibration must share the canonical round-trip cost owner')
assert(source.includes('const netPnlPct = grossPnlPct - CANONICAL_SELECTION_ROUNDTRIP_COST_BPS / 10_000'), 'S12 calibration target must be cost-net before converting to R')
assert(source.includes("return_unit: 'r_multiple'"), 'S12 artifact must declare risk-multiple units')
assert(source.includes("return_basis: 'net_after_roundtrip_cost'"), 'S12 artifact must declare cost-net return basis')
assert(source.includes('failed_gate_distribution'), 'run summary must preserve failed-gate distribution')
