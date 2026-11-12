// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 2a: the node invents a competing block on our previous with a signature that does not
// verify. A node that can make the gateway freeze wallets on a forged block could freeze any
// tenant at will. Expected: node fault, nothing frozen, the payment stays open with its money held,
// and the lifecycle refuses new sends while the node keeps lying.
import { expect, type Scenario } from '../src/scenario.js'
import { resolveNodeFault } from '../vendor/gateway/src/payment-rails/wallet-reconcile.js'
import { keyFor } from '../src/world.js'
import { walletStatus, reservations, chainHeld, state } from '../src/helpers.js'

const s: Scenario = {
  name: '02a-fabricated-sibling',
  summary: 'A node reports a competing block with an invalid signature. It must count as a node fault, never as an incident.',
  phases: [{
    name: 'forged sibling', owner: 'runner-1',
    async run(w) {
      const a = w.seat(), b = w.seat()
      const r = await w.send(a, 'k-1', '1000')
      if (!r.op) return [expect('admitted', false, `denied: ${r.denied}`)]
      const forged = w.ledger.fabricatedSibling(keyFor(a.index), a.frontier, '100000', '9000')
      w.ledger.override = (body) => body.action === 'successors' && body.block === a.frontier
        ? Promise.resolve({ blocks: [a.frontier, forged] }) : undefined
      w.clock.advance(1_000)
      await w.tick()
      const op = w.op(r.op.id)
      const res = JSON.parse(op.resolution ?? '{}')
      const denied = await w.send(b, 'k-b', '100')
      const checks = [
        expect('node-fault-recorded', res.node_fault?.reason === 'sibling_signature_invalid', JSON.stringify(res.node_fault ?? null)),
        expect('no-incident', !res.incident, `incident ${JSON.stringify(res.incident ?? null)}`),
        expect('wallet-not-frozen', walletStatus(w, a.wallet) === 'active', walletStatus(w, a.wallet)),
        expect('chain-not-held', !chainHeld(w, a.low), `held ${chainHeld(w, a.low)}`),
        expect('payment-open-and-held', op.status === 'admitted' && reservations(w, op.id).every(x => x === 'held'), `${op.status} ${reservations(w, op.id)}`),
        expect('lifecycle-degraded', state(w) === 'degraded', state(w)),
        expect('new-send-refused', !!denied.notReady && !denied.op, `other tenant: ${denied.notReady ?? 'admitted'}`),
      ]
      // The operator records the fault as handled, but the node still lies on the next pass.
      const handled = resolveNodeFault(w.db, op.id, { by: 'harness-operator', evidence: 'replaced node (simulated)', now: w.clock.now() })
      w.clock.advance(1_000)
      await w.tick()
      const again = JSON.parse(w.op(op.id).resolution ?? '{}').node_fault
      checks.push(expect('fault-reraised-while-node-lies', handled && again && !again.resolved, `handled ${handled}, now ${JSON.stringify(again)}`))
      // The node is honest again and confirms our block: the payment completes normally.
      w.ledger.override = null
      w.ledger.confirm(op.block_hash!)
      w.clock.advance(1_000)
      await w.tick()
      checks.push(expect('completes-after-honest-node', w.op(op.id).status === 'confirmed', w.op(op.id).status))
      return checks
    },
  }],
}
export default s
