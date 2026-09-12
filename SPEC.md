# Corporate Hotel Booking Platform — Build Spec v2

**One line:** An enterprise hotel booking platform that starts from *"where is your meeting?"*, ranks by commute time, shows one all-in number that never moves, and bills the company directly — displacing the incumbent TMC for hotels.

---

## 0. Confirmed decisions and flagged tensions

### Decided (your answers, 12 Sep 2026)

| Question | Decision |
|---|---|
| Build goal | **Production v1** — real software, production standards |
| Inventory | **Fixture / mock supply** behind a supplier adapter |
| Payment | **Central billing by default** (single-use virtual card) |
| Market | **Global, multi-currency, English-only UI** |
| Tax invoicing | **India GST only**; elsewhere tax is a line item |
| Platform | **Responsive web only** |
| AI | **Chat as an alternative entry point**; four screens stay primary |
| Customer | **Enterprise, 5,000+ staff** |
| Delegate booking | **Self-booking only** |
| TMC | **Replace the incumbent for hotels** |
| Over-cap default | **Hard approval** |

### Three tensions you should decide knowingly

**T1 — You cannot displace a TMC with fixture inventory.** "Production v1" and "mock supply" are compatible; "replace the TMC" and "mock supply" are not. This spec resolves it by splitting the gate: the whole platform is built and accepted to production standard on fixtures (§4, A1–A25), and a separate **supply-integration gate** (§4, S1–S3) must pass before any enterprise go-live. Fixtures are the development and acceptance substrate, not the launch substrate. If you intended fixtures to ship, the TMC-replacement claim has to come out.

**T2 — Self-booking only + full TMC displacement will not survive an enterprise deal.** In a 5,000-person company, executive travel is almost never self-booked; arrangers and EAs book it. Displacing the TMC for hotels while refusing delegate booking leaves executive hotel bookings with no home. v1 ships self-booking as instructed, and **arranger mode is the first post-v1 item**. Until it exists, scope the displacement to non-executive travel in every contract, or the incumbent stays for the population that matters most to the sponsor.

**T3 — Replacing the TMC means you own 24/7 servicing on day one.** A TMC's real product is the 2am phone call when a traveller is walked. This is not a phase-two concern; it is priced into §2.8 and gated in §4 (A20–A22). Budget a staffed rota, not an on-call engineer.

### Non-goals for v1
Flights, rail, cars. Expense-report authoring. Arranger/delegate booking (first post-v1). Group blocks of 10+ rooms. Hotel-side RFP and rate negotiation. Multi-language UI. Native apps. Compliant tax documents outside India.

---

## 1. Intent

### Why this shape
Four research findings force the product's structure. Each maps to a design consequence, not a feature.

| Finding | Source | Consequence |
|---|---|---|
| Travellers choose on **location (77%)**, then **policy (56%)**, then **price (53%)**. Amenities trail at 21%. | BCD Travel global traveller survey | Primary input is a **meeting address**, not a city. Default sort is **commute time**, not price. |
| **61%** abandon over hidden fees; 31% over late-stage price changes; **72%** cite hotel price disparity as a major pain. | Fullstory, Jun 2026; BCD | One all-in number, quoted at search, unchanged at confirm. Never a silent re-price. |
| **63%** name expense-report time as their top pain; **29%** staying inside reimbursement policy; **20%** paying out of pocket. | BCD payment & expense survey | Central billing by default. Zero-receipt trips. Policy enforced *before* the click. |
| **Wi-Fi (88%)** and **breakfast (80%)** are the services actually used; desk and quiet space matter on blended trips. | BCD; Hyatt 2026 | One **Work-ready** badge replaces a forty-checkbox amenity tree. |

