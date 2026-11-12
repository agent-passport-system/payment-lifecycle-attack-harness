// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// One racing gateway process: tsx src/racer.ts <dir> <owner> <node-url> <start-at-epoch-ms> <job-json>
// Opens the shared database, waits for the common start time, does one job and writes
// <dir>/racer-<owner>.json. Jobs: {"kind":"send","seat":0,"key":"k","amount":"1000"} sends a payment
// (optional "to" overrides the recipient), {"kind":"reserve", ...} runs only the reserve step of the
// same path and never schedules or publishes, {"kind":"tick","advance":30001} moves this process's
// clock and runs one lifecycle pass.
import { writeFileSync } from 'node:fs'
import { openWorld, DEST, LEASE_MS } from './world.js'
import { getWalletService } from '../vendor/gateway/src/payment-rails/wallet.js'

const [dir, owner, nodeUrl, startAtRaw, jobRaw] = process.argv.slice(2)
const startAt = Number(startAtRaw)
const job = JSON.parse(jobRaw)
const w = await openWorld(dir, { owner, racer: { nodeUrl } })
const readyAt = Date.now()
while (Date.now() < startAt - 20) await new Promise((r) => setTimeout(r, 5))
while (Date.now() < startAt) { /* spin for the last milliseconds */ }
const firedAt = Date.now()
let result: any
try {
  if (job.kind === 'send') {
    const r = await w.send(w.meta.seats[job.seat], job.key, job.amount, job.to)
    result = r.op ? { op: r.op.id, status: r.op.status } : { denied: r.denied, notReady: r.notReady ?? null }
  } else if (job.kind === 'reserve') {
    // The reserve step of POST /wallets/send without runner.schedule: the operation stays as the
    // reserve left it (reserved, or replayed, or refused), so a scenario can hold a wallet busy or
    // race two reserves. A reservation made here keeps this process as its lease owner.
    const s = w.meta.seats[job.seat]
    const r: any = await getWalletService().reserveSendOp({
      tenantId: s.tenant, fromAgentId: s.agent, toAddress: job.to ?? DEST.address, amountRaw: job.amount,
      idempotencyKey: job.key, claim: { owner, now: w.clock.now(), leaseMs: LEASE_MS }, notReady: null,
    })
    result = r.replay ? { reserve: 'replay', opId: r.op.id } : { reserve: 'reserved', opId: r.op.id }
  } else {
    w.clock.advance(job.advance)
    result = { steps: (await w.tick()).map((s) => `${s.step}${s.detail ? ':' + s.detail : ''}`) }
  }
} catch (e: any) {
  result = e?.name === 'WalletOpError' ? { error: String(e.code) } : { exception: String(e?.code ?? e?.name), message: String(e?.message ?? e).slice(0, 200) }
}
writeFileSync(`${dir}/racer-${owner}.json`, JSON.stringify({ owner, ready_before_start_ms: startAt - readyAt, fired_late_ms: firedAt - startAt, done_ms: Date.now() - firedAt, result }))
w.lifecycle.stop()
process.exit(0)
