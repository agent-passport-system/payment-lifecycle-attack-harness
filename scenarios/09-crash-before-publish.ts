// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 9: the gateway process dies before a block is published, twice, at two different points.
// Process A dies while preparing, before anything is signed. Process B recovers the payment, commits
// its first publish attempt and dies inside the publish call before the node receives the block.
// Process C must send the one stored block and count the payment once.
// The fake node logs a submission when the gateway makes the call, so process B's call is in the
// log although the node never stored that block.
import { expect, CRASH_EXIT, type Scenario } from '../src/scenario.js'
import { LEASE_MS } from '../src/world.js'
import { attempts, used, reservations } from '../src/helpers.js'

const s: Scenario = {
  name: '09-crash-before-publish',
  summary: 'Two crashes before the node has the block: one before signing, one after the attempt was committed. A third process finishes the payment.',
  phases: [
    {
      name: 'process A: die before signing', owner: 'runner-A', expectExit: CRASH_EXIT,
      async run(w) {
        w.seat()
        w.ledger.override = (body) => { if (body.action === 'work_generate') process.exit(CRASH_EXIT); return undefined }
        await w.send(w.meta.seats[0], 'k-1', '1000')
        throw new Error('unreachable: process A should have exited while preparing')
      },
    },
    {
      name: 'process B: recover, commit the attempt, die before the node has the block', owner: 'runner-B', expectExit: CRASH_EXIT,
      async run(w) {
        const id = w.meta.ops[0]
        const op = w.op(id)
        if (op.status !== 'reserved' || op.block_hash != null || !reservations(w, id).every(x => x === 'held')) {
          throw new Error(`process B expected a reserved, unsigned, held payment, got ${op.status} ${op.block_hash}`)
        }
        w.clock.advance(LEASE_MS + 1)
        w.saveMeta()
        w.ledger.override = (body) => { if (body.action === 'process') process.exit(CRASH_EXIT); return undefined }
        await w.tick()
        throw new Error('unreachable: process B should have exited inside the publish call')
      },
    },
    {
      name: 'process C: reopen and finish', owner: 'runner-C',
      async run(w) {
        const seat = w.meta.seats[0]
        const id = w.meta.ops[0]
        const atReopen = { op: w.op(id), att: attempts(w, id), onNode: !!w.ledger.s.blocks[w.op(id).block_hash ?? ''], res: reservations(w, id) }
        w.clock.advance(LEASE_MS + 1)
        await w.tick()
        const recovered = { op: w.op(id), att: attempts(w, id), onNode: !!w.ledger.s.blocks[w.op(id).block_hash!] }
        w.ledger.confirm(recovered.op.block_hash!)
        w.clock.advance(1_000)
        await w.tick()
        const final = w.op(id)
        const hashes = new Set(w.ledger.submittedBy(seat.address).map(x => x.hash))
        return [
          expect('reopened-admitted-outcome-unknown-node-has-nothing', atReopen.op.status === 'admitted' && atReopen.att.length === 1 && atReopen.att[0].outcome === null && !atReopen.onNode,
            `${atReopen.op.status}, attempts ${JSON.stringify(atReopen.att)}, on node ${atReopen.onNode}`),
          expect('still-held-at-reopen', atReopen.res.length === 2 && atReopen.res.every(x => x === 'held'), `${atReopen.res}`),
          expect('c-sends-the-stored-block', recovered.op.lease_owner === 'runner-C' && recovered.onNode && recovered.att.length === 2
            && recovered.att.every(a => a.block_hash === atReopen.op.block_hash), `owner ${recovered.op.lease_owner}, on node ${recovered.onNode}, ${recovered.att.length} attempts`),
          expect('one-block-across-three-processes', hashes.size === 1, `${hashes.size} distinct blocks in ${w.ledger.submittedBy(seat.address).length} calls`),
          expect('confirmed-once', final.status === 'confirmed' && used(w, seat.low) === '1000' && reservations(w, id).every(x => x === 'consumed'),
            `${final.status}, low used ${used(w, seat.low)}, ${reservations(w, id)}`),
        ]
      },
    },
  ],
}
export default s
