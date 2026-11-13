// Copyright 2026 The HORIZONs Co., Ltd. Apache-2.0 license. See LICENSE.
// Contributed by an outside tester (aeoess/agent-governance-vocabulary#177). Not part of the author's set.
// Attack 12: the node stores the published block and then answers the publish call with an explicit
// rejection. Case A: the call throws ("Fork"). Case B: the call returns an error object with no hash.
// Question: does an explicit rejection return the held budget, or lead to a second, different block?
// Expected: the reservation stays held without an operator decision, every attempt carries the one
// stored block, and when the kept block confirms the payment counts once.
import { expect, type Scenario } from '../src/scenario.js'
import { REBROADCAST_MS } from '../src/world.js'
import { used, reservations, attempts, trySend } from '../src/helpers.js'

const s: Scenario = {
  name: '12-node-rejects-a-kept-block',
  summary: 'The node keeps the block and answers publish with an explicit rejection, as a thrown error and as an error object.',
  phases: [{
    name: 'explicit rejection of a kept block', owner: 'runner-1',
    async run(w) {
      const out: any[] = []
      for (const mode of ['throw', 'object'] as const) {
        const a = w.seat()
        let rejections = 0
        w.ledger.override = (body, honest) => {
          if (body.action === 'process' && body.block?.account === a.address) {
            rejections++
            return honest().then(() => { if (mode === 'throw') throw new Error('Nano RPC: Fork'); return { error: 'Fork' } })
          }
          return undefined
        }
        const r: any = await trySend(w, a, `k-${mode}`, '1000')
        const op1 = w.op(r.op.id)
        const kept = !!w.ledger.s.blocks[op1.block_hash!]
        w.clock.advance(REBROADCAST_MS + 1)
        const t1 = await w.tick()
        const op2 = w.op(r.op.id)
        const held = { status: op2.status, res: reservations(w, op2.id), low: used(w, a.low), att: attempts(w, op2.id) }
        w.ledger.override = null
        w.ledger.confirm(op1.block_hash!)
        w.clock.advance(1_000)
        await w.tick()
        const op3 = w.op(r.op.id)
        out.push(
          expect(`${mode}-node-kept-the-block-and-rejected`, kept && rejections >= 1, `kept ${kept}, ${rejections} rejections`),
          expect(`${mode}-held-without-operator`, held.status === 'admitted' && held.res.every((x: string) => x === 'held') && held.low === '1000',
            `${held.status} ${held.res} low ${held.low}; steps ${JSON.stringify(t1.map(t => `${t.step}:${t.detail ?? ''}`))}`),
          expect(`${mode}-one-block-across-attempts`, new Set(held.att.map((x: any) => x.block_hash)).size === 1 && op2.block_hash === op1.block_hash,
            `${held.att.length} attempts, outcomes ${held.att.map((x: any) => x.outcome)}`),
          expect(`${mode}-confirms-and-counts-once`, op3.status === 'confirmed' && reservations(w, op3.id).every((x: string) => x === 'consumed') && used(w, a.low) === '1000',
            `${op3.status} ${reservations(w, op3.id)} low ${used(w, a.low)}`),
        )
      }
      return out
    },
  }],
}
export default s
