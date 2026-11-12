// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// The three invariants from the plan, checked against the database and the fake node's record of
// what the gateway submitted. They read state only, so they run after any step of any scenario.
import type { World } from './world.js'

export interface Check { id: string; ok: boolean; detail: string }

const big = (s: unknown) => BigInt(String(s ?? '0'))
const parse = (s: string | null) => (s ? JSON.parse(s) : {})

/**
 * I1. Every reservation, confirmed debit and operator adjustment respects the delegation budgets,
 * or the system is explicitly blocked. Checked two ways: no counter exceeds its limit, and each
 * counter equals what the operation records account for (held + consumed reservations + operator
 * debited adjustments). A mismatch is allowed only while the lifecycle state is "blocked".
 */
function budgets(w: World): Check {
  const dels = w.db.prepare(`SELECT id, spend_limit_minor, spend_used_minor FROM delegations WHERE spend_unit = 'nano:XNO:raw'`).all() as any[]
  const reserved = new Map<string, bigint>()
  for (const r of w.db.prepare(`SELECT delegation_id, amount_raw FROM wallet_op_reservations WHERE status IN ('held', 'consumed')`).all() as any[]) {
    reserved.set(r.delegation_id, (reserved.get(r.delegation_id) ?? 0n) + big(r.amount_raw))
  }
  // A debited adjustment is charged to the named delegation and its ancestors (applyUnitSpend on its chain).
  const parentOf = new Map<string, string | null>((w.db.prepare(`SELECT id, parent_delegation_id FROM delegations`).all() as any[]).map(d => [d.id, d.parent_delegation_id]))
  for (const o of w.db.prepare(`SELECT resolution FROM wallet_ops WHERE resolution IS NOT NULL`).all() as any[]) {
    const d = parse(o.resolution).incident?.resolved?.disposition
    if (d?.kind !== 'debited') continue
    for (const a of d.adjustments) {
      for (let id: string | null | undefined = a.delegation_id; id; id = parentOf.get(id)) reserved.set(id, (reserved.get(id) ?? 0n) + big(a.amount_raw))
    }
  }
  const problems: string[] = []
  for (const d of dels) {
    const used = big(d.spend_used_minor), limit = big(d.spend_limit_minor), accounted = reserved.get(d.id) ?? 0n
    if (used > limit) problems.push(`${d.id} used ${used} > limit ${limit}`)
    if (used !== accounted) problems.push(`${d.id} used ${used} != accounted ${accounted}`)
  }
  const state = w.lifecycle.status().state
  if (problems.length === 0) return { id: 'I1-budget', ok: true, detail: `${dels.length} delegations within limit and fully accounted` }
  return { id: 'I1-budget', ok: state === 'blocked', detail: `${problems.join('; ')} (lifecycle ${state})` }
}

/**
 * I2. No admitted or published payment releases its reservation without an authorized operator
 * resolution. A payment cancelled before any publish attempt may release.
 */
function releases(w: World): Check {
  const rows = w.db.prepare(`SELECT o.id, o.status, o.attempt_count, o.resolution,
      (SELECT COUNT(*) FROM wallet_op_attempts a WHERE a.op_id = o.id) AS attempts
    FROM wallet_ops o WHERE o.kind = 'send' AND EXISTS (SELECT 1 FROM wallet_op_reservations r WHERE r.op_id = o.id AND r.status = 'released')`).all() as any[]
  const bad: string[] = []
  for (const r of rows) {
    const preAdmission = r.status === 'cancelled' && r.attempt_count === 0 && r.attempts === 0
    const operator = parse(r.resolution).incident?.resolved?.decision === 'ours_failed'
    if (!preAdmission && !operator) bad.push(`${r.id} (${r.status}, ${r.attempts} attempts)`)
  }
  const unauthorizedFinal = (w.db.prepare(`SELECT id, resolution FROM wallet_ops WHERE status = 'failed_final'`).all() as any[])
    .filter(r => parse(r.resolution).incident?.resolved?.decision !== 'ours_failed').map(r => r.id)
  for (const id of unauthorizedFinal) bad.push(`${id} failed_final without operator resolution`)
  return { id: 'I2-release', ok: bad.length === 0, detail: bad.length ? bad.join('; ') : `${rows.length} released, all authorized` }
}

/**
 * I3. Each operation has at most one distinct prepared and signed block, and the gateway never
 * submits two different blocks on the same previous for an account. Resubmitting one block is fine.
 */
function oneBlock(w: World): Check {
  const bad: string[] = []
  for (const r of w.db.prepare(`SELECT op_id, COUNT(DISTINCT block_hash) AS n FROM wallet_op_attempts GROUP BY op_id HAVING n > 1`).all() as any[]) {
    bad.push(`${r.op_id} attempted ${r.n} different blocks`)
  }
  for (const r of w.db.prepare(`SELECT o.id FROM wallet_ops o JOIN wallet_op_attempts a ON a.op_id = o.id WHERE a.block_hash <> o.block_hash`).all() as any[]) {
    bad.push(`${r.id} attempted a block other than its stored block`)
  }
  const byPrev = new Map<string, Set<string>>()
  for (const p of w.ledger.s.processed) {
    const k = `${p.account}:${p.previous}`
    byPrev.set(k, (byPrev.get(k) ?? new Set()).add(p.hash))
  }
  for (const [k, set] of byPrev) if (set.size > 1) bad.push(`gateway submitted ${set.size} different blocks on ${k}`)
  return { id: 'I3-one-block', ok: bad.length === 0, detail: bad.length ? bad.join('; ') : `${w.ledger.s.processed.length} submissions, one block per previous` }
}

export function checkInvariants(w: World): Check[] { return [budgets(w), releases(w), oneBlock(w)] }
