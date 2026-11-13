// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Attack 11: the pre-registered cross-process idempotency battery, contributed from an independent
// run. The rows below were registered before the run in x402-foundation/x402#4198 (comment
// 6817874244, R2 split amended in 6831739390), then executed against the gateway at pin 99888e8
// with a separate two-process runner and sealed as argus-seal-0021 in the Argus Agent Test Lab
// registry (verify: git clone https://github.com/igor-vii/Argus-Agent-Test-Lab && cd
// Argus-Agent-Test-Lab && node tools/registry/verify-registry.mjs). This scenario re-expresses the
// same registered rows in this harness's layout; every row passed the independent run, so each
// check here documents behavior the gateway already showed at that pin.
//
// Trials, two OS processes per trial (racer jobs from src/racer.ts):
//   R1  same key, same payment: sequenced A-then-B, B-then-A, and simultaneous. The winner
//       reserves, prepares, commits and publishes once; the loser observes the original operation
//       (replay) without reserving or signing. Sequenced = the first racer's process exits before
//       the second starts, so the first mover's reserve commits first by construction.
//   R2a key already on record, both processes race a changed request: one changes the amount, one
//       the recipient. Both are refused (idempotency_mismatch); the stored row is untouched and no
//       node is called. The pre-existing operation is reserved by this setup process and never
//       scheduled, as in the registered row.
//   R2b fresh key, two processes racing different amounts (1000 vs 2000): exactly one reservation,
//       the loser is refused, and the budget is charged once, by the winner only. Racers run the
//       reserve step only: the registered row ends with the operation still reserved.
//   R3  different keys, one wallet, first payment unfinished: the second reserve is refused with
//       wallet_busy, neither process signs, one unfinished operation remains.
//   R4  retry after publication, across processes: process A sends and publishes (accepted).
//       Process B retries the same key and receives the original operation back and never signs.
//       A lifecycle pass in B's own process then takes the expired lease over and republishes the
//       same stored block: two identical submissions, attempts [1: accepted, 2: accepted].
//       Unlike the independent run, which drove takeOver/commit/publish directly, this goes through
//       the gateway's own tick recovery path (takeover, rebroadcast of the stored block).
//
// Invariant (registered): one reservation per R1 trial, the budget charged exactly once in every
// row, and no delegation counter past its limit anywhere.
import { expect, type Scenario } from '../src/scenario.js'
import { race, type RacerReport } from '../src/race.js'
import { serveLedger } from '../src/node-server.js'
import { DEST, LEASE_MS, REBROADCAST_MS } from '../src/world.js'
import { used, attempts, reservations } from '../src/helpers.js'
import { getWalletService } from '../vendor/gateway/src/payment-rails/wallet.js'
import { nano } from '../src/deps.js'

const DEST2 = nano.wallet.fromLegacySeed('ee'.repeat(32)).accounts[0].address
/** How far a simultaneous racer may fire after the shared start and still count as simultaneous. */
const SIM_WINDOW_MS = 250

/** Deep canonical JSON: sorted keys, so two parses of byte-identical documents compare equal. */
const canon = (v: any): string => JSON.stringify(sortDeep(v))
function sortDeep(x: any): any {
  if (Array.isArray(x)) return x.map(sortDeep)
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, sortDeep(x[k])]))
  return x
}

type Report = RacerReport | undefined
const resultOf = (r: Report) => (r ? (r.result ?? {}) : { exception: 'no_report' })
const late = (reports: Report[]) => Math.max(...reports.map(r => (r && Number.isFinite(r.fired_late_ms) ? r.fired_late_ms : Number.MAX_SAFE_INTEGER)))

