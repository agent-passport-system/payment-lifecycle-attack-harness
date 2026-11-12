// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// One gateway world per process: the real schema, the real wallet service and the real lifecycle
// runner, wired to the fake node, an injected clock and deterministic test keys. Every place this
// differs from production is listed in ADAPTATIONS.md.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { initDB } from '../vendor/gateway/src/db/schema.js'
import { getWalletService } from '../vendor/gateway/src/payment-rails/wallet.js'
import { getOpRunner, type RunContext, type RunResult } from '../vendor/gateway/src/payment-rails/wallet-reconcile.js'
import { startNanoLifecycle, type LifecycleHandle } from '../vendor/gateway/src/payment-rails/nano-lifecycle-startup.js'
import { initializeWalletFrontier } from '../vendor/gateway/src/payment-rails/wallet-frontier.js'
import { getOp, type WalletOp } from '../vendor/gateway/src/payment-rails/wallet-ops.js'
import { FakeLedger } from './fake-node.js'
import { rpcNode } from '../vendor/gateway/src/payment-rails/nano-publish.js'
import { nano } from './deps.js'

export const LEASE_MS = 30_000
export const REBROADCAST_MS = 10_000
/** Harness keys only. They hold nothing on any real network. */
export const keyFor = (walletIndex: number) => nano.wallet.fromLegacySeed((0x3000 + walletIndex).toString(16).padStart(64, '0')).accounts[0]
export const DEST = nano.wallet.fromLegacySeed('cc'.repeat(32)).accounts[0]
const GATEWAY_ACCOUNT = keyFor(0).address

export interface Seat { tenant: string; agent: string; top: string; low: string; wallet: string; index: number; address: string; frontier: string }
/** Each account starts on its own block, as on a real ledger, where no two accounts share a previous block. */
export const startFrontier = (address: string) => createHash('sha256').update(`harness-start:${address}`).digest('hex').toUpperCase()
export interface Meta { clock: number; seats: Seat[]; ops: string[] }

export interface World {
  db: any
  ledger: FakeLedger
  clock: { now(): number; advance(ms: number): void }
  lifecycle: LifecycleHandle
  meta: Meta
  dir: string
  tick(): Promise<RunResult[]>
  seat(opts?: { limitRaw?: string; balanceRaw?: string }): Seat
  /** A second paying agent in the same tenant, with its own wallet, under the same top delegation as `of`. */
  sibling(of: Seat, opts?: { limitRaw?: string; balanceRaw?: string }): Seat
  send(seat: Seat, key: string, amountRaw: string): Promise<{ op?: WalletOp; denied?: string; notReady?: string }>
  op(id: string): WalletOp
  saveMeta(): void
}

/** Pilot caps far above anything the scenarios send, and the send switch on, as an operator would set them. */
function operatorEnv(): void {
  process.env.NANO_WALLET_SEND_ENABLED = '1'
  delete process.env.NANO_WALLETS_PAUSED
  delete process.env.NANO_RAIL_DISABLED
  process.env.NANO_PILOT_MAX_PAYMENT_RAW = '1000000000000000000000000000000000'
  process.env.NANO_PILOT_MAX_WALLET_RAW = '1000000000000000000000000000000000'
  process.env.NANO_PILOT_MAX_PAYMENTS = '100000'
}

/**
 * `racer` opens a second gateway process on a database another process already set up. It talks to
 * the fake node over HTTP through the gateway's own RPC client, and it never writes meta.json or
 * the ledger file, which belong to the process that started it.
 */
