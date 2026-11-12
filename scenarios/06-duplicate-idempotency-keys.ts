// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 6: the same idempotency key used again. Twice at once for the same request, then for a
// different amount, then after the payment confirmed, then by another tenant.
// Expected: one key is one payment per tenant, a changed request under a used key is refused, and a
// retry after confirmation returns the finished payment without publishing anything.
import { expect, type Scenario } from '../src/scenario.js'
import { used, trySend, opCount } from '../src/helpers.js'

const s: Scenario = {
  name: '06-duplicate-idempotency-keys',
  summary: 'One key sent twice concurrently, reused with another amount, replayed after confirmation, and used by a second tenant.',
  phases: [{
    name: 'duplicate keys', owner: 'runner-1',
    async run(w) {
      const a = w.seat(), other = w.seat()
      const [r1, r2]: any[] = await Promise.all([trySend(w, a, 'order-1', '1000'), trySend(w, a, 'order-1', '1000')])
      const sameOp = r1.op && r2.op && r1.op.id === r2.op.id
      const afterRace = { ops: opCount(w), subs: w.ledger.submittedBy(a.address).length, low: used(w, a.low) }

      const changed: any = await trySend(w, a, 'order-1', '999')
      const afterChanged = { ops: opCount(w), low: used(w, a.low) }

      w.ledger.confirm(r1.op.block_hash ?? w.op(r1.op.id).block_hash!)
      w.clock.advance(1_000)
      await w.tick()
      const replay: any = await trySend(w, a, 'order-1', '1000')
      const afterReplay = { subs: w.ledger.submittedBy(a.address).length, low: used(w, a.low) }

      const foreign: any = await trySend(w, other, 'order-1', '1000')
      return [
        expect('same-key-at-once-one-operation', !!sameOp && afterRace.ops === 1, `ids ${r1.op?.id === r2.op?.id ? 'equal' : 'differ'}, ${afterRace.ops} operations`),
        expect('same-key-at-once-one-submission', afterRace.subs === 1 && afterRace.low === '1000', `${afterRace.subs} submissions, low used ${afterRace.low}`),
        expect('changed-request-refused', changed.error === 'idempotency_mismatch' && afterChanged.ops === 1 && afterChanged.low === '1000',
          `${changed.error ?? changed.op?.status ?? changed.denied}, ${afterChanged.ops} operations, low used ${afterChanged.low}`),
        expect('replay-after-confirmation-returns-it', replay.op?.id === r1.op.id && replay.op?.status === 'confirmed', `${replay.op?.status ?? replay.error ?? replay.denied}`),
        expect('replay-publishes-and-debits-nothing', afterReplay.subs === 1 && afterReplay.low === '1000', `${afterReplay.subs} submissions, low used ${afterReplay.low}`),
        expect('other-tenant-same-key-is-its-own-payment', !!foreign.op && foreign.op.id !== r1.op.id && used(w, other.low) === '1000',
          `${foreign.op ? 'own operation' : foreign.error ?? foreign.denied}, other low used ${used(w, other.low)}`),
      ]
    },
  }],
}
export default s
