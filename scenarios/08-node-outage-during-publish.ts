// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 8: the node fails while a block is being published.
// Case A: the publish call fails and the node never got the block.
// Case B: the node stored the block and the connection dropped before the answer, then the node is
// unreachable for a whole pass.
// Expected in both: the payment stays open with its amount held, nothing is released, only the same
// stored block is ever sent again, new sends are refused while a pass is failing, and each payment
// counts once when its block confirms.
import { expect, type Scenario } from '../src/scenario.js'
import { REBROADCAST_MS } from '../src/world.js'
import { used, reservations, attempts, state, trySend } from '../src/helpers.js'

const s: Scenario = {
  name: '08-node-outage-during-publish',
  summary: 'The publish call fails before the node has the block, and separately after it stored the block, followed by a full outage.',
  phases: [{
    name: 'outage during publish', owner: 'runner-1',
    async run(w) {
      const a = w.seat(), b = w.seat(), c = w.seat()
      // Case A: the call fails, the node has nothing.
      w.ledger.override = (body) => body.action === 'process' ? Promise.reject(new Error('socket hang up')) : undefined
      const ra: any = await trySend(w, a, 'k-a', '1000')
      // Case B: the node stores the block, the caller sees a failure.
      w.ledger.override = (body, honest) => body.action === 'process' ? honest().then(() => { throw new Error('socket hang up') }) : undefined
      const rb: any = await trySend(w, b, 'k-b', '1000')
      const first = {
        a: w.op(ra.op.id), b: w.op(rb.op.id),
        aOnNode: !!w.ledger.s.blocks[w.op(ra.op.id).block_hash!], bOnNode: !!w.ledger.s.blocks[w.op(rb.op.id).block_hash!],
      }

      // Full outage for one pass: every call fails.
      w.ledger.override = () => Promise.reject(new Error('connect ECONNREFUSED'))
      w.clock.advance(1_000)
      await w.tick()
      const outage = { st: state(w), a: w.op(ra.op.id).status, b: w.op(rb.op.id).status,
        held: [...reservations(w, ra.op.id), ...reservations(w, rb.op.id)] }
      const during: any = await trySend(w, c, 'k-c', '100')

      // The node is back. B's block confirms before any resend is due. A's block is sent again.
      w.ledger.override = null
      w.ledger.confirm(first.b.block_hash!)
      w.clock.advance(REBROADCAST_MS + 1)
      await w.tick()
      const back = { a: w.op(ra.op.id), b: w.op(rb.op.id), attA: attempts(w, ra.op.id), attB: attempts(w, rb.op.id) }
      w.ledger.confirm(back.a.block_hash!)
      w.clock.advance(1_000)
      await w.tick()
      const end = { a: w.op(ra.op.id), st: state(w) }
      const hashesA = new Set(w.ledger.submittedBy(a.address).map(x => x.hash))
      return [
        expect('failed-call-recorded-not-released', first.a.status === 'admitted' && !first.aOnNode && attempts(w, ra.op.id)[0].outcome === 'error',
          `${first.a.status}, on node ${first.aOnNode}, outcome ${attempts(w, ra.op.id)[0].outcome}`),
        expect('lost-answer-recorded-not-released', first.b.status === 'admitted' && first.bOnNode && attempts(w, rb.op.id)[0].outcome === 'error',
          `${first.b.status}, on node ${first.bOnNode}, outcome ${attempts(w, rb.op.id)[0].outcome}`),
        expect('outage-keeps-both-open-and-held', outage.a === 'admitted' && outage.b === 'admitted' && outage.held.every(x => x === 'held'), `${outage.a} ${outage.b} ${outage.held}`),
        expect('outage-degrades-and-refuses-new-sends', outage.st === 'degraded' && !!during.notReady && !during.op, `${outage.st}, new send ${during.notReady ?? during.error ?? 'admitted'}`),
        expect('lost-answer-confirms-without-resend', back.b.status === 'confirmed' && back.attB.length === 1 && w.ledger.submittedBy(b.address).length === 1,
          `${back.b.status}, ${back.attB.length} attempts, ${w.ledger.submittedBy(b.address).length} submissions`),
        expect('failed-call-resends-the-same-block', back.attA.length === 2 && back.attA[1].outcome === 'accepted' && hashesA.size === 1,
          `${back.attA.length} attempts, second ${back.attA[1]?.outcome}, ${hashesA.size} distinct blocks`),
        expect('each-counts-once', end.a.status === 'confirmed' && used(w, a.low) === '1000' && used(w, b.low) === '1000' && used(w, c.low) === '0',
          `${end.a.status}, a ${used(w, a.low)}, b ${used(w, b.low)}, c ${used(w, c.low)}`),
        expect('lifecycle-ok-again', end.st === 'ok', end.st),
      ]
    },
  }],
}
export default s