### Who it serves
- **Traveller (primary).** Books their own trips. Wants it done in under a minute from a phone, near the meeting, without thinking about policy or money.
- **Approver (secondary).** A line manager who approves or rejects one over-cap exception in one tap, and is held to an SLA because a rate is moving while they think.
- **Travel manager / admin (secondary).** Owns policy across entities and regions. Answers "who is where tonight" and "what did we spend, where, against what cap".
- **Finance (tertiary).** Needs the charge on the right legal entity, in the right currency, with a GST-valid invoice for Indian entities.
- **Security / procurement reviewer (gating).** Not a user, but blocks the deal. SOC 2, SSO/SCIM, pen test and a DPA are acceptance criteria, not paperwork.

### Success means
Median search-to-confirm under **90 seconds** · **>85%** of bookings in policy with no exception · **>70%** of bookings requiring zero post-trip traveller action · **>95%** of over-cap approvals resolved inside the SLA without rate loss.

---

## 2. Behaviour

### 2.1 Four screens, plus one shortcut
```
[Search] → [Results] → [Confirm] → [Trip]
  where     commute-      one        check-in,
  /when     ranked      number      invoice, cancel
      ↑
   [Chat] — natural-language shortcut into Results
```
No hotel detail page in the default path; the card expands in place. No cart. No account wall — SSO only.

### 2.2 Search
- One input: **destination or meeting address** with places autocomplete, plus dates. Guests defaults to 1, rooms to 1.
- Paste a calendar invite, or connect the calendar, and dates + anchor address pre-fill.
- Returning travellers get their last three anchors as chips (`HSBC Bandra · 4 nights · Jun`).

### 2.3 Chat as an alternative entry
- A single free-text field: *"hotel near the Bandra office Tuesday to Friday, under the cap"*. It resolves to a structured search — anchor, dates, guests, constraints — and drops the traveller **straight into Results**.
- **Chat never books.** It resolves intent and hands off; confirmation always happens on the Confirm screen with the full number and cancellation terms visible. This is a deliberate safety boundary, not a phasing decision.
- When confidence in any extracted field is low, it asks one clarifying question, then falls back to the form with whatever it did resolve pre-filled. It never guesses a date silently.
- English only in v1. The chat field is an equal-weight entry point on Search, not a floating bubble, and not a separate product surface.

### 2.4 Results — the differentiator
- **Default sort: commute time to the anchor address.** Walking minutes under 12, otherwise transit or drive. Not straight-line distance, and not price.
- Card fields, in this order and no others: commute time → hotel name → **all-in total for the stay** → per-night → policy state → Work-ready badge → free-cancellation date.
- **Exactly three policy states**, always visible:
  - **In policy** (green) — bookable in one tap.
  - **Over cap** (amber) — bookable only via hard approval; shows the overage (`₹2,400 over your ₹8,000 cap`) and who will be asked.
  - **Blocked** (hidden behind a "show blocked" link, with the reason) — unapproved supplier, restricted country, non-refundable where policy requires flex.
- Filters, and only these: commute time, all-in price, Work-ready, free cancellation, breakfast included, brand/loyalty. Twenty per page, infinite scroll, skeleton cards streaming as sources answer. Map is a toggle, never the default.

