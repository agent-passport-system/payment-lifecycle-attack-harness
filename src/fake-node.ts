// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// A scriptable fake Nano node. Honest by default: process() stores a block unconfirmed, confirm()
// confirms it, account_info reports the confirmed head. A scenario lies by installing `override`,
// which sees every RPC body and may answer instead of the honest ledger, call it, or crash.
// State persists to a JSON file when `statePath` is set, so a fresh process can reopen it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { NanoNode } from '../vendor/gateway/src/payment-rails/nano-publish.js'
import { stateBlockHash, canonicalBlockJson } from '../vendor/gateway/src/payment-rails/nano-block.js'
import { nano } from './deps.js'

export const GENESIS = 'F47B23107E5F34B2CE06F562B5C435DF72A533251CB414C51B2B62A8F63A00E4'
export const FAKE_WORK = '0123456789abcdef'

interface Stored { block: any; account: string; confirmed: boolean; via: 'process' | 'injected' }
interface LedgerState {
  blocks: Record<string, Stored>
  succ: Record<string, string[]>
  heads: Record<string, { frontier: string; balance: string }>
  /** Every block the gateway submitted through process(), in order, including resubmissions. */
  processed: Array<{ hash: string; account: string; previous: string }>
}
export interface RpcLog { seq: number; action: string; req: any; res?: any; err?: string; by: 'honest' | 'override' }
export type Override = (body: any, honest: () => Promise<any>, ledger: FakeLedger) => Promise<any> | undefined

export class FakeLedger {
  s: LedgerState = { blocks: {}, succ: {}, heads: {}, processed: [] }
  log: RpcLog[] = []
  override: Override | null = null
  constructor(readonly statePath: string | null = null) {
    if (statePath && existsSync(statePath)) this.s = JSON.parse(readFileSync(statePath, 'utf8'))
  }
  save(): void { if (this.statePath) writeFileSync(this.statePath, JSON.stringify(this.s, null, 1)) }

  open(account: string, balance: string, frontier = GENESIS): void {
    this.s.heads[account] = { frontier, balance }; this.save()
  }
  confirm(hash: string): void {
    const b = this.s.blocks[hash]
    if (!b) throw new Error(`confirm: unknown block ${hash}`)
    b.confirmed = true
    this.s.heads[b.account] = { frontier: hash, balance: String(b.block.balance) }
    this.save()
  }
  /** A genuinely signed block of `acct` on `previous`, as if its key were used outside the gateway. */
  signedSibling(acct: { address: string; privateKey: string }, previous: string, balanceBefore: string, amountRaw: string, confirmed: boolean): string {
    const blk = nano.block.send({ walletBalanceRaw: balanceBefore, fromAddress: acct.address, toAddress: acct.address,
      representativeAddress: acct.address, frontier: previous, amountRaw, work: FAKE_WORK }, acct.privateKey)
    return this.inject(JSON.parse(canonicalBlockJson(blk)), acct.address, confirmed)
  }
  /** The same shape of block with its signature altered: the hash is unchanged, the signature is not valid. */
  fabricatedSibling(acct: { address: string; privateKey: string }, previous: string, balanceBefore: string, amountRaw: string): string {
    const blk = JSON.parse(canonicalBlockJson(nano.block.send({ walletBalanceRaw: balanceBefore, fromAddress: acct.address,
      toAddress: acct.address, representativeAddress: acct.address, frontier: previous, amountRaw, work: FAKE_WORK }, acct.privateKey)))
    const sig: string = blk.signature
    blk.signature = (sig[0] === '0' ? '1' : '0') + sig.slice(1)
    return this.inject(blk, acct.address, true)
  }
  private inject(block: any, account: string, confirmed: boolean): string {
    const h = stateBlockHash(block)
    this.s.blocks[h] = { block, account, confirmed, via: 'injected' }
    const list = this.s.succ[block.previous] ?? []
    if (!list.includes(h)) this.s.succ[block.previous] = [...list, h]
    this.save()
    return h
  }
  /** Gateway-submitted blocks that the honest ledger never stored are not in s.blocks. */
  submittedBy(account: string): Array<{ hash: string; previous: string }> {
    return this.s.processed.filter(p => p.account === account)
  }

  async honest(body: any): Promise<any> {
    switch (body.action) {
      case 'account_info': {
        const h = this.s.heads[body.account]
        if (!h) throw new Error('Nano RPC: Account not found')
        return { frontier: h.frontier, confirmed_frontier: h.frontier, confirmed_balance: h.balance, confirmed_representative: body.account }
      }
      case 'work_generate': return { work: FAKE_WORK }
      case 'process': {
        const h = stateBlockHash(body.block)
        if (!this.s.blocks[h]) {
          this.s.blocks[h] = { block: body.block, account: body.block.account, confirmed: false, via: 'process' }
          const list = this.s.succ[body.block.previous] ?? []
          if (!list.includes(h)) this.s.succ[body.block.previous] = [...list, h]
        }
        this.save()
        return { hash: h }
      }
      case 'block_info': {
        const b = this.s.blocks[String(body.hash).toUpperCase()]
        if (!b) throw new Error('Nano RPC: Block not found')
        return { block_account: b.account, confirmed: b.confirmed ? 'true' : 'false', contents: b.block }
      }
      case 'successors': return { blocks: [body.block, ...(this.s.succ[body.block] ?? []).slice(0, 1)] }
      default: throw new Error(`fake node: unexpected action ${body.action}`)
    }
  }

  node: NanoNode = {
    call: async (body: any) => {
      const seq = this.log.length + 1
      const entry: RpcLog = { seq, action: String(body.action), req: body, by: 'honest' }
      this.log.push(entry)
      // Record what the gateway submitted before anyone answers, so a lying override cannot hide it from I3.
      if (body.action === 'process' && body.block) {
        let hash = 'UNHASHABLE'
        try { hash = stateBlockHash(body.block) } catch {}
        this.s.processed.push({ hash, account: String(body.block.account), previous: String(body.block.previous).toUpperCase() })
        this.save()
      }
      try {
        let res: any
        const o = this.override?.(body, () => this.honest(body), this)
        if (o !== undefined) { entry.by = 'override'; res = await o } else res = await this.honest(body)
        entry.res = res
        return res
      } catch (e: any) {
        entry.err = String(e?.message ?? e)
        throw e
      }
    },
  }
}
