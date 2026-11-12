// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
import type { World } from './world.js'
import type { Check } from './invariants.js'

/** Exit code a phase uses to stand for the gateway process dying mid-step. */
export const CRASH_EXIT = 86

export interface Phase {
  name: string
  /** Runner owner for this process. A new process after a crash uses a new owner. */
  owner: string
  /** When set, the phase must end with this exit code. Invariants are checked by the next phase. */
  expectExit?: number
  run(w: World): Promise<Check[] | void>
}

export interface Scenario {
  name: string
  summary: string
  phases: Phase[]
}

export const expect = (id: string, ok: boolean, detail: string): Check => ({ id, ok, detail })
