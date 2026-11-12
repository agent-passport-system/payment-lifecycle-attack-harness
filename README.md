# Payment lifecycle attack harness

This repository lets you test how the [Agent Passport gateway](https://github.com/agent-passport-system/agent-passport-gateway) handles Nano payments when something goes wrong.

It runs the gateway's actual payment code against a fake Nano node. You can make the node lie, lose a block, return outdated information or stop responding. You can also crash the gateway between steps and restart it with its previous records intact.

No real wallet, API key or Nano network connection is needed. The harness does not send real payments.

The goal is to find cases the existing tests missed. Passing these tests does not prove that the gateway is secure or conformant to a standard. The implementation has not had an independent security review.

## How a payment works

A person allows an AI agent to spend money under a delegated budget. That permission can pass through several delegations, each with its own spending limit.

When the agent requests a payment, the gateway:

1. Checks the permissions and reserves the payment amount against every budget in the delegation chain.
2. Builds and signs one Nano block for that payment.
3. Records the attempt before sending the block to the Nano node.
4. Checks whether the node reports that same block as confirmed. If it does, the gateway counts the reserved amount as spent.

If the network response is missing, the gateway can send the same stored block again. It never builds a different block for that payment.

A payment that may already have been published does not automatically get its reserved budget back, even if the node stops responding. The amount stays held until the block confirms or an operator resolves a recorded conflict. A payment cancelled before any publication attempt may release its reservation.

The public gateway currently has payment publishing disabled in source. The harness starts the lifecycle separately against its fake node.

## Run the tests

Tested on macOS with Node.js 24.11. CI runs the same commands on Linux with Node.js 20 and 24. Windows has not been tested. You need Git, and Python 3 for the mutation tests.

```
npm install --include=dev
npm run vendor
npm run attack
python3 scripts/mutate.py
```

The first two commands need internet access. `npm run vendor` downloads the public gateway source at the exact commit recorded in `PIN` and installs its dependencies. It also accepts a path to a local clone of the gateway as its argument.

`npm run attack` runs every scenario. Each phase starts in a new process, so crash tests can reopen the same database and fake-node records.

`python3 scripts/mutate.py` deliberately breaks parts of the gateway one at a time and checks whether the scenarios detect those changes.

Each run writes its results to `out/<name>/`. The files record what the scenario expected, what happened, the gateway's lifecycle state and the calls received by the fake node.

## What the harness checks

The harness checks three rules after every phase.

**Budget accounting.** Reservations, confirmed spending and operator adjustments must respect the delegation limits. Payment records and spending counters must agree unless the gateway has entered an explicitly blocked state for the discrepancy.

**Reservation release.** Once a payment may have been published, its held budget cannot be returned automatically. Only an operator resolution can return it. Payments cancelled before any publication attempt are treated separately.

**Block identity.** Each payment can have at most one distinct signed block. The gateway must never send two different blocks built on the same previous block of an account. Sending the same block again is allowed.

## Scenarios

| Scenario | What it tests |
|---|---|
| `00-honest-send` | An ordinary payment confirms, counts once and advances the recorded account state |
| `01-false-confirmation` | A node claims a block confirmed when it did not. The gateway counts it as spent, and the next payment from that wallet waits |
| `02a-fabricated-sibling` | A node invents a competing block with an invalid signature. The gateway records a node fault without freezing the wallet |
| `02b-signed-sibling` | A genuinely signed competing block causes the wallet to freeze, the delegation chain to be held and further sends to stop |
| `03-stale-frontier` | A node reports an old account state or inflated balance. The gateway refuses to build a payment on it |
| `04-crash-after-publish` | A process crashes after the node accepts a block. Recovery uses the same stored block and counts the payment once |
| `05-concurrent-sends` | Two simultaneous payments cannot use the same wallet state or exceed a shared delegation budget |
| `06-duplicate-idempotency-keys` | Repeated requests return the original payment. Changed requests are refused, and completed payments are not sent again |
| `07-revocation-around-publish` | Revocation before publication cancels the payment. After an attempt is committed, the reservation stays held |
| `08-node-outage-during-publish` | The node fails before or after receiving a block. The gateway retains the reservation and retries only the stored block |
| `09-crash-before-publish` | A process crashes before signing or after recording an attempt. Recovery does not create another block |

At publication, the author's run completed all 11 scenarios and detected all nine deliberately introduced faults. These are author-run results, not independent validation.

## Known limitations

The gateway relies on one configured Nano node for confirmation. If that node falsely reports a payment as confirmed, the gateway can report success and count the budget as spent even though the recipient was not paid. Later payments from that wallet then stop because the recorded account state disagrees with the node.

A faulty node can also stop new payments across tenants. This protects against uncertain payment outcomes at the cost of availability.

Operator resolutions record outside evidence, but the gateway does not independently authenticate the sources the operator names.

The harness also does not test two gateway processes racing against the same database, the HTTP layer, real Nano consensus or proof-of-work validation. Scenarios `08` and `09` do not yet have their own planted mutations.

See `ADAPTATIONS.md` for the differences between this test environment and the deployed gateway.

## Add an attack

Create a file in `scenarios/` that exports a `Scenario`. Each scenario contains one or more phases, with access to the database, fake node, clock and payment lifecycle.

Use `w.ledger.override` to make the node return false information, stop responding or terminate the process. For a crash, the following phase opens the saved state in a fresh process.

A scenario that exposes a wrong result is useful even if the current gateway fails it.

If the failure could expose a vulnerability in the real gateway, report it privately using `SECURITY.md`. Do not publish the exploit as an issue or pull request. Other test improvements are welcome as public pull requests.

## License

Apache-2.0. The gateway source is downloaded separately and retains its own license.
