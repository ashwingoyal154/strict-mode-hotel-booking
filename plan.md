# Build Plan — three slices

Companion to `SPEC.md`. The spec says what to build; this says in what order, and what "done" means at each stop.

**Planning inputs (confirmed 12 Sep 2026):** 2–4 engineers · no fixed date · no design partner yet.

**Three rules this plan follows:**
1. **Every slice is a complete product.** Not a layer, not a milestone. Each one is a thing a real traveller can use end-to-end to book a real trip, with a named user and a go-live. A slice that needs the next slice to be useful is a wrong cut.
2. **Every slice ends in a measurement that can kill or reshape the next one.** MVP discipline means each slice buys information, not just code. The exit criteria include what you learn, not only what works.
3. **No dates appear in this plan.** You said no forcing event, so slices are scope-boxed: each ships when its exit criteria pass. Sizes are relative (S / M / L) against a 2–4 person team working sequentially.

---

## Why these three cuts

The spec contains four independent promises. Cutting along them gives layers, not products. Cutting along **how hard the trip is** gives products:

| Slice | The trip it handles | The user it serves |
|---|---|---|
| **1 — Strict Mode** | Simple: one country, one currency, an in-policy hotel exists near the meeting | A single-entity company running a tight hotel policy |
| **2 — The Real World** | Messy: over cap, abroad, plans changed | The same company, now using it for *all* hotel travel |
| **3 — Enterprise** | Same trips, but bought by procurement and serviced at 3am | A 5,000-person enterprise retiring its hotel TMC |

Slice 1 is the spine and the differentiator. Slice 2 is what makes it the only tool someone needs. Slice 3 is what makes it sellable to the customer you named. Each is shippable. None is a prerequisite *excuse* — slice 1 is genuinely usable on its own.

---

## Slice 1 — Strict Mode

> **Promise:** Book a hotel near your meeting, in policy, and never file an expense report.

**Who uses it:** one company, one legal entity, one currency, one set of nightly caps. Internally at first, then recruited testers. Runs on fixture inventory with sandbox payments — so it is a complete product that does not yet take real money.

**The whole point:** prove the differentiator (commute-time ranking + one unmoving all-in number + policy before the click) with the smallest possible machine around it.

### In scope
- **Supply:** fixture `RateSource` with **adversarial** fixtures — timeout, price drift, sold-out-on-confirm, card decline. Happy-path fixtures make slice 1 worthless as evidence.
- **Commute ranking:** real maps routing against fixture property coordinates. This part is never mocked; it is the product.
- **All-in pricing:** one number, taxes and fees included, identical at search and confirm.
- **Policy:** the pure versioned function, returning **`in` | `blocked`** only. Over cap is simply not bookable.
- **Booking:** persisted state machine, idempotency keys, immutable source request/response log.
- **Payment:** central billing via single-use virtual card, processor **sandbox**. Real tokenisation, real PCI posture, no real settlement.
- **Trip screen:** confirmation, address with maps handoff, check-in time, hotel phone, cancel inside the free window.
- **Identity:** OIDC SSO with just-in-time user creation. No SCIM.
- **Admin:** one page — cap table, blocked list, cost centres, CSV export.
- **Quality:** 390px, keyboard-only, WCAG 2.2 AA, the performance budget, the no-extra-card-fields test.

### Deliberately out — and what the traveller does instead
| Not in slice 1 | Workaround |
|---|---|
| Approvals | Nothing over cap books. The traveller uses their old tool and we count it. |
| Multi-currency | Domestic trips only; international travel stays on the old tool. |
| Chat entry | The form is the only way in. |
| Modify a booking | Cancel and rebook manually. |
| Servicing | Business-hours email support, stated plainly in the product. |
| GST invoice | No real money moves yet, so no tax document is owed. |

The "count it" in row one is the most valuable line in this slice.

### Exit criteria
Spec criteria **A1, A2, A3, A4, A6, A7, A13, A14, A24, A25**, plus **A9** reduced to sandbox (charge lands on the single entity, traveller pays nothing).

### What you must learn before slice 2
- **Strict-mode failure rate:** how often does a traveller find no in-policy option near their meeting and leave? This number sizes slice 2's approval work, and if it is near zero, slice 2 shrinks dramatically.
- **Does commute-time ranking actually change the choice?** If travellers sort by price anyway, the differentiator is wrong and the spec needs revisiting — not the plan.
- Median search-to-confirm against the 90-second target, on real phones.

**Size: L.** This slice carries the spine — supply adapter, policy engine, booking machine, payments, plus the whole traveller UI.

