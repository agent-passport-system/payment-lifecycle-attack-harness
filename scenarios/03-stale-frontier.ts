// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 3: after one confirmed payment, the node reports an older account state (a lagging or
// rolled back node), then the right frontier with an inflated balance. Building on either would sign
// a second block on an old previous or a block with a wrong balance. Expected: the send waits,
// reserved, with nothing signed or submitted, until the node agrees with the frontier record.
import { expect, type Scenario } from '../src/scenario.js'
import { reservations, frontierRecord, state } from '../src/helpers.js'

const s: Scenario = {
  name: '03-stale-frontier',
  summary: 'The node reports a stale frontier, then an inflated balance. No second block may be built until the node matches the record.',
  phases: [{
    name: 'stale node after a confirmed send', owner: 'runner-1',
    async run(w) {
      const seat = w.seat()
      const r1 = await w.send(seat, 'k-1', '1000')
      if (!r1.op) return [expect('admitted', false, `denied: ${r1.denied}`)]
      w.ledger.confirm(r1.op.block_hash!)
      w.clock.advance(1_000)
      await w.tick()
      const h1 = r1.op.block_hash!
      const recordOk = frontierRecord(w, seat) === h1 && w.op(r1.op.id).status === 'confirmed'

      const stale = { frontier: seat.frontier, confirmed_frontier: seat.frontier, confirmed_balance: '100000', confirmed_representative: seat.address }
      w.ledger.override = (body) => body.action === 'account_info' && body.account === seat.address ? Promise.resolve(stale) : undefined
      const r2 = await w.send(seat, 'k-2', '500')
      if (!r2.op) return [expect('second-admitted', false, `denied: ${r2.denied}`)]
      w.clock.advance(1_000)
      await w.tick()
      const afterStale = { op: w.op(r2.op.id), subs: w.ledger.submittedBy(seat.address).length, st: state(w) }

      const inflated = { frontier: h1, confirmed_frontier: h1, confirmed_balance: '999999', confirmed_representative: seat.address }
      w.ledger.override = (body) => body.action === 'account_info' && body.account === seat.address ? Promise.resolve(inflated) : undefined
      w.clock.advance(1_000)
      await w.tick()
      const afterInflated = { op: w.op(r2.op.id), subs: w.ledger.submittedBy(seat.address).length }

      w.ledger.override = null
      w.clock.advance(1_000)
      await w.tick()
      const built = w.op(r2.op.id)
      const sub = w.ledger.submittedBy(seat.address)
      return [
        expect('first-confirmed-record-advanced', recordOk, `record ${frontierRecord(w, seat)}`),
        expect('stale-node-nothing-built', afterStale.op.status === 'reserved' && afterStale.op.block_hash == null && afterStale.subs === 1,
          `${afterStale.op.status}, block ${afterStale.op.block_hash}, submissions ${afterStale.subs}`),
        expect('stale-node-degrades-lifecycle', afterStale.st === 'degraded', afterStale.st),
        expect('inflated-balance-nothing-built', afterInflated.op.status === 'reserved' && afterInflated.op.block_hash == null && afterInflated.subs === 1,
          `${afterInflated.op.status}, submissions ${afterInflated.subs}`),
        expect('money-held-while-waiting', reservations(w, r2.op.id).every(x => x === 'held'), reservations(w, r2.op.id).join(',')),
        expect('honest-node-builds-on-record', built.status === 'admitted' && built.block_previous === h1 && sub.length === 2 && sub[1].previous === h1,
          `${built.status}, previous ${built.block_previous}, submissions ${sub.length}`),
      ]
    },
  }],
}
export default s
