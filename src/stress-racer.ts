// Copyright 2026 Stian Skogbrott. Apache-2.0 license. See LICENSE.
// One gateway process in the stress race: tsx src/stress-racer.ts <dir> <owner> <node-url> <start-at> <job-json>
// job: { seats: number[], iterations: number, seed: number, killAfterMs: number | null, skew: boolean }
// Sends random payments from random seats, sometimes moves its own clock past the lease and runs a
// lifecycle pass (so it takes over payments whose owner is still alive), and may kill itself.
// It writes <dir>/stress-<owner>.json when it finishes. A killed process writes nothing.
import { writeFileSync } from 'node:fs'
import { openWorld, LEASE_MS } from './world.js'

const [dir, owner, nodeUrl, startAtRaw, jobRaw] = process.argv.slice(2)
const job = JSON.parse(jobRaw)
let seed = job.seed >>> 0
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const w = await openWorld(dir, { owner, racer: { nodeUrl } })
while (Date.now() < Number(startAtRaw)) await new Promise((r) => setTimeout(r, 2))
if (job.killAfterMs != null) setTimeout(() => process.kill(process.pid, 'SIGKILL'), job.killAfterMs)
const log: string[] = []
for (let i = 0; i < job.iterations; i++) {
  try {
    if (job.skew && rnd() < 0.35) {
      w.clock.advance(LEASE_MS + 1)
      log.push(`tick:${(await w.tick()).map((s) => s.step).join(',')}`)
    } else {
      const seat = w.meta.seats[job.seats[Math.floor(rnd() * job.seats.length)]]
      const amount = String(300 + Math.floor(rnd() * 1200))
      // One in five sends reuses the previous key, as a client retry would.
      const key = rnd() < 0.2 && i > 0 ? `${owner}-${i - 1}` : `${owner}-${i}`
      const r = await w.send(seat, key, amount)
      log.push(r.op ? `op:${r.op.status}` : `denied:${String(r.denied).slice(0, 60)}`)
    }
  } catch (e: any) {
    log.push(e?.name === 'WalletOpError' ? `err:${e.code}` : `EXC:${String(e?.message ?? e).slice(0, 160)}`)
  }
}
writeFileSync(`${dir}/stress-${owner}.json`, JSON.stringify({ owner, log }))
w.lifecycle.stop()
process.exit(0)