const s: Scenario = {
  name: '14-cross-process-idempotency',
  summary: 'The registered cross-process idempotency battery: same key, changed request, fresh-key amounts, wallet busy, and a retry after publication, each from two processes.',
  phases: [{
    name: 'five registered rows, twelve trials', owner: 'runner-1',
    async run(w) {
      const node = await serveLedger(w.ledger)
      const seatIndex = (seat: { wallet: string }) => w.meta.seats.findIndex(x => x.wallet === seat.wallet)
      const opsFor = (address: string) => w.db.prepare(`SELECT id, status, block_hash, amount_raw, block_json FROM wallet_ops WHERE nano_account = ?`).all(address) as any[]
      const checks: Check[] = []
      const add = (id: string, ok: boolean, detail: string) => checks.push(expect(id, ok, detail))
      const invR1: boolean[] = []
      const invBudget: boolean[] = []

      // One racer per call, started only after the previous one exited: a sequenced trial whose
      // first mover is fixed by construction, the same interleave the registered modes pin.
      const runRacer = async (tag: string, job: object): Promise<Report> => (await race(w, node.url, tag, [job]))[0]
      const sim = async (tag: string, jobs: object[]): Promise<Report[]> => {
        const reports = await race(w, node.url, tag, jobs)
        w.clock.advance(1_000)
        return reports
      }
      const logMark = () => w.ledger.log.length
      const callsSince = (mark: number) => w.ledger.log.slice(mark)

      try {
        // ── R1: same key, same payment, two processes ─────────────────────────────────────────
        for (const mode of ['A', 'B', 'sim'] as const) {
          const id = `r1-${mode}`
          const seat = w.seat()
          const si = seatIndex(seat)
          const mark = logMark()
          const jobs = [{ kind: 'send', seat: si, key: 'k-r1', amount: '1000' }, { kind: 'send', seat: si, key: 'k-r1', amount: '1000' }]
          const reports = mode === 'sim'
            ? await sim(`R1-${mode}`, jobs)
            : [await runRacer(`R1-${mode}-1`, jobs[mode === 'A' ? 0 : 1]), await runRacer(`R1-${mode}-2`, jobs[mode === 'A' ? 1 : 0])]
          const [ra, rb] = reports.map(resultOf)
          const opRows = opsFor(seat.address)
          const op = opRows.length === 1 ? w.op(opRows[0].id) : null
          const procs = callsSince(mark).filter(c => c.action === 'process')
          const row = (test: string, ok: boolean, detail: string) => add(`${id}-${test}`, ok, detail)
          row('both-observe-one-operation', !!op && ra.op === rb.op && ra.op === (op && op.id) && !ra.error && !rb.error && !ra.exception && !rb.exception,
            `results ${JSON.stringify([ra, rb])}, op rows ${opRows.length}`)
          row('one-reservation', !!op && reservations(w, op.id).length === 2 && new Set(reservations(w, op.id)).size >= 1 && opRows.length === 1,
            `hold rows ${op ? reservations(w, op.id).join(',') : 'none'} (one per delegation level)`)
          row('budget-charged-once', used(w, seat.top) === '1000' && used(w, seat.low) === '1000',
            `top ${used(w, seat.top)} low ${used(w, seat.low)}`)
          row('published-once-and-admitted', !!op && op.status === 'admitted' && procs.length === 1 && attempts(w, op.id).length === 1 && attempts(w, op.id)[0].outcome === 'accepted',
            `status ${op && op.status}, process calls ${procs.length}, attempts ${attempts(w, op.id).map(a => a.outcome).join(',')}`)
          row('one-signature', callsSince(mark).filter(c => c.action === 'work_generate').length === 1,
            `node calls ${callsSince(mark).map(c => c.action).join(',')}`)
          if (op && procs.length === 1) {
            row('published-block-is-the-stored-block', canon(procs[0].req.block) === canon(JSON.parse(op.block_json!)),
              'process call vs stored block_json')
          } else row('published-block-is-the-stored-block', false, `process calls ${procs.length}, op ${op && op.id}`)
          invR1.push(!!op && opRows.length === 1 && reservations(w, op!.id).every(x => x === 'held' || x === 'consumed'))
          invBudget.push(used(w, seat.top) === '1000' && used(w, seat.low) === '1000')
          if (mode === 'sim') add('r1-sim-was-simultaneous', late(reports) <= SIM_WINDOW_MS, `latest racer fired ${late(reports)} ms after the start`)
          w.clock.advance(1_000)
        }

        // ── R2a: key already on record, both processes race a changed request ────────────────
        for (const variant of ['amount-first', 'recipient-first'] as const) {
          const id = `r2a-${variant === 'amount-first' ? '1' : '2'}`
          const seat = w.seat()
          const si = seatIndex(seat)
          const reserved: any = await getWalletService().reserveSendOp({
            tenantId: seat.tenant, fromAgentId: seat.agent, toAddress: DEST.address, amountRaw: '1000', idempotencyKey: 'k-r2a',
            claim: { owner: 'gone-setup', now: w.clock.now(), leaseMs: LEASE_MS }, notReady: null,
          })
          const preOp = reserved.op
          w.meta.ops.push(preOp.id)
          const before = w.db.prepare(`SELECT * FROM wallet_ops WHERE id = ?`).get(preOp.id)
          const mark = logMark()
          const changedAmount = { kind: 'send', seat: si, key: 'k-r2a', amount: '2000' }
          const changedRecipient = { kind: 'send', seat: si, key: 'k-r2a', amount: '1000', to: DEST2 }
          const reports = await sim(`R2a-${variant}`, variant === 'amount-first' ? [changedAmount, changedRecipient] : [changedRecipient, changedAmount])
          const results = reports.map(resultOf)
          const after = w.db.prepare(`SELECT * FROM wallet_ops WHERE id = ?`).get(preOp.id)
          add(`${id}-both-refused`, results.every(r => r.error === 'idempotency_mismatch'),
            `results ${JSON.stringify(results.map(r => r.error ?? r.exception ?? r.op?.status))}`)
          add(`${id}-zero-new-reservations`, opsFor(seat.address).length === 1 && reservations(w, preOp.id).every(r => r === 'held'),
            `op rows ${opsFor(seat.address).length}, holds ${reservations(w, preOp.id).join(',')}`)
          add(`${id}-stored-row-byte-identical`, !!after && canon(before) === canon(after), 'pre-race snapshot vs post-race row')
          add(`${id}-budget-untouched`, used(w, seat.top) === '1000' && used(w, seat.low) === '1000',
            `top ${used(w, seat.top)} low ${used(w, seat.low)}`)
          add(`${id}-no-node-calls`, callsSince(mark).length === 0, `node calls ${callsSince(mark).map(c => c.action).join(',')}`)
          invBudget.push(used(w, seat.top) === '1000' && used(w, seat.low) === '1000')
          w.clock.advance(1_000)
        }

        // ── R2b: fresh key, two processes racing different amounts ────────────────────────────
        for (const mode of ['A', 'B', 'sim'] as const) {
          const id = `r2b-${mode}`
          const seat = w.seat()
          const si = seatIndex(seat)
          const mark = logMark()
          const jobs = [{ kind: 'reserve', seat: si, key: 'k-r2b', amount: '1000' }, { kind: 'reserve', seat: si, key: 'k-r2b', amount: '2000' }]
          const reports = mode === 'sim'
            ? await sim(`R2b-${mode}`, jobs)
            : [await runRacer(`R2b-${mode}-1`, jobs[mode === 'A' ? 0 : 1]), await runRacer(`R2b-${mode}-2`, jobs[mode === 'A' ? 1 : 0])]
          const results = reports.map(resultOf)
          const winner = reports.findIndex((_, i) => results[i].reserve === 'reserved')
          const loser = 1 - winner
          const opRows = opsFor(seat.address)
          const winAmount = mode === 'A' ? '1000' : mode === 'B' ? '2000' : String(opRows[0]?.amount_raw ?? '?')
          add(`${id}-one-reservation-one-refused`, results.filter(r => r.reserve === 'reserved').length === 1
            && results[loser] && results[loser].error === 'idempotency_mismatch',
            `results ${JSON.stringify(results.map(r => r.reserve ?? r.error ?? r.exception))}`)
          if (mode !== 'sim') add(`${id}-first-mover-won`, winner === 0, `winner position ${winner}, mode ${mode}`)
          add(`${id}-one-op-still-reserved`, opRows.length === 1 && opRows[0].status === 'reserved', `op rows ${opRows.length}, status ${opRows[0] && opRows[0].status}`)
          add(`${id}-budget-by-winner-only`, used(w, seat.top) === winAmount && used(w, seat.low) === winAmount,
            `top ${used(w, seat.top)} low ${used(w, seat.low)}, winner amount ${winAmount}`)
          add(`${id}-no-node-calls`, callsSince(mark).length === 0, `node calls ${callsSince(mark).map(c => c.action).join(',')}`)
          invBudget.push(used(w, seat.top) === winAmount && used(w, seat.low) === winAmount)
          if (mode === 'sim') add('r2b-sim-was-simultaneous', late(reports) <= SIM_WINDOW_MS, `latest racer fired ${late(reports)} ms after the start`)
          w.clock.advance(1_000)
        }

        // ── R3: different keys, one wallet, first payment unfinished ──────────────────────────
        for (const mode of ['A', 'B', 'sim'] as const) {
          const id = `r3-${mode}`
          const seat = w.seat()
          const si = seatIndex(seat)
          const mark = logMark()
          const jobs = [{ kind: 'reserve', seat: si, key: 'k-r3-a', amount: '1000' }, { kind: 'reserve', seat: si, key: 'k-r3-b', amount: '1000' }]
          const reports = mode === 'sim'
            ? await sim(`R3-${mode}`, jobs)
            : [await runRacer(`R3-${mode}-1`, jobs[0]), await runRacer(`R3-${mode}-2`, jobs[1])]
          const results = reports.map(resultOf)
          const opRows = opsFor(seat.address)
          add(`${id}-one-reserved-one-wallet-busy`, results.filter(r => r.reserve === 'reserved').length === 1
            && results.filter(r => r.error === 'wallet_busy').length === 1,
            `results ${JSON.stringify(results.map(r => r.reserve ?? r.error ?? r.exception))}`)
          add(`${id}-one-unfinished-op`, opRows.length === 1 && opRows[0].status === 'reserved', `op rows ${opRows.length}, status ${opRows[0] && opRows[0].status}`)
          add(`${id}-neither-signs`, callsSince(mark).length === 0, `node calls ${callsSince(mark).map(c => c.action).join(',')}`)
          add(`${id}-budget-charged-once`, used(w, seat.top) === '1000' && used(w, seat.low) === '1000',
            `top ${used(w, seat.top)} low ${used(w, seat.low)}`)
          invBudget.push(used(w, seat.top) === '1000' && used(w, seat.low) === '1000')
          if (mode === 'sim') add('r3-sim-was-simultaneous', late(reports) <= SIM_WINDOW_MS, `latest racer fired ${late(reports)} ms after the start`)
          w.clock.advance(1_000)
        }

        // ── Settle rows R1-R3 before row R4 ──────────────────────────────────────────────────
        // Rows R1-R3 deliberately leave operations open (reserved, or admitted and unconfirmed).
        // This process takes the expired leases over, publishes what is still reserved, confirms
        // everything, and lets the lifecycle mark it confirmed — so row R4's retry pass below
        // runs against its own operation only. Every row verdict above was already recorded.
        w.clock.advance(LEASE_MS + 1_000)
        await w.tick()
        for (const row of w.db.prepare(`SELECT block_hash FROM wallet_ops WHERE status = 'admitted'`).all() as any[]) {
          if (w.ledger.s.blocks[row.block_hash]) w.ledger.confirm(row.block_hash)
        }
        w.clock.advance(1_000)
        await w.tick()

        // ── R4: retry after publication, across processes ─────────────────────────────────────
        {
          const seat = w.seat()
          const si = seatIndex(seat)
          const mark = logMark()
          const a = resultOf(await runRacer('R4-A', { kind: 'send', seat: si, key: 'k-r4', amount: '1000' }))
          const opId = a.op
          const op = opId ? w.op(opId) : null
          add('r4-a-published', !!op && op.status === 'admitted' && attempts(w, opId!).length === 1 && attempts(w, opId!)[0].outcome === 'accepted',
            `A result ${JSON.stringify(a)}, status ${op && op.status}`)

          const b1Mark = logMark()
          const b1 = resultOf(await runRacer('R4-B1', { kind: 'send', seat: si, key: 'k-r4', amount: '1000' }))
          add('r4-b-replays-original', b1.op === opId && callsSince(b1Mark).length === 0,
            `B result ${JSON.stringify(b1)}, A op ${opId}, node calls during retry ${callsSince(b1Mark).length}`)

          const b2 = resultOf(await runRacer('R4-B2', { kind: 'tick', advance: LEASE_MS + REBROADCAST_MS + 1_000 }))
          const fresh = opId ? w.op(opId) : null
          const att = opId ? attempts(w, opId) : []
          const procs = w.ledger.log.slice(mark).filter(c => c.action === 'process')
          add('r4-b-never-signs', b2.steps && Array.isArray(b2.steps) && callsSince(mark).filter(c => c.action === 'work_generate').length === 1,
            `B2 steps ${JSON.stringify(b2.steps ?? b2)}, work_generate calls total ${callsSince(mark).filter(c => c.action === 'work_generate').length}`)
          add('r4-two-identical-submissions', procs.length === 2 && canon(procs[0].req.block) === canon(procs[1].req.block),
            `process calls ${procs.length}, identical ${procs.length === 2 && canon(procs[0].req.block) === canon(procs[1].req.block)}`)
          add('r4-attempts-recorded', att.length === 2 && att.every(x => x.outcome === 'accepted'),
            `attempts ${att.map(x => `${x.attempt_no}:${x.outcome}`).join(',')}`)
          add('r4-stored-block-matches', !!fresh && procs.length === 2 && canon(JSON.parse(fresh.block_json!)) === canon(procs[0].req.block),
            'stored block_json vs the submitted block')
          add('r4-budget-charged-once', used(w, seat.top) === '1000' && used(w, seat.low) === '1000',
            `top ${used(w, seat.top)} low ${used(w, seat.low)}`)
          add('r4-one-op', opsFor(seat.address).length === 1 && reservations(w, opId!).every(x => x === 'held' || x === 'consumed'),
            `op rows ${opsFor(seat.address).length}, holds ${opId ? reservations(w, opId).join(',') : 'none'}`)
          invBudget.push(used(w, seat.top) === '1000' && used(w, seat.low) === '1000')
          w.clock.advance(LEASE_MS + REBROADCAST_MS + 2_000)
        }
      } finally {
        await node.close()
      }

      // The registered invariant row, over every trial above.
      const underflow = (w.db.prepare(`SELECT id, spend_limit_minor AS l, spend_used_minor AS u FROM delegations`).all() as any[])
        .filter(d => BigInt(d.u) > BigInt(d.l)).map(d => d.id)
      add('inv-one-reservation-in-every-R1', invR1.length === 3 && invR1.every(Boolean), `${invR1.filter(Boolean).length} of ${invR1.length} R1 trials`)
      add('inv-budget-charged-exactly-once', invBudget.length === 12 && invBudget.every(Boolean), `${invBudget.filter(Boolean).length} of ${invBudget.length} trials`)
      add('inv-no-budget-underflow', underflow.length === 0, underflow.length ? `over limit: ${underflow.join(',')}` : 'every delegation within its limit')
      return checks
    },
  }],
}
type Check = ReturnType<typeof expect>
export default s
