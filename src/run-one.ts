// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Run one phase of one scenario in this process: tsx src/run-one.ts <scenario-file> <phase-index> <out-dir>
// Writes <out-dir>/phase-<i>.json with the phase's expectation results, the invariants, the
// lifecycle status and every RPC the fake node saw during the phase.
import { writeFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { openWorld } from './world.js'
import { checkInvariants } from './invariants.js'
import type { Scenario } from './scenario.js'

const [file, idx, out] = process.argv.slice(2)
const scenario: Scenario = (await import(pathToFileURL(resolve(file)).href)).default
const i = Number(idx)
const phase = scenario.phases[i]
mkdirSync(out, { recursive: true })
const w = await openWorld(out, { owner: phase.owner })
const logStart = w.ledger.log.length
const write = (extra: object) => writeFileSync(`${out}/phase-${i}.json`, JSON.stringify({
  scenario: scenario.name, phase: phase.name, owner: phase.owner,
  pin: process.env.HARNESS_PIN, clock: w.clock.now(), ...extra,
  rpc: w.ledger.log.slice(logStart),
}, null, 1))
// A phase that crashes never reaches the end, so the exit handler writes its trace up to the crash.
let finished = false
process.on('exit', (code) => { if (!finished) write({ exit: code, crashed: true }) })
const expectations = (await phase.run(w)) ?? []
w.saveMeta()
const invariants = checkInvariants(w)
const status = w.lifecycle.status()
write({ exit: 0, status, expectations, invariants, ops: w.meta.ops.map(id => {
  const o = w.op(id)
  return { id, status: o.status, attempts: o.attempt_count, block_hash: o.block_hash, resolution: o.resolution ? JSON.parse(o.resolution) : null }
}) })
finished = true
const ok = [...expectations, ...invariants].every(c => c.ok)
w.lifecycle.stop()
process.exit(ok ? 0 : 1)
