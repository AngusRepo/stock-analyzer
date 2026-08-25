import assert from 'node:assert/strict'
import { parseDebateConviction, parseDebateVerdict } from './debateTrader'

assert.equal(parseDebateVerdict('VERDICT: APPROVE CONVICTION: 82\n理由'), 'APPROVE')
assert.equal(parseDebateConviction('VERDICT: APPROVE CONVICTION: 82\n理由'), 82)
assert.equal(parseDebateVerdict('I cannot decide; maybe APPROVE later'), null)
assert.equal(parseDebateVerdict('Reason first\nVERDICT: APPROVE CONVICTION: 90'), null)
assert.equal(parseDebateConviction('VERDICT: APPROVE\n理由'), null)
assert.equal(parseDebateConviction('VERDICT: REJECT CONVICTION: 101'), null)
console.log('debate fail-closed parser tests passed')
