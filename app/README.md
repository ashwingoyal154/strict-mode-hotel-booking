# Strict Mode — Slice 1

Corporate hotel booking that starts from the meeting address, ranks by commute
time, shows one all-in number that never moves, and bills the company directly.

This is **Slice 1** of the three-slice plan in `../plan.md`. It is a complete
product, not a layer: a single-entity company with a tight hotel policy can use
it end to end. What makes it Slice 1 is that **anything over cap is simply not
bookable** — there are no approvals, because the approval subsystem is Slice 2.

- Product spec: `../SPEC.md`
- Slicing rationale: `../plan.md`
- Design language: `DESIGN.md`
- Frozen HTTP contract: `API_CONTRACT.md`
- Frozen module contract: `MODULE_EXPORTS.md`

## Run it

```bash
npm install
npm run dev          # API on :8787, web on :5173
open http://localhost:5173
```

Sign in with any email — the dev SSO stub creates the traveller just-in-time, the
way OIDC JIT provisioning will. **The first account created is the admin**, so
log in as yourself first if you want the `/admin` page.

Single-origin production run:

```bash
npm run build && npm start    # http://localhost:8787
```

## Verify it

```bash
npm test                              # everything
npx vitest run tests/acceptance       # the slice-1 exit criteria
npx vitest run tests/unit             # pure domain logic
npx vitest run tests/api              # HTTP contract
```

`tests/acceptance/` maps one file per spec criterion, named for it: `A3` is the
price-parity proof, `A6` proves policy is enforced at the API and not just hidden
in the UI, `A13` scans the tree and the logs for card-like numbers, `A25` is the
build-failing guard on what a results card may render.

## What's real, and what is deliberately stubbed

| Concern | Slice 1 | Swaps to |
|---|---|---|
| Hotel supply | `FixtureRateSource` × 4, adversarial | A live adapter behind `RateSource` (gate S1) |
| Commute times | `LocalRouteSource`, deterministic | A maps provider behind `RouteSource` |
| Payments | `SandboxCardIssuer`, token + last4 only | A tokenising processor behind `CardIssuer` |
| Persistence | `FileStore` (JSON + append-only JSONL) | PostgreSQL behind `Store` |
| Identity | Dev SSO stub, JIT | OIDC, then SCIM in Slice 3 |

Every one of those is a single named interface, and nothing above it knows which
implementation it is talking to. That is not tidiness — it is what makes the
Slice 2 supply swap a configuration change rather than a rewrite.

The fixtures are **adversarial on purpose**: a source that times out, rates that
drift between search and confirm, inventory that sells out at confirm, cards that
decline. Happy-path fixtures would make the acceptance suite worthless.

## Not in Slice 1, and what a traveller does instead

| Absent | Workaround |
|---|---|
| Approvals | Over cap is not bookable; the traveller uses their old tool and we count it |
| Multi-currency | Domestic trips only |
| Chat entry | The form is the only way in |
| Modify a booking | Cancel and rebook |
| 24/7 servicing | Business-hours email support, stated in the product |
| GST invoice | No real money moves yet, so no tax document is owed |

The first row is the most valuable thing in this slice. **The strict-mode failure
rate — how often a traveller finds no in-policy option near their meeting and
leaves — is what sizes Slice 2.**

## Architecture

```
src/core/      pure domain. no I/O, no clock, no randomness in decisions.
               policy.ts is a versioned pure function: same inputs → byte-identical
               verdict forever, which is what makes an audit years later possible.
src/supply/    RateSource port + fixture implementation
src/routing/   RouteSource port + local implementation
src/payments/  CardIssuer port + sandbox implementation
src/store/     Store port + file-backed implementation
src/server/    express app, SSE search fan-out, append-only source log
src/web/       React SPA implementing the "Verdict" design language
```

Three invariants that are cheap now and very expensive to retrofit:

1. **The `RateSource` boundary.** No policy, booking, billing or UI code may know
   which source it is talking to.
2. **Idempotency on every supplier write.** Bookings are money; a duplicate is a
   real charge on a real company.
3. **Policy evaluation is pure.** No clock, no randomness, reason strings frozen.

## The design language

`DESIGN.md` defines "Verdict". Its one idea: the machine has already decided —
commute ranking, the all-in total, the policy verdict, the payment rail — so the
interface's entire job is **legible reasoning**. The machine speaks in monospace
and the product speaks in serif, so you can always tell what was computed from
what was written. Colour is spent only on verdicts. Streaming is a composed state
rather than a spinner. Nothing is a form field if the system already knows it.