### Risks
- Commute routing cost and latency at scale; budget the maps spend and cache aggressively per anchor.
- Adversarial fixtures are tedious to write and the first thing a small team skips. They are the slice's test substrate — treat them as product code.

---

## Slice 2 — The Real World

> **Build status (14 Sep 2026): built and deployed as a demo on fixture supply.**
> 582 of 583 tests pass (1 gated). A5, A8 (50/50), A9–A12, A20 and gate **S1** pass.
> **S2 and S3 are not claimable** without Expedia Partner Solutions credentials and a
> card-issuing program. The Rapid and Stripe adapters exist behind their ports and
> carry `UNVERIFIED` marks for sandbox confirmation. See `app/README.md`.


> **Promise:** The trips that don't fit — over cap, abroad, plans changed — stay inside the platform. And the money is real.

**Who uses it:** the same company, now routing **all** hotel travel here. This is the first slice that takes real money against live inventory, which makes it the first slice with a genuine go-live.

### In scope
- **Exceptions:** the third policy state. Over-cap bookings take a reason plus free text, then **hard approval** — rate held where the source supports it, and an honest warning where it does not. Approver gets push, email and Slack with the overage and one-tap Approve / Reject. SLA timer visible to both sides; breach auto-escalates one level up the manager chain and never silently expires.
- **Multi-currency:** supplier, display and settlement currencies all stored per booking with FX rate and timestamp. Caps authored per currency; unauthored markets convert at a **monthly-pinned** corporate rate so verdicts stay reproducible.
- **Live supply:** swap the fixture `RateSource` for a live adapter — Expedia Rapid first, no IATA accreditation needed. This is spec gate **S1/S2**.
- **Live money:** real virtual card issuance, real settlement, hotel-facing authorisation letter on every booking, decline rate tracked from the first booking. Spec gate **S3**.
- **Tax:** India GST invoicing with the entity's GSTIN, because real money now moves. Tax as itemised lines everywhere else.
- **Modify:** cancel-and-rebook as one flow with the delta up front.
- **Duty of care:** travellers-in-market-tonight view; restricted countries blocked, advisory cities flagged at confirm.
- **Data rights:** per-traveller export and erasure, now that real personal data is flowing.
- **Chat entry:** natural language into Results. Cheap, demos well, and **never books**.
- **Admin:** exception list with justifications and approver decisions.

### Deliberately out — and the workaround
| Not in slice 2 | Workaround |
|---|---|
| SCIM | Admin bulk-uploads the employee list and manager chain; re-upload on change. |
| Policy hierarchy | One flat policy per company. Departments that need different caps get a separate tenant. |
| Multi-entity billing | One legal entity per tenant. |
| 24/7 servicing | Extended-hours desk with a published cut-off, and the old TMC retained for after-hours. Stated in the contract. |
| Audit log | Action logging exists for engineers; no customer-facing auditor export. |

### Exit criteria
**A5, A8, A10, A11, A12, A20**, plus **A9** promoted to real money, plus supply gates **S1, S2, S3**.

### What you must learn before slice 3
- **Approval SLA reality:** what share of over-cap requests resolve inside the SLA without losing the rate? Below roughly 80% and hard-approval-by-default is the wrong default, which changes the spec.
- **Virtual card decline rate** against real properties. S3 sets 95% acceptance; missing it means the zero-expense-report promise needs a second payment rail.
- **Does the flat policy hold?** The first time a customer asks for per-department caps, slice 3's hierarchy work is confirmed as necessary rather than assumed.

**Size: M.** Smaller than slice 1 in new surface, but it is the riskiest slice: live money, live inventory, and an approval flow that races a moving rate.

### Risks
- The supply swap is the moment T1 stops being theoretical. If slice 1 leaked any supplier assumption into policy, booking or UI code, this slice pays for it.
- Real money means the PCI and data-protection posture from slice 1 gets tested for real.
- Hard approval plus rate movement is the single most likely source of traveller anger in the whole product. Instrument it heavily.

---

## Slice 3 — Enterprise

> **Promise:** A 5,000-person company can buy this and retire its hotel TMC.

**Who uses it:** the customer named in the spec. This slice is mostly not traveller-facing — it is procurement, security, finance and the service desk.

