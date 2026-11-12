// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 1: the node answers process() with the right hash but never keeps the block, then claims
// in block_info that the block is confirmed. The source states the trust assumption: a confirmation
// comes from the configured node. This scenario measures what that assumption costs and what stops
// the damage from spreading.
import { expect, type Scenario } from '../src/scenario.js'
import { stateBlockHash } from '../vendor/gateway/src/payment-rails/nano-block.js'
import { used, frontierRecord, state, reservations } from '../src/helpers.js'

const s: Scenario = {
  name: '01-false-confirmation',
  summary: 'A lying node confirms a block it never accepted. The payment counts as spent, no money moved, and the next send must stop on the frontier record instead of building on the false state.',
  phases: [{
    name: 'lie, then the next send', owner: 'runner-1',
    async run(w) {
      const seat = w.seat()
      let ours: any = null
      w.ledger.override = (body) => {
        if (body.action === 'process') { ours = body.block; return Promise.resolve({ hash: stateBlockHash(body.block) }) }
        if (body.action === 'block_info' && ours && String(body.hash).toUpperCase() === stateBlockHash(ours)) {
          return Promise.resolve({ block_account: ours.account, confirmed: 'true', contents: ours })
        }
        return undefined
      }
      const r1 = await w.send(seat, 'k-1', '1000')
      if (!r1.op) return [expect('admitted', false, `denied: ${r1.denied}`)]
      w.clock.advance(1_000)
      await w.tick()
      const op1 = w.op(r1.op.id)
      const fakeHash = op1.block_hash!
      const afterLie = {
        status: op1.status, inLedger: !!w.ledger.s.blocks[fakeHash], usedLow: used(w, seat.low), record: frontierRecord(w, seat),
      }

      // The node is honest again. Its account is still at genesis with the full balance.
      w.ledger.override = null
      const before = w.ledger.s.processed.length
      const r2 = await w.send(seat, 'k-2', '500')
      w.clock.advance(1_000)
      await w.tick()
      const op2 = r2.op ? w.op(r2.op.id) : null
      return [
        expect('lie-accepted-as-confirmed', afterLie.status === 'confirmed',
          `${afterLie.status} (trust assumption stated in wallet-reconcile.ts: a confirmation comes from the configured node)`),
        expect('no-block-on-ledger', !afterLie.inLedger, `honest ledger has the block: ${afterLie.inLedger}`),
        expect('counted-as-spent-not-returned', afterLie.usedLow === '1000', `low used ${afterLie.usedLow}: the error costs budget, it does not create any`),
        expect('record-advanced-to-false-block', afterLie.record === fakeHash, `record ${afterLie.record}`),
        expect('second-send-reserved-not-built', op2?.status === 'reserved' && op2.block_hash == null, `op2 ${op2?.status}, block ${op2?.block_hash}`),
        expect('nothing-new-submitted', w.ledger.s.processed.length === before, `${w.ledger.s.processed.length - before} new submissions`),
        expect('second-send-held', op2 ? reservations(w, op2.id).every(x => x === 'held') : false, op2 ? reservations(w, op2.id).join(',') : 'none'),
        expect('lifecycle-degraded', state(w) === 'degraded', state(w)),
      ]
    },
  }],
}
export default s
