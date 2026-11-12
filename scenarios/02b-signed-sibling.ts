// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 2b: a competing block on our previous that is genuinely signed by the account key, as if
// the key were used outside the gateway. Expected: incident, wallet frozen, chain held, the
// lifecycle blocks every new send, the reservation stays held, and only an operator resolution that
// matches the recorded incident ends it. The disposition must account for the money the other
// block moved.
import { expect, type Scenario } from '../src/scenario.js'
import { resolveIncident, type IncidentResolution } from '../vendor/gateway/src/payment-rails/wallet-reconcile.js'
import { keyFor } from '../src/world.js'
import { walletStatus, reservations, chainHeld, state, used } from '../src/helpers.js'

const s: Scenario = {
  name: '02b-signed-sibling',
  summary: 'A genuinely signed competing block moves 7000 raw. Incident, freeze, block, and an operator resolution that must match the incident.',
  phases: [{
    name: 'signed sibling and operator resolution', owner: 'runner-1',
    async run(w) {
      const a = w.seat({ limitRaw: '10000' }), b = w.seat()
      const r = await w.send(a, 'k-1', '1000')
      if (!r.op) return [expect('admitted', false, `denied: ${r.denied}`)]
      const sibling = w.ledger.signedSibling(keyFor(a.index), a.frontier, '100000', '7000', true)
      w.ledger.override = (body) => body.action === 'successors' && body.block === a.frontier
        ? Promise.resolve({ blocks: [a.frontier, sibling] }) : undefined
      w.clock.advance(1_000)
      await w.tick()
      const op = w.op(r.op.id)
      const inc = JSON.parse(op.resolution ?? '{}').incident
      const denied = await w.send(b, 'k-b', '100')
      const checks = [
        expect('incident-recorded', inc?.sibling === sibling && inc?.balance_effect === 'decreased', JSON.stringify(inc ?? null)),
        expect('wallet-frozen', walletStatus(w, a.wallet) === 'frozen', walletStatus(w, a.wallet)),
        expect('chain-held', chainHeld(w, a.low), `held ${chainHeld(w, a.low)}`),
        expect('reservation-held', op.status === 'admitted' && reservations(w, op.id).every(x => x === 'held'), `${op.status} ${reservations(w, op.id)}`),
        expect('lifecycle-blocked', state(w) === 'blocked', state(w)),
        expect('new-send-refused', !!denied.notReady && !denied.op, `other tenant: ${denied.notReady ?? 'admitted'}`),
      ]
      const base: Omit<IncidentResolution, 'sources' | 'disposition'> = {
        decision: 'ours_failed', by: 'harness-operator', sibling, sibling_status: 'confirmed', balance_effect: 'decreased', now: w.clock.now(),
      }
      const second = [{ source: 'second-node', observed_at: w.clock.now() }]
      const noSource = resolveIncident(w.db, op.id, { ...base, sources: [{ source: 'fake-node', observed_at: w.clock.now() }], disposition: { kind: 'loss_recorded', amount_raw: '7000' } })
      const wrongAmount = resolveIncident(w.db, op.id, { ...base, sources: second, disposition: { kind: 'debited', adjustments: [{ delegation_id: a.low, amount_raw: '6000' }] } })
      // Charging another tenant's delegation. The refusal comes after our reservation is released
      // inside the same transaction, so this also tests the rollback.
      const crossTenant = resolveIncident(w.db, op.id, { ...base, sources: second, disposition: { kind: 'debited', adjustments: [{ delegation_id: b.low, amount_raw: '7000' }] } })
      const unchanged = w.op(op.id).status === 'admitted' && reservations(w, op.id).every(x => x === 'held') && used(w, a.low) === '1000' && used(w, b.low) === '0'
      checks.push(
        expect('refuses-reporting-node-as-source', !noSource.ok && (noSource as any).reason === 'no_independent_source', JSON.stringify(noSource)),
        expect('refuses-wrong-amount', !wrongAmount.ok && (wrongAmount as any).reason === 'adjustments_do_not_match_moved_amount', JSON.stringify(wrongAmount)),
        expect('refuses-cross-tenant-charge-and-rolls-back', !crossTenant.ok && /^adjustment_chain_unreadable/.test((crossTenant as any).reason) && unchanged,
          `${JSON.stringify(crossTenant)}, state unchanged ${unchanged}`),
      )
      const good = resolveIncident(w.db, op.id, { ...base, sources: second, disposition: { kind: 'debited', adjustments: [{ delegation_id: a.low, amount_raw: '7000' }] } })
      const after = w.op(op.id)
      checks.push(
        expect('matching-resolution-accepted', good.ok === true, JSON.stringify(good)),
        expect('our-amount-released-their-amount-charged', after.status === 'failed_final' && reservations(w, op.id).every(x => x === 'released')
          && used(w, a.low) === '7000' && used(w, a.top) === '7000', `${after.status} ${reservations(w, op.id)} low ${used(w, a.low)} top ${used(w, a.top)}`),
        expect('still-frozen-after-resolution', walletStatus(w, a.wallet) === 'frozen' && chainHeld(w, a.low), walletStatus(w, a.wallet)),
      )
      return checks
    },
  }],
}
export default s
