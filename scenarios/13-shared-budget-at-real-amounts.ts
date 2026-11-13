// Copyright 2026 The HORIZONs Co., Ltd. Apache-2.0 license. See LICENSE.
// Contributed by an outside tester (aeoess/agent-governance-vocabulary#177). Not part of the author's set.
// Attack 13: the shared-budget race of scenario 05 at real Nano magnitudes (1 XNO = 10^30 raw), where
// floating point would lose the last digits. The parent budget is 1 raw short of two payments.
// Expected: one of two simultaneous 1 XNO payments is refused, the parent is charged exactly once,
// and afterwards the remainder can be spent to the last raw and not one raw more.
import { expect, type Scenario } from '../src/scenario.js'
import { used, trySend } from '../src/helpers.js'

const XNO = 10n ** 30n
const s: Scenario = {
  name: '13-shared-budget-at-real-amounts',
  summary: 'Two agents under one parent budget of 2 XNO minus 1 raw each send 1 XNO at once, then the remainder is spent to the last raw.',
  phases: [{
    name: 'shared budget at 10^30 raw', owner: 'runner-1',
    async run(w) {
      const limit = (2n * XNO - 1n).toString()
      const b = w.seat({ limitRaw: limit, balanceRaw: (10n * XNO).toString() })
      const c = w.sibling(b, { limitRaw: limit, balanceRaw: (10n * XNO).toString() })
      const [s1, s2]: any[] = await Promise.all([trySend(w, b, 'k-b', XNO.toString()), trySend(w, c, 'k-c', XNO.toString())])
      const ok = [s1, s2].filter(r => r.op), denied = [s1, s2].filter(r => r.denied)
      const topAfterRace = used(w, b.top)
      const winner = s1.op ? b : c, loser = s1.op ? c : b
      const winOp = (s1.op ?? s2.op)
      w.ledger.confirm(w.op(winOp.id).block_hash!); w.clock.advance(1_000); await w.tick()
      const rest = (XNO - 1n).toString()
      const r3: any = await trySend(w, loser, 'k-rest', rest)
      if (r3.op) { w.ledger.confirm(w.op(r3.op.id).block_hash!); w.clock.advance(1_000); await w.tick() }
      const r4: any = await trySend(w, winner, 'k-one-more', '1')
      return [
        expect('one-admitted-one-refused', ok.length === 1 && denied.length === 1, JSON.stringify([s1, s2].map(r => r.op?.status ?? r.denied ?? r.error))),
        expect('parent-charged-once-exactly', topAfterRace === XNO.toString(), `top used ${topAfterRace}`),
        expect('remainder-spendable-to-the-last-raw', !!r3.op && used(w, b.top) === limit, `${r3.op?.status ?? r3.denied ?? r3.error}; top used ${used(w, b.top)} of ${limit}`),
        expect('one-raw-more-refused', !!r4.denied && !r4.op && used(w, b.top) === limit, `${r4.denied ?? r4.error ?? 'admitted'}; top used ${used(w, b.top)}`),
      ]
    },
  }],
}
export default s
