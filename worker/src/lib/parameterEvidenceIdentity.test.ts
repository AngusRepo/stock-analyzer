import assert from 'node:assert/strict'
import { evidenceDecision, validateParameterCandidateEvidencePacket } from './parameterCandidateRegistry'

const db = { prepare() { throw new Error('inline evidence validation must not query unrelated latest rows') } } as unknown as D1Database
const good = { candidate_id: 'candidate-A', decision: 'PASS', gate: {
  decision: 'PASS', failed_gates: [], validation_packet: { decision: 'PASS' },
} }

void (async () => {
  assert.equal(evidenceDecision(good), 'PASS')
  assert.equal(evidenceDecision({ ...good, gate: { ...good.gate, decision: 'FAIL' } }), 'FAIL')
  assert.equal(evidenceDecision({ ...good, decision: 'FAIL' }), 'FAIL')
  assert.equal(evidenceDecision({ ...good, validation_packet: { decision: 'FAIL' } }), 'FAIL')
  assert.equal(evidenceDecision({ ...good, validation_packet: { decision: 'PASS' },
    gate: { ...good.gate, validation_packet: { decision: 'FAIL' } } }), 'FAIL')
  assert.equal(evidenceDecision({ ...good, gate: { ...good.gate, failed_gates: ['failed-parity'] } }), 'FAIL')
  assert.equal(evidenceDecision({ ...good, gate: { ...good.gate, passed: false } }), 'FAIL')
  assert.equal(evidenceDecision({ candidate_id: 'candidate-A', decision: 'PASS' }), 'FAIL')

  assert.equal((await validateParameterCandidateEvidencePacket(db, {
    candidateId: 'candidate-A', evidencePacket: good,
  })).ok, true)
  for (const candidate_id of [undefined, '', {}, 'candidate-B']) {
    const result = await validateParameterCandidateEvidencePacket(db, {
      candidateId: 'candidate-A', evidencePacket: { ...good, candidate_id },
    })
    assert.equal(result.ok, false)
  }
  const conflict = await validateParameterCandidateEvidencePacket(db, {
    candidateId: 'candidate-A', promotionPacketId: 'packet-A',
    evidencePacket: { ...good, promotion_packet_id: 'packet-B' },
  })
  assert.equal(conflict.error, 'promotion_packet_mismatch')
  console.log('parameter evidence identity and contradictory verdict controls passed')
})()
