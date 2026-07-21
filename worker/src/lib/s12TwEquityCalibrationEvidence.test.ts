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
assert(source.includes('failed_gate_distribution'), 'run summary must preserve failed-gate distribution')
