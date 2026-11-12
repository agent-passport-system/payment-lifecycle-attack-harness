// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 10: two separate gateway processes on one database file, released at the same instant.
// The earlier concurrent scenarios run inside one process. Here each racer is its own operating
// system process with its own database connection, and both reach the fake node over HTTP through
// the gateway's own RPC client.
// Four races, several rounds each:
//   A  both send the same payment under the same idempotency key
//   B  both send a different payment from the same wallet
//   C  two agents under one parent budget of 1500 raw each send 1000 raw
//   D  both run a lifecycle pass over one reserved payment whose lease has just expired
// Limit: "the same instant" is a shared wall-clock start time. Each racer reports how late it fired,
// and a round only counts as a race if both fired within RACE_WINDOW_MS of the start.
import { expect, type Scenario } from '../src/scenario.js'
import { getWalletService } from '../vendor/gateway/src/payment-rails/wallet.js'
import { serveLedger } from '../src/node-server.js'
import { race, type RacerReport } from '../src/race.js'
import { DEST, LEASE_MS } from '../src/world.js'
import { used, attempts, reservations } from '../src/helpers.js'

const ROUNDS = 3
const RACE_WINDOW_MS = 25

const s: Scenario = {
  name: '10-two-process-race',
  summary: 'Two gateway processes race on one database file: same key, same wallet, shared budget, and one payment to recover.',
  phases: [{
    name: 'two processes, four races', owner: 'runner-1',
    async run(w) {
      const node = await serveLedger(w.ledger)
      const seatIndex = (seat: { wallet: string }) => w.meta.seats.findIndex((x) => x.wallet === seat.wallet)
      const opsFor = (address: string) => w.db.prepare(`SELECT id, status, block_hash, amount_raw FROM wallet_ops WHERE nano_account = ?`).all(address) as any[]
      const bad: string[] = []
      const exceptions: string[] = []
      const lateness: number[] = []
      let counted = 0
      const note = (tag: string, reports: RacerReport[]) => {
        for (const r of reports) {
          lateness.push(r.fired_late_ms)
          if (r.result.exception) exceptions.push(`${tag} ${r.owner}: ${r.result.exception} ${r.result.message}`)
        }
        if (reports.every((r) => r.fired_late_ms >= 0 && r.fired_late_ms <= RACE_WINDOW_MS)) counted++
      }
      const submitted = (address: string) => new Set(w.ledger.submittedBy(address).map((x) => x.hash)).size

      try {
        for (let r = 1; r <= ROUNDS; r++) {
          // A: same key, same payment.
          const a = w.seat()
          const ra = await race(w, node.url, `A${r}`, [1, 2].map(() => ({ kind: 'send', seat: seatIndex(a), key: `dup-${r}`, amount: '1000' })))
          note(`A${r}`, ra)
          const opsA = opsFor(a.address)
          const idsA = ra.map((x) => x.result.op)
          if (!(opsA.length === 1 && idsA[0] && idsA[0] === idsA[1] && used(w, a.low) === '1000' && submitted(a.address) === 1)) {
            bad.push(`A${r}: ${opsA.length} operations, results ${JSON.stringify(ra.map((x) => x.result))}, low used ${used(w, a.low)}, ${submitted(a.address)} distinct blocks`)
          }

          // B: two different payments, one wallet.
          const b = w.seat()
          const rb = await race(w, node.url, `B${r}`, [{ kind: 'send', seat: seatIndex(b), key: `b1-${r}`, amount: '1000' }, { kind: 'send', seat: seatIndex(b), key: `b2-${r}`, amount: '700' }])
          note(`B${r}`, rb)
          const opsB = opsFor(b.address)
          const wonB = rb.filter((x) => x.result.op).length, busyB = rb.filter((x) => x.result.error === 'wallet_busy').length
          if (!(opsB.length === 1 && wonB === 1 && busyB === 1 && used(w, b.low) === opsB[0].amount_raw && submitted(b.address) === 1)) {
            bad.push(`B${r}: ${opsB.length} operations, results ${JSON.stringify(rb.map((x) => x.result))}, low used ${used(w, b.low)}, ${submitted(b.address)} distinct blocks`)
          }

          // C: two agents, one parent budget that covers only one payment.
          const c = w.seat({ limitRaw: '1500' })
          const d = w.sibling(c, { limitRaw: '1500' })
          const rc = await race(w, node.url, `C${r}`, [{ kind: 'send', seat: seatIndex(c), key: `c-${r}`, amount: '1000' }, { kind: 'send', seat: seatIndex(d), key: `d-${r}`, amount: '1000' }])
          note(`C${r}`, rc)
          const wonC = rc.filter((x) => x.result.op).length, deniedC = rc.filter((x) => /budget/.test(String(x.result.denied))).length
          if (!(wonC === 1 && deniedC === 1 && used(w, c.top) === '1000' && opsFor(c.address).length + opsFor(d.address).length === 1)) {
            bad.push(`C${r}: results ${JSON.stringify(rc.map((x) => x.result))}, top used ${used(w, c.top)} of 1500`)
          }

          // D: one reserved payment held by a process that is gone. Both racers move their clock past its lease and run a pass.
          const e = w.seat()
          const reserved: any = await getWalletService().reserveSendOp({
            tenantId: e.tenant, fromAgentId: e.agent, toAddress: DEST.address, amountRaw: '1000', idempotencyKey: `e-${r}`,
            claim: { owner: 'gone-process', now: w.clock.now(), leaseMs: LEASE_MS }, notReady: null,
          })
          if (!reserved.op) { bad.push(`D${r}: could not reserve: ${JSON.stringify(reserved)}`); continue }
          w.meta.ops.push(reserved.op.id)
          const rd = await race(w, node.url, `D${r}`, [1, 2].map(() => ({ kind: 'tick', advance: LEASE_MS + 1 })))
          note(`D${r}`, rd)
          const opD = w.op(reserved.op.id)
          const att = attempts(w, opD.id)
          const hashes = new Set(att.map((x) => x.block_hash))
          if (!(opD.status === 'admitted' && att.length >= 1 && hashes.size === 1 && submitted(e.address) === 1 && reservations(w, opD.id).every((x) => x === 'held') && used(w, e.low) === '1000')) {
            bad.push(`D${r}: ${opD.status}, ${att.length} attempts over ${hashes.size} blocks, ${submitted(e.address)} distinct blocks sent, steps ${JSON.stringify(rd.map((x) => x.result))}`)
          }
        }
      } finally {
        await node.close()
      }

      // Every racer is gone. This process takes the open payments over, the node confirms them, each counts once.
      w.clock.advance(3 * LEASE_MS)
      await w.tick()
      for (const row of w.db.prepare(`SELECT block_hash FROM wallet_ops WHERE status = 'admitted'`).all() as any[]) {
        if (w.ledger.s.blocks[row.block_hash]) w.ledger.confirm(row.block_hash)
      }
      w.clock.advance(1_000)
      await w.tick()
      const open = (w.db.prepare(`SELECT COUNT(*) AS c FROM wallet_ops WHERE status IN ('reserved', 'prepared', 'admitted')`).get() as any).c
      const confirmed = (w.db.prepare(`SELECT COUNT(*) AS c FROM wallet_ops WHERE status = 'confirmed'`).get() as any).c
      const maxLate = Math.max(...lateness.filter((x) => Number.isFinite(x)))
      return [
        expect('every-race-had-one-winner', bad.length === 0, bad.length ? bad.join(' | ') : `${ROUNDS} rounds of 4 races, each with exactly one payment and one signed block`),
        expect('no-unexpected-errors', exceptions.length === 0, exceptions.length ? exceptions.join(' | ') : 'every loser got a replay, wallet_busy, a budget refusal or claimed_elsewhere'),
        expect('rounds-were-real-races', counted === ROUNDS * 4, `${counted} of ${ROUNDS * 4} rounds had both processes fire within ${RACE_WINDOW_MS} ms of the start (latest ${maxLate} ms)`),
        expect('all-settle-once', open === 0 && confirmed === ROUNDS * 4, `${confirmed} confirmed, ${open} still open, expected ${ROUNDS * 4} confirmed`),
      ]
    },
  }],
}
export default s