### In scope
- **Identity:** SCIM provisioning; joiner, mover and leaver; the approval manager chain sourced from the directory.
- **Policy hierarchy:** global → entity → region → department → group, with visible inheritance showing which level set each effective value.
- **Multi-entity billing:** charges, invoices and reporting that never cross legal entities.
- **Audit:** immutable, attributable log of every policy change, approval, booking, cancellation and export, exportable for the customer's auditors.
- **Compliance:** SOC 2 Type II with evidence, third-party penetration test closed clean, DPA, published sub-processor list, configurable data residency.
- **Servicing (T3):** 24/7 staffed desk, walked-guest and overbooking recovery inside 60 minutes with a re-issued card, after-hours disruption rebooking.
- **Coexistence:** booking export and webhook so the customer's air TMC and duty-of-care stack still see one picture.
- **Arranger mode — recommended pull-in.** The spec defers it, but slice 3 *is* the enterprise moment, and T2 says executive travel has nowhere to go without it. Shipping slice 3 without arranger mode means selling TMC displacement to a sponsor whose own travel the product cannot handle. See the decision point below.

### Exit criteria
**A15, A16, A17, A18, A19, A21, A22, A23**, plus arranger mode if pulled in.

**Size: XL — and not deliverable by 2–4 engineers.** See below.

---

## The honest problem with slice 3

Slices 1 and 2 fit a small team. Slice 3 does not, and the gap is not about engineering speed:

- **A 24/7 staffed rota is headcount, not code.** Three to four support people minimum for genuine round-the-clock cover. No amount of engineering substitutes for it.
- **SOC 2 Type II requires an observation window** — typically 3–12 months of evidence — so the clock must start during slice 1, not slice 3. This is the one piece of slice 3 that must begin early.
- **SCIM, policy hierarchy, multi-entity billing and an auditor-grade log** are each substantial on their own, and all four are table stakes that win no deal by themselves.

Three ways through, to decide at the slice 2 exit, not now:

1. **Fund it.** Slice 3 is a staffed phase: engineers added, compliance bought from a platform, service desk outsourced to a travel BPO with your runbooks.
2. **Narrow the customer.** Sell slices 1–2 to mid-market single-entity companies where SCIM and multi-entity are not blockers, and build slice 3 only when a real deal demands it. This contradicts the spec's stated segment — a decision worth making deliberately rather than by drift.
3. **Keep the TMC.** Drop full displacement, position as the hotel booking layer beside the incumbent, and the 24/7 burden largely goes away. This contradicts the spec's TMC posture and removes T3 entirely.

**Recommendation:** plan for (2) and let a real deal pull you into (1). Build the platform so (3) stays available — which is exactly what the booking export and webhook buy you.

---

## Tracks that run across all three slices

These are not slices; they run continuously and a small team will drop them unless they are named.

- **Design partner recruitment.** You have none, and A21–A23 and A26 cannot be met without real travellers on real trips. Start during slice 1: the goal is one company whose travel patterns set the fixture data, the first cities and the first currency. Without this, slice 2 has no go-live.
- **The compliance clock.** Start SOC 2 readiness and evidence collection in slice 1. It is the only slice-3 item that cannot be compressed later.
- **Fixture realism.** Fixtures must keep pace with what live supply actually returns, or they stop catching regressions the moment slice 2 lands.
- **The honesty tests.** Two tests guard the product's only real differentiators and belong in CI from slice 1: no results card renders a field outside the approved list, and no ranking path reads commission.

---

## Decision points

Each slice boundary is a go/no-go, not a handoff.

**At slice 1 exit:**
- Did commute-time ranking change traveller behaviour? If not, stop and revisit the spec rather than continuing to slice 2.
- What is the strict-mode failure rate, and does it justify the approval subsystem?

**At slice 2 exit:**
- Which of the three paths through slice 3 are you taking?
- Does hard-approval-by-default survive its own SLA data?
- Is arranger mode pulled into slice 3? **Recommend yes** — it is cheaper than discovering mid-deal that the sponsor's own travel has no home.

**Standing:**
- Revenue must never reorder results. If anyone proposes commission-weighted sorting, the product is over.

---

## Sequencing for 2–4 engineers

Strictly sequential slices, with two streams inside each where the team allows:

- **Slice 1:** one engineer on the supply adapter, policy function and booking state machine; one or two on the traveller UI and commute ranking; payments last, because sandbox virtual cards can be stubbed until the journey is real.
- **Slice 2:** one engineer owns the live-supply swap and money end-to-end; one owns approvals and notifications. Chat entry is last and cuttable if anything slips — it is the only item in slices 1–2 that is not load-bearing.
- **Slice 3:** do not start until the resourcing path is chosen.

Not negotiable regardless of team size: the `RateSource` boundary, idempotency on every source write, and the policy function's purity. All three are cheap at the start of slice 1 and very expensive to retrofit in slice 2.
