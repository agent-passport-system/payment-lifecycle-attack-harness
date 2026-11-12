// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 7: the paying agent's delegation is revoked while a payment is in flight.
// Case A: revoked after the block was signed and before the first publish attempt was committed.
// Expected: the payment is cancelled, nothing is published, the held amount is released.
// Case B: revoked after the attempt was committed, while the publish call is on its way to the node.
// The block reaches the node. Expected: the payment is not released (it may confirm), no further
// publish attempt is made for it, new sends are refused, and if it confirms it counts once.
import { expect, type Scenario } from '../src/scenario.js'
import { REBROADCAST_MS } from '../src/world.js'
import { used, reservations, attempts, trySend } from '../src/helpers.js'

const revoke = (w: any, id: string) => w.db.prepare(`UPDATE delegations SET status = 'revoked' WHERE id = ?`).run(id)

const s: Scenario = {
  name: '07-revocation-around-publish',
  summary: 'A delegation is revoked just before the first publish attempt (cancel and release), and just after it was committed (hold, no more attempts).',
  phases: [{
    name: 'revocation before and after the attempt commit', owner: 'runner-1',
    async run(w) {
      // Case A: revoke while the block is being prepared.
      const a = w.seat()
      w.ledger.override = (body) => { if (body.action === 'work_generate') revoke(w, a.low); return undefined }
      const ra: any = await trySend(w, a, 'k-a', '1000')
      w.ledger.override = null
      const opA = ra.op ? w.op(ra.op.id) : null
      const caseA = [
        expect('before-commit-cancelled', opA?.status === 'cancelled' && /authority_withdrawn/.test(opA?.cancel_reason ?? ''), `${opA?.status} ${opA?.cancel_reason}`),
        expect('before-commit-nothing-published', w.ledger.submittedBy(a.address).length === 0 && (opA ? attempts(w, opA.id).length : -1) === 0,
          `${w.ledger.submittedBy(a.address).length} submissions`),
        expect('before-commit-released', !!opA && reservations(w, opA.id).every(x => x === 'released') && used(w, a.low) === '0' && used(w, a.top) === '0',
          `${opA ? reservations(w, opA.id) : ''} low ${used(w, a.low)} top ${used(w, a.top)}`),
      ]

      // Case B: revoke inside the publish call, after the attempt was committed.
      const b = w.seat()
      let revoked = false
      w.ledger.override = (body) => { if (body.action === 'process' && !revoked) { revoked = true; revoke(w, b.low) } return undefined }
      const rb: any = await trySend(w, b, 'k-b', '1000')
      w.ledger.override = null
      const opB1 = w.op(rb.op.id)
      const onNode = !!w.ledger.s.blocks[opB1.block_hash!]
      w.clock.advance(REBROADCAST_MS + 1)
      const tick = await w.tick()
      const opB2 = w.op(rb.op.id)
      const again: any = await trySend(w, b, 'k-b2', '100')
      const held = { status: opB2.status, res: reservations(w, opB2.id), att: attempts(w, opB2.id).length, subs: w.ledger.submittedBy(b.address).length, low: used(w, b.low) }
      w.ledger.confirm(opB1.block_hash!)
      w.clock.advance(1_000)
      await w.tick()
      const opB3 = w.op(rb.op.id)
      return [
        ...caseA,
        expect('after-commit-block-reached-node', revoked && onNode && opB1.status === 'admitted', `revoked ${revoked}, on node ${onNode}, ${opB1.status}`),
        expect('after-commit-not-released', held.status === 'admitted' && held.res.every(x => x === 'held') && held.low === '1000', `${held.status} ${held.res} low ${held.low}`),
        expect('after-commit-no-further-attempt', held.att === 1 && held.subs === 1 && tick.some(t => t.step === 'rebroadcast_refused' && t.detail === 'delegation_not_active'),
          `${held.att} attempts, ${held.subs} submissions, steps ${JSON.stringify(tick.map(t => `${t.step}:${t.detail ?? ''}`))}`),
        expect('new-send-refused-after-revocation', !!again.denied && !again.op, `${again.denied ?? again.error ?? 'admitted'}`),
        expect('confirms-and-counts-once', opB3.status === 'confirmed' && reservations(w, opB3.id).every(x => x === 'consumed') && used(w, b.low) === '1000',
          `${opB3.status} ${reservations(w, opB3.id)} low ${used(w, b.low)}`),
      ]
    },
  }],
}
export default s
