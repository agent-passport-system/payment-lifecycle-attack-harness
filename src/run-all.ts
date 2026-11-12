// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Run every scenario in scenarios/, each phase in a fresh process, against the vendored gateway.
// Usage: npm run attack [-- <name-filter>]. Exit 0 only when every phase ends as its scenario expects.
import { readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { Scenario } from './scenario.js'

const root = resolve(new URL('..', import.meta.url).pathname)
const pin = readFileSync(`${root}/PIN`, 'utf8').trim()
const vendored = readFileSync(`${root}/vendor/gateway/VENDORED_FROM`, 'utf8').trim()
if (vendored !== pin) { console.error(`vendor/gateway is ${vendored}, PIN is ${pin}: run npm run vendor`); process.exit(2) }
const filter = process.argv[2] ?? ''
const files = readdirSync(`${root}/scenarios`).filter(f => f.endsWith('.ts') && f.includes(filter)).sort()
const tsx = `${root}/node_modules/.bin/tsx`
const summary: any[] = []
let failed = 0
for (const f of files) {
  const s: Scenario = (await import(pathToFileURL(`${root}/scenarios/${f}`).href)).default
  const out = `${root}/out/${s.name}`
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
  const phases: any[] = []
  let ok = true
  for (let i = 0; i < s.phases.length && ok; i++) {
    const p = s.phases[i]
    const r = spawnSync(tsx, [`${root}/src/run-one.ts`, `${root}/scenarios/${f}`, String(i), out], {
      env: { ...process.env, HARNESS_PIN: pin }, encoding: 'utf8',
    })
    writeFileSync(`${out}/phase-${i}.log`, (r.stdout ?? '') + (r.stderr ?? ''))
    const want = p.expectExit ?? 0
    const phaseOk = r.status === want
    let checks: any[] = []
    try {
      const j = JSON.parse(readFileSync(`${out}/phase-${i}.json`, 'utf8'))
      checks = [...(j.expectations ?? []), ...(j.invariants ?? [])]
    } catch { checks = [{ id: 'phase-output', ok: false, detail: 'no phase json written' }] }
    phases.push({ phase: p.name, exit: r.status, expected_exit: want, ok: phaseOk, failed_checks: checks.filter(c => !c.ok) })
    ok = phaseOk
  }
  if (!ok) failed++
  summary.push({ scenario: s.name, ok, phases })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${s.name}`)
  for (const p of phases) {
    console.log(`  ${p.ok ? 'ok ' : 'BAD'} ${p.phase} exit=${p.exit} (want ${p.expected_exit})`)
    for (const c of p.failed_checks) console.log(`      x ${c.id}: ${c.detail}`)
  }
}
writeFileSync(`${root}/out/summary.json`, JSON.stringify({ pin, scenarios: summary }, null, 1))
console.log(`${files.length - failed}/${files.length} scenarios ended as expected (gateway ${pin.slice(0, 7)})`)
process.exit(failed ? 1 : 0)