export async function openWorld(dir: string, opts: { owner: string; clockStart?: number; racer?: { nodeUrl: string } }): Promise<World> {
  operatorEnv()
  const metaPath = `${dir}/meta.json`
  const meta: Meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : { clock: opts.clockStart ?? 1_000_000, seats: [], ops: [] }
  let now = meta.clock
  const clock = { now: () => now, advance: (ms: number) => { now += ms; meta.clock = now } }
  const db = initDB(`${dir}/gateway.db`)
  const ledger = new FakeLedger(opts.racer ? null : `${dir}/ledger.json`)
  const ctx: RunContext = {
    node: opts.racer ? rpcNode(opts.racer.nodeUrl) : ledger.node, owner: opts.owner, leaseMs: LEASE_MS, now: clock.now,
    // Production derives the key from the master seed by wallet index (seedSigner). Same checks here.
    signer: (op) => {
      const w = db.prepare(`SELECT wallet_index, nano_address FROM agent_wallets WHERE id = ?`).get(op.wallet_id) as any
      if (!w || w.nano_address !== op.nano_account) throw new Error('signer: wallet row does not match the operation account')
      const k = keyFor(w.wallet_index)
      if (k.address !== op.nano_account) throw new Error('signer: derived key does not match the operation account')
      return { address: k.address, privateKey: k.privateKey }
    },
    openRepresentative: DEST.address,
    reconcile: { source: 'fake-node' },
    rebroadcastMs: REBROADCAST_MS,
  }
  // tickMs is huge so no timer tick runs on its own: scenarios drive every pass with tick().
  const lifecycle = startNanoLifecycle(db, { ctx, tickMs: 2 ** 30, gatewayAddress: GATEWAY_ACCOUNT })
  await lifecycle.tickNow()

  const w: World = {
    db, ledger, clock, lifecycle, meta, dir,
    tick: () => lifecycle.tickNow(),
    saveMeta: () => { if (!opts.racer) writeFileSync(metaPath, JSON.stringify(meta, null, 1)) },
    op: (id) => getOp(db, id)!,
    seat({ limitRaw = '5000', balanceRaw = '100000' } = {}) {
      const t = meta.seats.length + 1
      const tenant = `tnt_${t}`, root = `root-${t}`, p = `p-${t}`, agent = `c-${t}`, index = 20_000 + t
      db.prepare(`INSERT INTO tenants (id, name, email) VALUES (?, ?, ?)`).run(tenant, `Tenant ${t}`, `${tenant}@harness.invalid`)
      for (const a of [root, p, agent]) {
        db.prepare(`INSERT INTO agents (id, tenant_id, agent_id, public_key, status, is_root) VALUES (?, ?, ?, 'pk', 'active', 0)`).run(`row-${a}`, tenant, a)
      }
      const ins = db.prepare(`INSERT INTO delegations (id, tenant_id, parent_agent_id, child_agent_id, scope, status, spend_limit, spend_used,
        parent_delegation_id, spend_unit, spend_limit_minor, spend_used_minor) VALUES (?, ?, ?, ?, 'commerce:send', 'active', 0, 0, ?, 'nano:XNO:raw', ?, '0')`)
      ins.run(`top-${t}`, tenant, root, p, null, limitRaw)
      ins.run(`low-${t}`, tenant, p, agent, `top-${t}`, limitRaw)
      const address = keyFor(index).address
      db.prepare(`INSERT INTO agent_wallets (id, tenant_id, agent_id, nano_address, wallet_index, status) VALUES (?, ?, ?, ?, ?, 'active')`)
        .run(`w-${t}`, tenant, agent, address, index)
      const frontier = startFrontier(address)
      ledger.open(address, balanceRaw, frontier)
      // The operator step that records the verified starting state before the first send.
      const r = initializeWalletFrontier(db, { walletId: `w-${t}`, frontier, balanceRaw, by: 'harness-operator', evidence: 'harness seed', now: clock.now(), replace: false })
      if (!r.ok) throw new Error(`initializeWalletFrontier: ${(r as any).reason}`)
      const seat = { tenant, agent, top: `top-${t}`, low: `low-${t}`, wallet: `w-${t}`, index, address, frontier }
      meta.seats.push(seat); w.saveMeta()
      return seat
    },
    sibling(of, { limitRaw = '5000', balanceRaw = '100000' } = {}) {
      const n = meta.seats.length + 1
      const agent = `c-${n}`, low = `low-${n}`, wallet = `w-${n}`, index = 20_000 + n
      db.prepare(`INSERT INTO agents (id, tenant_id, agent_id, public_key, status, is_root) VALUES (?, ?, ?, 'pk', 'active', 0)`).run(`row-${agent}`, of.tenant, agent)
      const parent = (db.prepare(`SELECT child_agent_id AS p FROM delegations WHERE id = ?`).get(of.top) as any).p
      db.prepare(`INSERT INTO delegations (id, tenant_id, parent_agent_id, child_agent_id, scope, status, spend_limit, spend_used,
        parent_delegation_id, spend_unit, spend_limit_minor, spend_used_minor) VALUES (?, ?, ?, ?, 'commerce:send', 'active', 0, 0, ?, 'nano:XNO:raw', ?, '0')`)
        .run(low, of.tenant, parent, agent, of.top, limitRaw)
      const address = keyFor(index).address
      db.prepare(`INSERT INTO agent_wallets (id, tenant_id, agent_id, nano_address, wallet_index, status) VALUES (?, ?, ?, ?, ?, 'active')`)
        .run(wallet, of.tenant, agent, address, index)
      const frontier = startFrontier(address)
      ledger.open(address, balanceRaw, frontier)
      const r = initializeWalletFrontier(db, { walletId: wallet, frontier, balanceRaw, by: 'harness-operator', evidence: 'harness seed', now: clock.now(), replace: false })
      if (!r.ok) throw new Error(`initializeWalletFrontier: ${(r as any).reason}`)
      const seat = { tenant: of.tenant, agent, top: of.top, low, wallet, index, address, frontier }
      meta.seats.push(seat); w.saveMeta()
      return seat
    },
    // The route's path without HTTP: reserveSendOp with the installed runner's claim and readiness,
    // then schedule, as POST /wallets/send does. Then wait for the scheduled run to finish.
    async send(seat, key, amountRaw) {
      const runner: any = getOpRunner()
      const r = await getWalletService().reserveSendOp({
        tenantId: seat.tenant, fromAgentId: seat.agent, toAddress: DEST.address, amountRaw, idempotencyKey: key,
        claim: { owner: runner.owner, now: runner.now(), leaseMs: runner.leaseMs }, notReady: runner.readiness(),
      })
      if ('denied' in r) return { denied: r.denied.denial_reason ?? 'denied', notReady: r.notReady }
      if (!r.replay) { meta.ops.push(r.op.id); w.saveMeta(); runner.schedule(r.op.id) }
      if (typeof runner.idle === 'function') await runner.idle()
      return { op: getOp(db, r.op.id)! }
    },
  }
  return w
}
