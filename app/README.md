# Strict Mode — corporate hotel booking

Hotel booking that starts from the meeting address, ranks by commute time, shows
one all-in number that never moves, enforces policy before the click, and bills
the company directly.

- Product spec: `../SPEC.md` · Slicing: `../plan.md` · Design language: `DESIGN.md`
- Frozen contracts: `API_CONTRACT.md` (HTTP) · `MODULE_EXPORTS.md` (modules)
- Production: https://strict-mode-hotel.vercel.app — **a demo build on invented hotels and a sandbox card issuer**

## What is built

**Slice 1 — Strict Mode.** Search by meeting address, commute-ranked results, all-in
pricing to the cent, policy enforced server-side, idempotent booking, central billing
by single-use virtual card, cancel inside the free window, SSO stand-in, admin CSV.

**Slice 2 — The Real World.**

| Area | What it does |
|---|---|
| Over-cap approvals | `in` / `over` / `blocked`. Over cap needs a justification, then a **hard approval**. No card is issued while pending. |
| Honest holds | Rates are held where the source can; otherwise the traveller is told plainly the price may move. |
| SLA escalation | Deterministic from history, so a late read equals an on-time one. Climbs the manager chain; never expires; flagged at the top. |
| Rate lost after approval | A designed outcome (`rate_lost`, `sold_out`, `card_declined`), not an error. |
| One-tap approvals | Signed, 72-hour, single-use links, with a GET preview and a POST decision. |
| Multi-currency | Supplier, display and settlement currencies stored per booking with the FX that produced them. Caps per currency; unauthored markets use a **monthly-pinned** rate so verdicts replay. |
| India GST | GST 2.0 slabs (0% / 5% no ITC / 18%, from 22 Sep 2025). Invoices issued after checkout, ≤16-character numbers, and an ITC verdict with its reason. Elsewhere: itemised tax summary. |
| Policy evaluator v2 | Versioned. Slice 1 verdicts still replay byte-identically through the frozen v1 evaluator. |
| Chat entry | A sentence becomes a search, or exactly one clarifying question. **Never books.** Rules parser, or Claude (`claude-opus-5`) with rules fallback. |
| Modify | Books the new stay first, then cancels the old one. Delta shown up front. |
| Duty of care | Travellers in market on any night, grouped by country, with advisories. |
| Data rights | Export; erasure that pseudonymises the person and keeps the tax record. |
| Admin | Policy · Exceptions · In market · Directory (CSV) · FX pins · Data rights · Metrics. |
| Persistence | One `Store` over a `DocPersistence` port: memory, file, or **Vercel Blob** with atomic create and ETag compare-and-swap, so idempotency and invoice numbering hold across serverless instances. |
| Live adapters | `ExpediaRapidRateSource`, `StripeIssuingCardIssuer`, `ClaudeIntentParser`, `SlackWebhookNotifier` — all behind the same ports. |

## Run it

```bash
npm install
SM_DEMO=1 npm run dev        # API :8787, web :5173 — sign in as Asha, Meera or the admin
npm test                     # everything
npx vitest run tests/acceptance   # the spec's criteria, one file per criterion
```

`SM_DEMO=1` seeds a traveller (Asha) → manager (Meera) → VP (Vikram), an admin, one
settled stay with its GST invoice, and one pending over-cap request.

## Configuration

| Variable | Values | Default |
|---|---|---|
| `SM_STORE` | `memory` · `file` · `blob` | `blob` on Vercel with `BLOB_READ_WRITE_TOKEN`, else `file` |
| `SM_SUPPLY` | `fixture` · `rapid` (needs `EAN_API_KEY`, `EAN_SHARED_SECRET`) | `fixture` |
| `SM_ISSUER` | `sandbox` · `stripe` (needs `STRIPE_SECRET_KEY`, `STRIPE_CARDHOLDER_ID`) | `sandbox` |
| `ANTHROPIC_API_KEY` | set → Claude chat parser with rules fallback | rules only |
| `SLACK_WEBHOOK_URL` | set → approval notifications to Slack | in-app + console email |
| `SM_SECRET` | required in production; boot refuses without it | dev secret locally |
| `CRON_SECRET` | bearer for `/api/cron/tick` | — |
| `SM_DEMO` · `SM_PUBLIC_BASE_URL` | demo cast · base for one-tap links | off · localhost |