### 2.5 Money, currency and rate rules
- Every rate carries: all-in total, cancellation deadline in the traveller's local time, breakfast yes/no, and source.
- **Three currencies exist per booking and all three are stored:** *supplier currency* (what the rate is sold in), *display currency* (traveller locale or company default), *settlement currency* (the billing entity's). Each conversion is persisted with its FX rate and timestamp. No stored amount is ever mutated by a re-conversion.
- **Caps are authored per currency**, per city tier, per entity. Where a traveller hits a market with no authored cap, conversion uses a **monthly-pinned corporate FX rate**, never a live rate — otherwise the same booking yields different policy verdicts on different days and §3.3's reproducibility requirement breaks.
- Tax: **India GST** produces a compliant invoice carrying the billing entity's GSTIN. Every other market shows tax as an itemised line that sums exactly to the all-in total, with a pluggable tax-document interface ready for the second regime.
- If a rate moves or disappears between search and confirm, the platform states the delta and requires a re-confirm.

### 2.6 Confirm
- One screen: traveller name pre-filled, rate summary, the single total, cancellation deadline, cost centre and legal entity pre-filled and editable.
- Payment is not a traveller decision. **Central billing via a single-use virtual card** issued at confirmation, scoped to the exact amount plus a configurable incidentals buffer, drawn on the correct legal entity. No personal-card path in v1.
- **Over cap → hard approval by default.** The traveller supplies a reason from the policy list plus free text. Then:
  - The rate is held where the source supports a hold. Where it does not, the traveller is told plainly that the rate may move — the system's job is to tell the truth about whether the rate is actually held.
  - The approver gets push, email and Slack with the overage amount and Approve / Reject. An SLA timer is visible to the traveller and the approver.
  - On SLA breach the request auto-escalates one level up the manager chain. It never silently expires.
- Confirmation is idempotent: a double-submit never produces two bookings.

### 2.7 Trip
One object: confirmation number, address with one-tap maps/ride-hail handoff, check-in time, hotel phone, cancellation deadline with a **Cancel** button, GST or tax invoice as soon as it is available, and a **Get help** button that reaches a human (§2.8).
Three nudges only: 24h before the free-cancellation deadline, 3h before check-in with the address, and after checkout only if incidentals are unbilled. Modify = cancel + rebook, one flow, price delta up front.

### 2.8 Servicing — because we replace the TMC
- **24/7 human support**, staffed rota, reachable from the Trip screen by chat and phone. Target answer under 2 minutes.
- **Walked-guest and overbooking recovery:** an agent can rebook a comparable in-policy property and re-issue the virtual card without the traveller paying anything, inside 60 minutes.
- **Disruption handling:** a traveller whose flight is cancelled gets a one-tap date shift with the price delta shown, including outside business hours.
- **Virtual-card declines** route to the same desk, with a hotel-facing authorisation letter attached to every booking from the start.

### 2.9 Admin — enterprise shape
- **Policy is hierarchical, not one page:** global defaults → legal entity → region → department → traveller group. Nightly caps per currency with named-city overrides, cancellation requirement, approval mode and approver chain, blocked suppliers and countries, cost centres, entity mapping. Inheritance is visible — an admin can see which level set an effective value.
- **Identity is not optional:** SAML/OIDC SSO and **SCIM provisioning** are mandatory. Joiner/mover/leaver flows, and the manager chain, come from the directory.
- **Multi-entity billing:** each booking is attributed to one legal entity, and charges, invoices and reporting never cross entities.
- **Reporting:** spend by entity/region/department/month, in-policy %, exception list with justifications and approver decisions, top properties, cap-breach patterns. CSV + a scheduled export; no BI builder in v1.
- **Immutable audit log:** every policy change, approval decision, booking, cancellation and data export is attributable to a user with a timestamp, and is exportable for the customer's own auditors.
- **Duty of care:** one "travellers in market tonight" view, per entity and globally. Restricted countries blocked; advisory-raised cities flagged at confirm.

### 2.10 Visual language — minimalist and load-bearing
One accent colour. Type-led, not image-led. Green / amber / hidden is the **only** use of colour as signal in results; everything else greyscale, so policy state cannot be missed. No hero imagery, no banners, no upsell interstitials, ever. Mobile-first at 390px; desktop is the same single column with the map beside it. Keyboard-navigable throughout; WCAG 2.2 AA.

---

## 3. Constraints

### 3.1 Supply — the critical path
- **v1 is built against a fixture supply source** implementing a `RateSource` interface: property content, availability, rates in multiple currencies, cancellation policies, and deliberately injected failure modes (timeout, price drift, sold-out-on-confirm, virtual-card decline). Fixtures must be adversarial, not happy-path — they are how A3, A5 and A20 get tested at all.
- **No booking, policy, billing or UI code may know which `RateSource` it is talking to.** Swapping fixtures for a live supplier is a configuration change plus one adapter, and is verified as such (S1).
- **Live supply is a go-live gate, not a backlog item.** Expedia Rapid is the recommended first adapter — roughly 700k properties, 200+ countries, and **no IATA accreditation required**, which is the only path that does not add a months-long accreditation dependency. A bedbank fills gaps. Negotiated corporate rates need GDS or direct chain deals and stay off v1's path, accepted as pass-through rate codes.
- Treat source latency as a design constraint from the first line of code: fan out in parallel, stream results, never block on the slowest source. Cache static property content hard; never cache availability or price.

### 3.2 Money and data
- **PCI DSS.** Never store, log or transmit a raw card number. Virtual cards are issued through a tokenising processor; card data lives only in that vault. Target SAQ-A scope — designing card data out of scope is far cheaper than complying with it in.
- **Virtual cards carry known operational risk.** Some properties decline them and check-in authorisation holds are a documented friction source. Every booking ships an authorisation letter, decline rate is a launch metric, and §2.8 owns the recovery path.
- **Data protection, enterprise grade.** GDPR and India's DPDP Act both in scope from day one. Lawful basis: contract performance for booking data, legitimate interest for duty of care — documented, with a DPA and a published sub-processor list. Data minimisation: name, work email, employer, entity, cost centre. No passport, no date of birth, no loyalty credentials in clear. Retention: bookings 7 years (tax), traveller location 90 days, search history 30 days. Per-traveller export and erasure from v1. Data residency configurable per customer — enterprise security reviews will ask.
- **SOC 2 Type II** controls implemented and evidenced, plus a third-party penetration test with no open high or critical findings. These gate the first deal, so they gate v1.

### 3.3 Engineering
- Bookings are money. Every source write carries an idempotency key. Booking state is a persisted machine — `searched → held → pending_approval → confirmed → modified → cancelled → settled` — and every request/response to a source is logged immutably for disputes.
- Policy evaluation is a **pure, versioned function**: `(rate, traveller, policyVersion, fxPin) → in | over | blocked + reason`. Server-side, one code path for display and enforcement, verdict stored with the booking so an audit years later reproduces the decision exactly — which is why the FX pin is an input, not a lookup.
- Approval holds assume rate loss. Correctness is telling the truth about whether the rate is held, not pretending it is.
- A source outage degrades — fewer results, a banner — never errors.
- Performance budget: search p95 **<3s**, confirm p95 **<5s**, interaction **<100ms**, FCP on 4G **<1.5s**. Availability **99.9%**, contractual.

### 3.4 Commercial
- Revenue is source commission plus a per-booking or per-seat SaaS fee. **Revenue must never reorder results** — a commission-weighted sort destroys the only thing being sold, which is commute-time honesty. Enforce it as a test, not a principle.
- Enterprise sales cycles are 6–12 months and gated by security review, so the compliance work in §3.2 is on the critical path alongside the product — it cannot trail it.
- Displacing a TMC for hotels while air stays with the incumbent means the customer runs two tools. Expect to supply a clean booking export and webhook so their duty-of-care and reporting stack still sees one picture.

---

## 4. Acceptance

### Launch gates
v1 is **feature-complete** when A1–A25 pass on fixture supply. v1 is **shippable to an enterprise** only when S1–S3 also pass on live supply. Do not conflate the two (see T1).

### Journey
- **A1** A traveller lands via SSO, types a meeting address, picks dates and confirms in **under 90 seconds, median, on a phone** — no account setup, no payment entry.
- **A2** Default order is commute time to the anchor, and the top result's stated commute is within **±3 minutes** of a maps reference for 9 of 10 spot-checked addresses.
- **A3** The total on the first results screen equals the total on the confirmation email **to the cent**, across 100 consecutive bookings including fixture price-drift cases. Drift surfaces as an explicit re-confirm, never a silent adjustment.
- **A4** An in-policy booking takes **exactly one tap** from results card to confirmation.
- **A5** An over-cap booking cannot be confirmed without a justification; the approver is notified within 30 seconds; the traveller is told truthfully whether the rate is held; SLA breach auto-escalates one level and never silently expires.
- **A6** A blocked rate cannot be booked through the UI **or** by posting it directly to `/bookings`.
- **A7** Cancelling inside the free window costs zero, takes one tap, and reaches the source within 60 seconds.
- **A8** Across a 50-utterance corpus, chat resolves anchor and dates correctly or asks exactly one clarifying question in **9 of 10** cases, and **never** completes a booking.

### Money and records
- **A9** Every confirmed booking produces a central-billing charge with **no traveller out-of-pocket**, drawn on the correct legal entity.
- **A10** An Indian-entity booking produces a **GST-compliant invoice carrying the entity's GSTIN** within 48 hours of checkout, accepted by a tax reviewer. Non-GST markets itemise tax in lines that sum exactly to the all-in total.
- **A11** Supplier, display and settlement currencies are all stored per booking with FX rate and timestamp, and every displayed figure is re-derivable from them months later.
- **A12** Re-running policy evaluation against a stored booking reproduces the verdict and reason string **byte-identical**, including the pinned-FX conversion path.
- **A13** No raw card number appears in any database, log or trace — proven by a scan of all three.
- **A14** A double-submitted confirmation yields exactly one booking.

### Enterprise and trust
- **A15** SSO and **SCIM** are live: a directory joiner can book within 15 minutes, and a leaver cannot book at all. The manager chain used for approvals comes from the directory, not a spreadsheet.
- **A16** A policy value set at global level is visibly overridden at entity, region, department and group level, and the admin UI shows **which level set the effective value**.
- **A17** Charges, invoices and reports never cross legal entities — verified with a two-entity fixture customer.
- **A18** The audit log attributes every policy change, approval, booking, cancellation and export to a user and timestamp, is immutable, and exports for the customer's auditors.
- **A19** SOC 2 Type II controls are implemented with evidence collected, and a third-party penetration test closes with no open high or critical findings.
- **A20** A traveller data export and a full erasure both complete from the admin UI, and data residency is configurable per customer.

### Servicing
- **A21** 24/7 support answers in **under 2 minutes** by chat and phone, in a drill run at 3am local.
- **A22** A walked or overbooked traveller is rebooked into a comparable in-policy property, with a re-issued virtual card and **zero traveller payment**, inside 60 minutes.
- **A23** A traveller whose flight is cancelled shifts their dates in one tap with the delta shown, outside business hours.

### Quality bar
- **A24** Search p95 under 3s and confirm p95 under 5s at 50 concurrent searches; a source forced to time out **degrades the page without erroring it**; measured availability 99.9%.
- **A25** Every screen is usable at 390px, keyboard-only, and passes automated WCAG 2.2 AA checks. A build-failing test asserts that no results card renders any element outside the approved field list.
- **A26** Five real business travellers complete an unguided booking, and at least four say **unprompted** that they know what the trip cost them personally (nothing) and what they must do afterwards (nothing).

### Supply-integration gate (before any enterprise go-live)
- **S1** The fixture `RateSource` is replaced by a live supplier adapter with **zero changes** to policy, booking, billing or UI code.
- **S2** A3's to-the-cent price parity and A5's rate-hold honesty both re-pass on live inventory.
- **S3** Virtual cards are accepted at **95% or more** of the top 200 properties by the launch customer's volume, with a working fallback for the rest.

---

### Research sources
BCD Travel payment & expense survey 2026 · BCD Travel global traveller accommodation-choice survey · Fullstory Travel & Hospitality Survey, Jun 2026 · BTN Hotel Survey Report 2026 · Hyatt business-traveller research 2026 · Expedia Rapid / Hotelbeds / Amadeus hotel-API capability comparisons 2026 · PCI DSS hospitality guidance · Navan / TravelPerk / Engine / Spotnana feature comparisons 2026
