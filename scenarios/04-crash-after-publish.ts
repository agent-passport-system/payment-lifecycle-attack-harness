// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 4: the node accepts our block and the gateway process dies before it records the node's
// answer. A fresh process on the same database file must not build a second block, must resubmit
// only the stored one, and must count the payment once.
import { expect, CRASH_EXIT, type Scenario } from '../src/scenario.js'
import { LEASE_MS } from '../src/world.js'
import { attempts, used, reservations } from '../src/helpers.js'

const s: Scenario = {
  name: '04-crash-after-publish',
  summary: 'Process A dies after process() reached the node and before the outcome was written. Process B, with a new owner, recovers the payment.',
  phases: [
    {
      name: 'process A: publish, then die', owner: 'runner-A', expectExit: CRASH_EXIT,
      async run(w) {
        w.seat()
        w.saveMeta()
        w.ledger.override = (body, honest) => {
          if (body.action !== 'process') return undefined
          return honest().then(() => { process.exit(CRASH_EXIT) })
        }
        await w.send(w.meta.seats[0], 'k-1', '1000')
        throw new Error('unreachable: process A should have exited inside process()')
      },
    },
    {
      name: 'process B: reopen and recover', owner: 'runner-B',
      async run(w) {
        const seat = w.meta.seats[0]
        const id = w.meta.ops[0]
        const atReopen = { op: w.op(id), att: attempts(w, id), subs: w.ledger.submittedBy(seat.address).length }
        w.clock.advance(LEASE_MS + 1)
        await w.tick()
        const afterRecover = { op: w.op(id), att: attempts(w, id), subs: w.ledger.submittedBy(seat.address) }
        w.ledger.confirm(afterRecover.op.block_hash!)
        w.clock.advance(1_000)
        await w.tick()
        const final = w.op(id)
        const hashes = new Set(afterRecover.subs.map(x => x.hash))
        return [
          expect('reopened-admitted-outcome-unknown', atReopen.op.status === 'admitted' && atReopen.att.length === 1 && atReopen.att[0].outcome === null && atReopen.subs === 1,
            `${atReopen.op.status}, attempts ${JSON.stringify(atReopen.att)}, submissions ${atReopen.subs}`),
          expect('b-took-over', afterRecover.op.lease_owner === 'runner-B', `owner ${afterRecover.op.lease_owner}`),
          expect('resubmitted-same-block', afterRecover.att.length === 2 && afterRecover.att.every(a => a.block_hash === atReopen.op.block_hash) && hashes.size === 1 && afterRecover.subs.length === 2,
            `attempts ${afterRecover.att.length}, distinct submitted ${hashes.size}, submissions ${afterRecover.subs.length}`),
          expect('first-attempt-stays-unknown', afterRecover.att[0].outcome === null, `attempt 1 outcome ${afterRecover.att[0].outcome}`),
          expect('confirmed-once', final.status === 'confirmed' && used(w, seat.low) === '1000' && reservations(w, id).every(x => x === 'consumed'),
            `${final.status}, low used ${used(w, seat.low)}, ${reservations(w, id)}`),
        ]
      },
    },
  ],
}
export default s
