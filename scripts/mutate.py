#!/usr/bin/env python3
# Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
"""Plant one known fault at a time in vendor/gateway, run the attacks, restore.

A mutation is killed when the run fails and every scenario named for it is among the failures.
The vendored source is hashed before and after, so a run that leaves a fault behind is reported.
Usage: python3 scripts/mutate.py
"""
import hashlib, json, os, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'vendor' / 'gateway' / 'src'
PR = 'payment-rails/'

MUTATIONS = [
    ('M1 sibling signature not checked', PR + 'wallet-reconcile.ts',
     "  if (!blockSignatureValid(row.nano_account, contents)) return 'sibling_signature_invalid'\n", '\n',
     ['02a-fabricated-sibling']),
    ('M2 frontier record not checked before building', PR + 'nano-publish.ts',
     "      if (bad) throw new WalletOpError('block_mismatch', bad)\n", '\n',
     ['01-false-confirmation', '03-stale-frontier']),
    ('M3 reservation released automatically on incident', PR + 'wallet-reconcile.ts',
     "    db.prepare(`UPDATE agent_wallets SET status = 'frozen' WHERE id = ?`).run(again.wallet_id)\n    if (again.delegation_id) {\n      db.prepare(`INSERT OR IGNORE INTO chain_spend_holds (delegation_id, tenant_id, reason, created_at)\n        VALUES (?, ?, ?, datetime('now'))`).run(again.delegation_id, again.tenant_id, `conflict_incident:${again.id}`)",
     "    releaseReservations(db, again)\n    db.prepare(`UPDATE agent_wallets SET status = 'frozen' WHERE id = ?`).run(again.wallet_id)\n    if (again.delegation_id) {\n      db.prepare(`INSERT OR IGNORE INTO chain_spend_holds (delegation_id, tenant_id, reason, created_at)\n        VALUES (?, ?, ?, datetime('now'))`).run(again.delegation_id, again.tenant_id, `conflict_incident:${again.id}`)",
     ['02b-signed-sibling']),
    ('M4 confirmation debits the budget a second time', PR + 'wallet-reconcile.ts',
     "      consumeReservations(db, again)\n      recordConfirmedHistory(db, again)\n      // The confirmation and the frontier record move together",
     "      consumeReservations(db, again)\n      applyUnitSpend(db, JSON.parse(again.chain_rows!), BigInt(again.amount_raw))\n      recordConfirmedHistory(db, again)\n      // The confirmation and the frontier record move together",
     ['00-honest-send', '04-crash-after-publish']),
    ('M5 reporting node accepted as independent source', PR + 'wallet-reconcile.ts',
     "&& s.source !== incident.source ", '',
     ['02b-signed-sibling']),
    ('M6 new sends admitted while lifecycle is not ok', PR + 'nano-lifecycle-startup.ts',
     "readiness: () => status.state === 'ok' ? null : `lifecycle_${status.state}`", 'readiness: () => null',
     ['02a-fabricated-sibling', '02b-signed-sibling']),
    ('M7 a used idempotency key is not recognised when reserving', PR + 'wallet-ops.ts',
     "    if (replay) return { op: replay, replay: true }\n    refuseIfAccountBusy(db, r.nanoAccount)\n\n    // Pilot caps", "    refuseIfAccountBusy(db, r.nanoAccount)\n\n    // Pilot caps",
     ['06-duplicate-idempotency-keys']),
    ('M8 the delegation budget is not checked when reserving', PR + 'wallet-ops.ts',
     "    if (violation) return { refused: violation }\n\n    applyUnitSpend(db, rows, amount)", "\n    applyUnitSpend(db, rows, amount)",
     ['05-concurrent-sends']),
    ('M9 authority is not rechecked when a publish attempt is committed', PR + 'nano-publish.ts',
     "    const bad = attemptAuthorityViolation(db, row)\n", "    const bad: string | null = null\n",
     ['07-revocation-around-publish']),
    ('M10 the send reservation does not take the write lock first', PR + 'wallet-ops.ts',
     "    return { op: getOp(db, id)!, replay: false }\n  }).immediate()\n}\n\n/** Reserve a receive or open", "    return { op: getOp(db, id)!, replay: false }\n  })()\n}\n\n/** Reserve a receive or open",
     ['10-two-process-race']),
]

SLOW = '10-two-process-race'


def tree_hash() -> str:
    h = hashlib.sha256()
    for p in sorted(SRC.rglob('*')):
        if p.is_file():
            h.update(str(p.relative_to(SRC)).encode()); h.update(p.read_bytes())
    return h.hexdigest()


def run_attack(skip_slow: bool = False) -> tuple[int, list[str]]:
    env = dict(os.environ, HARNESS_SKIP=SLOW) if skip_slow else dict(os.environ)
    r = subprocess.run(['npm', 'run', '-s', 'attack'], cwd=ROOT, capture_output=True, text=True, env=env)
    failed = [l.split()[1] for l in r.stdout.splitlines() if l.startswith('FAIL ')]
    checks = sorted({l.strip()[2:].split(':')[0] for l in r.stdout.splitlines() if l.strip().startswith('x ')})
    run_attack.checks = checks
    return r.returncode, failed


before = tree_hash()
results, all_killed = [], True
for name, rel, old, new, want in MUTATIONS:
    f = SRC / rel
    text = f.read_text()
    n = text.count(old)
    if n != 1:
        results.append({'mutation': name, 'error': f'pattern found {n} times'}); all_killed = False
        print(f'NOT PLANTED {name}: pattern found {n} times'); continue
    f.write_text(text.replace(old, new, 1))
    try:
        code, failed = run_attack(skip_slow=SLOW not in want)
    finally:
        f.write_text(text)
    killed = code != 0 and all(w in failed for w in want)
    all_killed &= killed
    results.append({'mutation': name, 'exit': code, 'failed': failed, 'failed_checks': run_attack.checks, 'expected': want, 'killed': killed})
    print(f"{'KILLED ' if killed else 'SURVIVED'} {name}: exit={code} failed={failed}\n         checks={run_attack.checks}")

after = tree_hash()
clean_code, clean_failed = run_attack()
print(f'vendor tree unchanged: {before == after} ({after[:12]})')
print(f'clean rerun: exit={clean_code} failed={clean_failed}')
(ROOT / 'out' / 'mutations.json').write_text(json.dumps({'tree_before': before, 'tree_after': after, 'results': results,
                                                        'clean_rerun': {'exit': clean_code, 'failed': clean_failed}}, indent=1))
sys.exit(0 if all_killed and before == after and clean_code == 0 else 1)
