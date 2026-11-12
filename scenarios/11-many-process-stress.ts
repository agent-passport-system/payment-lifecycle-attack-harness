// Copyright 2026 Stian Skogbrott. Apache-2.0 license. See LICENSE.
// Six gateway processes on one database file. Each round opens a fresh group of six wallets under
// one shared parent budget, so every round runs into a budget limit again.
// Each process sends random payments, retries keys, runs lifecycle passes with its clock moved past
// the lease (taking payments over from owners that are still alive), and half are set to be killed
// with SIGKILL part-way (a process that finishes first is not killed). The node confirms blocks while they run. Every budget is sampled throughout.
// This is a random search, not a proof: it reports what it ran. STRESS_ROUNDS sets the round count.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Scenario } from '../src/scenario.js'
import { serveLedger } from '../src/node-server.js'
import { LEASE_MS } from '../src/world.js'

const root = resolve(new URL('..', import.meta.url).pathname)
const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 8), PROCS = 6, ITER = 14, TOP = 4000n, WALLETS = 6

const s: Scenario = {
  name: '11-many-process-stress',
  summary: `${PROCS} processes, ${ROUNDS} rounds, a fresh group of ${WALLETS} wallets under one budget of ${TOP} raw each round, random kills and lease takeovers.`,
  phases: [{
    name: 'stress', owner: 'runner-1',
    async run(w) {
      const seats: any[] = [], tops: string[] = []
      const node = await serveLedger(w.ledger)
      const violations: string[] = []
      let samples = 0, maxUsed = 0n, killed = 0, exceptions: string[] = [], sends = 0
      const sample = () => {
        const snap = w.db.transaction(() => ({
          dels: w.db.prepare(`SELECT d.id, d.spend_used_minor AS u, d.spend_limit_minor AS l,
            (SELECT COALESCE(SUM(CAST(amount_raw AS INTEGER)), 0) FROM wallet_op_reservations r WHERE r.delegation_id = d.id AND r.status IN ('held', 'consumed')) AS s FROM delegations d`).all() as any[],
          multi: w.db.prepare(`SELECT nano_account, COUNT(*) AS c FROM wallet_ops WHERE status IN ('reserved', 'prepared', 'admitted') GROUP BY nano_account HAVING c > 1`).all(),
        }))()
        samples++
        for (const d of snap.dels) {
          const used = BigInt(d.u), res = BigInt(d.s)
          if (tops.includes(d.id) && used > maxUsed) maxUsed = used
          if (used > BigInt(d.l)) violations.push(`${d.id} used ${used} > ${d.l}`)
          if (used !== res) violations.push(`${d.id} used ${used} != reservations ${res}`)
        }
        if (snap.multi.length) violations.push(`two operations in flight on one account`)
      }
      try {
        for (let r = 1; r <= ROUNDS; r++) {
          const first = w.seat({ limitRaw: String(TOP) })
          const group = [first, ...Array.from({ length: WALLETS - 1 }, () => w.sibling(first, { limitRaw: String(TOP) }))]
          const idx = group.map((g) => w.meta.seats.findIndex((x) => x.wallet === g.wallet))
          seats.push(...group); tops.push(first.top)
          w.clock.advance(2 * LEASE_MS); w.saveMeta()
          const startAt = Date.now() + 3500
          const timer = setInterval(() => {
            try {
              sample()
              // The node confirms what it holds, but never a second block on a previous it already confirmed.
              for (const [h, b] of Object.entries(w.ledger.s.blocks)) {
                if (!b.confirmed && w.ledger.s.heads[b.account]?.frontier === String(b.block.previous).toUpperCase() && Math.random() < 0.5) w.ledger.confirm(h)
              }
            } catch (e: any) { violations.push(`sampler: ${e.message}`) }
          }, 15)
          await Promise.all(Array.from({ length: PROCS }, (_, i) => new Promise<void>((done) => {
            const owner = `S${r}-p${i + 1}`
            const kill = i % 2 === 0 ? 40 + Math.floor(Math.random() * 500) : null
            const child = spawn(`${root}/node_modules/.bin/tsx`, [`${root}/src/stress-racer.ts`, w.dir, owner, node.url, String(startAt),
              JSON.stringify({ seats: idx, iterations: ITER, seed: r * 1000 + i * 7 + Math.floor(Math.random() * 1e6), killAfterMs: kill, skew: i % 3 !== 1 })],
              { stdio: ['ignore', 'ignore', 'ignore'] })
            child.on('exit', () => {
              const p = `${w.dir}/stress-${owner}.json`
              if (!existsSync(p)) killed++
              else for (const l of JSON.parse(readFileSync(p, 'utf8')).log as string[]) { if (l.startsWith('EXC:')) exceptions.push(`${owner} ${l}`); if (l.startsWith('op:')) sends++ }
              done()
            })
          })))
          clearInterval(timer); sample()
        }
      } finally { await node.close() }

      // Every racer is gone. Drain: take everything over, confirm what the node holds, repeat.
      for (let i = 0; i < 40; i++) {
        w.clock.advance(2 * LEASE_MS); await w.tick()
        for (const [h, b] of Object.entries(w.ledger.s.blocks)) if (!b.confirmed && w.ledger.s.heads[b.account]?.frontier === String(b.block.previous).toUpperCase()) w.ledger.confirm(h)
        sample()
      }
      const open = w.db.prepare(`SELECT status, COUNT(*) AS c FROM wallet_ops GROUP BY status`).all() as any[]
      const counts = Object.fromEntries(open.map((r) => [r.status, r.c]))
      const multiBlock = (w.db.prepare(`SELECT COUNT(*) AS c FROM (SELECT op_id FROM wallet_op_attempts GROUP BY op_id HAVING COUNT(DISTINCT block_hash) > 1)`).get() as any).c
      const confirmedSum = BigInt((w.db.prepare(`SELECT COALESCE(SUM(CAST(amount_raw AS INTEGER)), 0) AS s FROM wallet_ops WHERE status = 'confirmed'`).get() as any).s)
      // What actually left the wallets on the node, against what the budgets say was spent.
      const leftNode = seats.reduce((sum, st) => sum + (100000n - BigInt(w.ledger.s.heads[st.address].balance)), 0n)
      const topUsed = tops.reduce((sum, id) => sum + BigInt((w.db.prepare(`SELECT spend_used_minor AS u FROM delegations WHERE id = ?`).get(id) as any).u), 0n)
      const unconfirmedOnNode = Object.values(w.ledger.s.blocks).filter((b) => !b.confirmed).length
      return [
        expect('ran', sends > 0 && killed > 0, `${ROUNDS} rounds x ${PROCS} processes, ${sends} sends reported by the processes that finished, ${killed} processes killed, ${samples} budget samples, peak use of one budget ${maxUsed} of ${TOP}, final ${JSON.stringify(counts)}`),
        expect('budget-never-exceeded-or-unaccounted', violations.length === 0, violations.length ? [...new Set(violations)].slice(0, 6).join(' | ') : `${samples} samples clean`),
        expect('no-unexpected-exceptions', exceptions.length === 0, exceptions.slice(0, 5).join(' | ') || 'none'),
        expect('one-block-per-payment', multiBlock === 0, `${multiBlock} payments with more than one block`),
        expect('everything-settles', !counts.reserved && !counts.prepared && !counts.admitted, JSON.stringify(counts)),
        expect('node-and-budget-agree', leftNode === confirmedSum && topUsed === confirmedSum && unconfirmedOnNode === 0,
          `left the wallets on the node ${leftNode}, confirmed payments ${confirmedSum}, all budgets used ${topUsed}, ${unconfirmedOnNode} unconfirmed blocks left on the node`),
      ]
    },
  }],
}
export default s
