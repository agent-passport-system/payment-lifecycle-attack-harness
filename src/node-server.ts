// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// Serves one FakeLedger over HTTP in the shape of a Nano node's RPC, so several gateway processes
// can share one fake node. A thrown "Nano RPC: X" becomes {"error": "X"}, which the gateway's RPC
// client turns back into the same error.
import { createServer } from 'node:http'
import type { FakeLedger } from './fake-node.js'

export async function serveLedger(ledger: FakeLedger): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json')
      try {
        res.end(JSON.stringify(await ledger.node.call(JSON.parse(raw))))
      } catch (e: any) {
        res.end(JSON.stringify({ error: String(e?.message ?? e).replace(/^Nano RPC: /, '') }))
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as any).port
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}
