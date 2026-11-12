// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Start several gateway processes on this world's database and release them at one instant.
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { World } from './world.js'

const root = resolve(new URL('..', import.meta.url).pathname)
/** Time allowed for every racer to start, open the database and reach its wait loop. */
export const START_DELAY_MS = 4_000

export interface RacerReport { owner: string; ready_before_start_ms: number; fired_late_ms: number; done_ms: number; result: any }

export async function race(w: World, nodeUrl: string, tag: string, jobs: object[]): Promise<RacerReport[]> {
  w.saveMeta()
  const startAt = Date.now() + START_DELAY_MS
  const owners = jobs.map((_, i) => `${tag}-p${i + 1}`)
  await Promise.all(jobs.map((job, i) => new Promise<void>((done, fail) => {
    const child = spawn(`${root}/node_modules/.bin/tsx`, [`${root}/src/racer.ts`, w.dir, owners[i], nodeUrl, String(startAt), JSON.stringify(job)],
      { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('error', fail)
    child.on('exit', () => done())
  })))
  return owners.map((o) => {
    const p = `${w.dir}/racer-${o}.json`
    if (!existsSync(p)) return { owner: o, ready_before_start_ms: NaN, fired_late_ms: NaN, done_ms: NaN, result: { exception: 'no_report', message: 'the racer wrote no report' } }
    return JSON.parse(readFileSync(p, 'utf8'))
  })
}
