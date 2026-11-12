// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
// The harness uses the gateway's own installed copy of nanocurrency-web, so blocks the fake node
// signs and checks come from the same library version the gateway uses.
import { createRequire } from 'node:module'
const req = createRequire(new URL('../vendor/gateway/package.json', import.meta.url))
const mod = req('nanocurrency-web')
export const nano: any = mod.default || mod
