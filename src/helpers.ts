// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
import type { World, Seat } from './world.js'

export const used = (w: World, id: string): string =>
  (w.db.prepare(`SELECT spend_used_minor AS u FROM delegations WHERE id = ?`).get(id) as any).u
export const walletStatus = (w: World, id: string): string =>
  (w.db.prepare(`SELECT status FROM agent_wallets WHERE id = ?`).get(id) as any).status
export const reservations = (w: World, opId: string): string[] =>
  (w.db.prepare(`SELECT status FROM wallet_op_reservations WHERE op_id = ? ORDER BY delegation_id`).all(opId) as any[]).map(r => r.status)
export const attempts = (w: World, opId: string): any[] =>
  w.db.prepare(`SELECT attempt_no, block_hash, outcome FROM wallet_op_attempts WHERE op_id = ? ORDER BY attempt_no`).all(opId) as any[]
export const frontierRecord = (w: World, seat: Seat): string | undefined =>
  (w.db.prepare(`SELECT frontier FROM wallet_frontiers WHERE nano_account = ?`).get(seat.address) as any)?.frontier
export const chainHeld = (w: World, delegationId: string): boolean =>
  !!w.db.prepare(`SELECT 1 FROM chain_spend_holds WHERE delegation_id = ?`).get(delegationId)
export const state = (w: World): string => w.lifecycle.status().state

/** world.send, with a refusal the route would answer as 409 or 400 returned as { error } instead of thrown. */
export async function trySend(w: World, seat: Seat, key: string, amountRaw: string) {
  try { return await w.send(seat, key, amountRaw) } catch (e: any) {
    if (e?.name === 'WalletOpError' || typeof e?.code === 'string') return { error: String(e.code) }
    throw e
  }
}
export const opCount = (w: World): number => (w.db.prepare(`SELECT COUNT(*) AS c FROM wallet_ops`).get() as any).c
