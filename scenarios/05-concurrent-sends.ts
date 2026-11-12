// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 5: sends fired at the same time. First, two different payments from one wallet. Then two
// agents whose delegations share one parent budget that can cover only one of the payments.
// Expected: one operation per Nano account at a time, and the shared budget is never overspent.
// Limit of this scenario: both sends run in one process, so they interleave at await points. Two
// gateway processes racing on one database file are not exercised here.
import { expect, type Scenario } from '../src/scenario.js'
import { used, trySend, opCount } from '../src/helpers.js'

const s: Scenario = {
  name: '05-concurrent-sends',
  summary: 'Concurrent sends from one wallet, then from two agents under one parent budget of 1500 raw sending 1000 raw each.',
  phases: [{
    name: 'concurrent sends', owner: 'runner-1',
    async run(w) {
      const a = w.seat()
      const [r1, r2] = await Promise.all([trySend(w, a, 'k-1', '1000'), trySend(w, a, 'k-2', '700')])
      const admitted = [r1, r2].filter((r: any) => r.op)
      const busy = [r1, r2].filter((r: any) => r.error === 'wallet_busy')
      const sameWallet = [
        expect('one-wallet-one-operation', admitted.length === 1 && busy.length === 1, JSON.stringify([r1, r2].map((r: any) => r.op?.status ?? r.error ?? r.denied))),
        expect('one-wallet-one-submission', w.ledger.submittedBy(a.address).length === 1, `${w.ledger.submittedBy(a.address).length} submissions`),
        expect('one-wallet-budget-held-once', BigInt(used(w, a.low)) === BigInt((admitted[0] as any)?.op?.amount_raw ?? -1), `low used ${used(w, a.low)}`),
      ]

      const b = w.seat({ limitRaw: '1500' })
      const c = w.sibling(b, { limitRaw: '1500' })
      const before = opCount(w)
      const [s1, s2] = await Promise.all([trySend(w, b, 'k-b', '1000'), trySend(w, c, 'k-c', '1000')])
      const ok = [s1, s2].filter((r: any) => r.op)
      const denied = [s1, s2].filter((r: any) => r.denied)
      return [
        ...sameWallet,
        expect('shared-budget-one-admitted', ok.length === 1 && denied.length === 1, JSON.stringify([s1, s2].map((r: any) => r.op?.status ?? r.denied ?? r.error))),
        expect('shared-budget-not-overspent', used(w, b.top) === '1000', `top used ${used(w, b.top)} of 1500`),
        expect('shared-budget-one-operation-stored', opCount(w) === before + 1, `${opCount(w) - before} new operations`),
        expect('loser-holds-nothing', BigInt(used(w, b.low)) + BigInt(used(w, c.low)) === 1000n, `low ${used(w, b.low)} + sibling ${used(w, c.low)}`),
      ]
    },
  }],
}
export default s