Asking for `rapid` or `stripe` without credentials **refuses to boot**. It never
silently falls back to fixtures or the sandbox.

## Verification (Slice 2 build)

**587 tests: 586 pass, 1 skipped** (the live-Blob contract run, gated behind
`SM_TEST_BLOB=1`, which passed 30/30 against the real Mumbai store). Typecheck clean.
Under full-suite load on a laptop, A8 and one cancellation test can hit their timeouts;
both pass alone (A8 50/50).

**Production smoke (14 Sep 2026, https://strict-mode-hotel.vercel.app):** sign-in,
search (7 in policy, 3 over cap), in-policy booking confirmed with price parity, over-cap
request pending with no card issued, the approver's queue, approve → booking confirmed
with a card, and the demo GST tax invoice (5% slab, no ITC) all pass.

| Criterion | Result |
|---|---|
| A3 price parity | 100 consecutive bookings, to the cent |
| A5 approvals | hard approval, honest hold, escalation exactly once, never expires, rate lost after approval, one-tap single use, withdraw |
| A6 | over cap → 422 without justification; blocked → 403 even with one |
| A8 chat | **50/50** corpus utterances resolved or asked exactly one question; never books |
| A9 / A10 / A11 | card in supplier currency only at confirmation; GST invoice after checkout with valid GSTINs; three currencies re-derivable months later |
| A12 | v2 verdicts, a pinned-FX verdict after the pins change, and Slice 1 v1 verdicts all replay byte-identically |
| A13 | no card-like number in source, logs or supplier requests |
| A14 | exactly one booking across concurrent submits and serverless instances |
| A20 | export, erasure with typed confirmation, tax record retained |
| A24 | search p95 **1.86 s** across 50 concurrent; confirm p95 **7 ms**; a dead source degrades, never errors |
| S1 | supply swapped to the Expedia Rapid adapter: search, ranking, parity, billing, audit and cancellation unchanged; nothing above the port imports it |

## What is not verified, stated plainly

- **Gates S2 and S3 cannot be claimed.** Parity and hold honesty on *live* inventory,
  and virtual-card acceptance at real properties, need Expedia Partner Solutions and a
  card-issuing program. S1 is proven against an in-process mock of the Rapid shapes.
- **The Rapid and Stripe adapters carry `// UNVERIFIED:` marks** wherever public docs
  could not confirm a field: the Rapid booking body, payment enum, price-check shape
  and cancel link; the Stripe lodging category slug and card cancellation. Confirm them
  in each sandbox before live traffic.
- **Rapid content ingestion is not built.** With `SM_SUPPLY=rapid` the fixture catalogue
  stands in for property content, so a real Rapid account returns no properties until a
  Content API pipeline replaces `propertyIdsForAnchor` / `propertyFor`.
- **Vercel Blob instead of Postgres.** Blob is Vercel's own store, so it needed no
  third-party terms and gives atomic create plus CAS. Postgres can replace it behind the
  same `DocPersistence` port. It is slow: in production a booking takes about 8 s, an
  over-cap request about 17 s and an approval about 12 s, all Blob round trips.
  Postgres is the fix before real traffic. Blob also reports a weak ETag (`W/"…"`)
  for documents over about 1 KB, which its own `ifMatch` rejects; the adapter
  normalises it, and the contract suite covers a large-document update.
- **Escalations.** Vercel Hobby cron fires daily. Every approval read materialises
  escalations, so queues are always correct, but on Vercel the in-request tick is off
  (it stretched cold starts past the function limit), so escalation notifications go
  out with the daily cron. A paid plan's minute cron, or `SM_OPPORTUNISTIC_TICK=on`, restores prompt
  notices.
