// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Positive control. An honest node, one payment, confirmed. If this fails, the harness is broken,
// not the gateway, and no attack result means anything.
import { expect, type Scenario } from '../src/scenario.js'

const s: Scenario = {
  name: '00-honest-send',
  summary: 'Honest node: a 1000 raw payment is reserved, signed, published once, confirmed, and the frontier record advances.',
  phases: [{
    name: 'send and confirm', owner: 'runner-1',
    async run(w) {
      const seat = w.seat()
      const r = await w.send(seat, 'k-1', '1000')
      if (!r.op) return [expect('admitted', false, `denied: ${r.denied}`)]
      const hash = r.op.block_hash!
      w.ledger.confirm(hash)
      w.clock.advance(1_000)
      await w.tick()
      const op = w.op(r.op.id)
      const used = (id: string) => (w.db.prepare(`SELECT spend_used_minor AS u FROM delegations WHERE id = ?`).get(id) as any).u
      const front = w.db.prepare(`SELECT frontier FROM wallet_frontiers WHERE nano_account = ?`).get(seat.address) as any
      return [
        expect('published-once', w.ledger.submittedBy(seat.address).length === 1, `${w.ledger.submittedBy(seat.address).length} submissions`),
        expect('confirmed', op.status === 'confirmed', op.status),
        expect('budget-consumed', used(seat.low) === '1000' && used(seat.top) === '1000', `low ${used(seat.low)} top ${used(seat.top)}`),
        expect('frontier-advanced', front?.frontier === hash, `record ${front?.frontier}`),
        expect('lifecycle-ok', w.lifecycle.status().state === 'ok', w.lifecycle.status().state),
      ]
    },
  }],
}
export default s
