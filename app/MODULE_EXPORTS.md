# Module export contract — Slice 1

Four streams build in parallel against this. Every signature here is frozen:
implement exactly these names, in exactly these files. All imports use explicit
`.ts` extensions (`allowImportingTsExtensions` is on).

Read-only for everyone: `src/core/types.ts`, `src/supply/RateSource.ts`,
`src/routing/RouteSource.ts`, `src/payments/CardIssuer.ts`, `src/store/Store.ts`,
`src/web/design/tokens.css`, `API_CONTRACT.md`, `DESIGN.md`, `package.json`,
`tsconfig.json`, `vite.config.ts`, `vitest.config.ts`.

---

## Stream A — `src/core/*` (pure, zero I/O, no `Date.now()` inside decisions)

### `money.ts`
```ts
export function money(minor: number, currency: Currency): Money
export function addMoney(a: Money, b: Money): Money
export function subMoney(a: Money, b: Money): Money
export function sumMoney(items: readonly Money[], currency: Currency): Money
export function multiplyMoney(m: Money, factor: number): Money   // integer factor
export function compareMoney(a: Money, b: Money): number
export function formatMoney(m: Money, opts?: { decimals?: boolean }): string
export class CurrencyMismatchError extends Error
```
`formatMoney` groups Indian-style for INR (`₹34,800`), Western for others
(`$1,240`, `€980`). Symbols: INR ₹, USD $, EUR €, GBP £, AED AED, SGD S$.
Default `decimals: false` — minor units are hidden unless non-zero.

### `pricing.ts`
```ts
export function componentsSum(components: readonly RateComponent[]): Money
export function assertComponentsSum(rate: Rate): void   // throws PricingIntegrityError
export function perNightFrom(total: Money, nights: number): Money
export function breakdown(rate: Rate): { base: Money; taxes: Money; fees: Money; total: Money }
export function totalsEqual(a: Money, b: Money): boolean
export function driftBetween(accepted: Money, current: Money): PriceDriftDetail | null
export class PricingIntegrityError extends Error
```
`driftBetween` returns null when equal. `perNightFrom` floors; the remainder stays
in the total so per-night × nights may be ≤ total — the total is authoritative.

### `commute.ts`
```ts
export function nightsBetween(checkIn: IsoDate, checkOut: IsoDate): number
export function haversineMeters(a: GeoPoint, b: GeoPoint): number
export function estimateCommute(from: GeoPoint, to: GeoPoint): Commute
export function describeCommute(c: Commute): string   // "7 min walk"
```
Banding, fixed: walk at 80 m/min; if walk minutes ≤ 12 → `walk`. Else if distance
≤ 15 km → `transit` (18 km/h + 6 min wait). Else → `drive` (28 km/h). Minutes are
rounded, and never 0 — minimum 1.

### `rank.ts`
```ts
export interface RankInput { offer: Offer; commute: Commute; verdict: PolicyVerdict }
export function rankOffers(inputs: readonly RankInput[]): RankedOffer[]
```
Sort: commute.minutes asc → negotiated channel first → allInTotal asc →
property.id asc (determinism). **Only `in` offers are numbered**, 1..n. Blocked
offers get `rank: 0`, `rankReason: ""`, and are returned after the ranked ones.
`rankReason`: rank 1 → `"closest to your meeting"`; otherwise
`"+{delta} min vs closest"`. **Never reads price before commute, and never reads
channel commission.** A test asserts this ordering.

### `policy.ts`
```ts
export const POLICY_EVALUATOR_VERSION = 1
export function capFor(policy: Policy, property: Property): Money | null
export function evaluate(args: { rate: Rate; property: Property; policy: Policy }): PolicyVerdict
export function replay(booking: Booking, policy: Policy): PolicyVerdict
```
Check order is fixed and must not change (A12 replay depends on it):
1. `blocked_country` — `policy.blockedCountries` includes `property.countryCode`
2. `blocked_supplier` — `policy.blockedSuppliers` includes `rate.sourceId`
3. `flex_required` — `policy.requireFlexible && rate.refundableUntil === null`
4. `over_cap` — cap exists and `rate.perNight > cap`
5. otherwise `within_cap`

Reason strings are part of the stored record and must be produced **exactly**:
- `within_cap`: `"₹8,700/night is within your ₹9,000 Mumbai cap"`
- `over_cap`: `"₹8,700/night is over your ₹8,000 Mumbai cap by ₹700 — ₹2,800 for 4 nights"`
- `blocked_country`: `"Bookings in AE are blocked by your travel policy"`
- `blocked_supplier`: `"This supplier is not approved by your travel policy"`
- `flex_required`: `"Your policy requires a free-cancellation rate"`

Cap label uses `property.city` when a city override matched, else `property.cityTier`.
Money in reasons is rendered with `formatMoney`. `evaluate` is pure: same inputs →
byte-identical output, forever.

### `booking.ts`
```ts
export const ALLOWED_TRANSITIONS: Record<BookingState, readonly BookingState[]>
export function canTransition(from: BookingState, to: BookingState): boolean
export function assertTransition(from: BookingState, to: BookingState): void
export function isCancellableAt(b: Booking, now: Date): boolean
export class IllegalTransitionError extends Error
```
Slice 1 graph: `searched→held`, `searched→confirmed`, `held→confirmed`,
`held→cancelled`, `confirmed→cancelled`, `confirmed→settled`. Nothing leaves
`cancelled` or `settled`.

### `ids.ts`
```ts
export function newId(prefix: string, rand?: () => number): string
export function newConfirmationCode(rand?: () => number): string  // 6 chars, A-Z2-9, no I/O/0/1
export function isValidIdempotencyKey(k: string): boolean          // 8..200 chars, printable
export function stableHash(value: unknown): string                 // key-order independent
```

### `format.ts`
```ts
export function formatDateRange(checkIn: IsoDate, checkOut: IsoDate): string  // "11–15 Jun"
export function formatDeadline(iso: IsoDateTime, timeZone?: string): string   // "6:00 pm, Sat 14 Jun"
export function formatDuration(ms: number): string                            // "840ms" / "1.2s"
```

---

## Stream B — supply, routing, payments

### `src/supply/fixtures/anchors.ts`
```ts
export const FIXTURE_ANCHORS: readonly Anchor[]
export function resolveAnchor(query: string): Anchor | null   // case/punctuation-insensitive, alias-aware
```
At least 6 anchors across Mumbai (BKC), Bengaluru (Whitefield, Koramangala),
Gurugram (Cyber City), Hyderabad (HITEC City), Pune (Hinjewadi). Real coordinates.

### `src/supply/fixtures/properties.ts`
```ts
export const FIXTURE_PROPERTIES: readonly Property[]
export function propertiesNear(geo: GeoPoint, radiusMeters: number): Property[]
```
35–50 properties clustered around the anchors at genuinely varied distances
(200 m to 14 km) so commute ranking has something to say. **Invent every property
name** — no real hotel or chain names anywhere, because fixture rates must never
be mistakable for a real quote. `cityTier` one of `"tier1" | "tier2" | "metro"`.
Mix `workReady` roughly 60/40.

### `src/supply/fixtures/rates.ts`
```ts
export function ratesFor(property: Property, query: SearchQuery, sourceId: string): Rate[]
```
Deterministic from `(property.id, checkIn, sourceId)` — same search twice gives the
same prices. 1–2 rates per property. Components must sum **exactly** to
`allInTotal` (12% GST line + a service fee on some). Spread per-night prices so a
single cap produces a realistic mix of in-policy and over-cap. ~35% non-refundable.

### `src/supply/fixtures/adversarial.ts`
```ts
export type FailureMode = "none" | "timeout" | "drift" | "sold_out" | "slow"
export interface ChaosConfig { timeoutSourceIds: string[]; driftOfferIds: string[]; soldOutOfferIds: string[]; latencyMs: Record<string, number>; enabled: boolean }
export function chaosFromEnv(env: NodeJS.ProcessEnv): ChaosConfig
export function defaultChaos(): ChaosConfig
export const DRIFT_MARKER_SUFFIX: string   // offer ids ending with this always drift
export const SOLD_OUT_MARKER_SUFFIX: string
```
Drift must be **deterministic and addressable** — tests need an offer that always
drifts and one that is always sold out. Env: `SM_CHAOS=off|on`, `SM_CHAOS_TIMEOUT=<sourceId>`.

### `src/supply/FixtureRateSource.ts`
```ts
export function createFixtureRateSources(opts?: { chaos?: ChaosConfig }): RateSource[]
```
Exactly 4 sources with distinct `id`/`displayName` and different latencies
(~120ms, ~400ms, ~900ms, ~1800ms) and overlapping-but-different property subsets,
so the streaming source meter has real behaviour to show. Respect the
`AbortSignal`. `priceCheck` applies drift/sold-out deterministically. `book`
throws `SupplierPriceDriftError` / `SupplierSoldOutError` as configured.

### `src/routing/LocalRouteSource.ts`
```ts
export function createLocalRouteSource(): RouteSource
```
Delegates to `core/commute.ts#estimateCommute`. `commuteBatch` is one pass, no N+1.

### `src/payments/SandboxCardIssuer.ts`
```ts
export function createSandboxCardIssuer(opts?: { declineRate?: number; alwaysDeclineRefs?: string[] }): CardIssuer
```
Returns tokenRef + last4 only. **Never generates, stores or logs a PAN — not even a
fake one**, because A13 is verified by scanning the codebase and logs for card-like
digit runs. `last4` is 4 digits derived from a hash. Deterministic declines via
`alwaysDeclineRefs` for tests.

### Tests (`tests/unit/supply-*.test.ts`)
Determinism of `ratesFor`, exact component sums across every fixture, anchor
resolution, abort handling, drift/sold-out markers, and that no fixture property
name matches a list of real hotel brands.

---

## Stream C — store + server

### `src/store/FileStore.ts`
```ts
export function createFileStore(dir: string): Store
export function createMemoryStore(): Store   // used by API tests
```
Atomic writes (temp file + rename). Source log is append-only JSONL. Policy saves
keep every version.

### `src/server/audit.ts`
```ts
export function instrumentRateSource(src: RateSource, store: Store, correlationIdFor: () => string): RateSource
export function instrumentCardIssuer(issuer: CardIssuer, store: Store): CardIssuer
```
Wraps each port so every call appends a `SourceLogEntry`. **Redact nothing except
card fields; there are none to redact by construction.**

### `src/server/search.ts`
```ts
export interface SearchRegistry { create(...): SearchSession; get(id): SearchSession | undefined }
export function createSearchRegistry(deps: { sources: RateSource[]; routes: RouteSource; store: Store }): SearchRegistry
```
One `SearchSession` per search: fans out to all sources in parallel with a
per-source timeout (2.5 s), computes commutes in one batch, evaluates policy,
ranks, and emits events to subscribers as each source answers. A failed or timed-out
source marks itself failed and the session continues. Sessions expire after 30 min.

### `src/server/auth.ts`
```ts
export function createAuth(store: Store): { login, logout, middleware, requireAdmin }
```
Signed session cookie `sm_session` (HMAC, secret from `SM_SECRET`, dev default).
JIT traveller creation on first login. First-ever traveller is `isAdmin: true`.

### `src/server/index.ts`
```ts
export function createApp(deps: AppDeps): express.Express
export function buildDefaultDeps(opts?: { dir?: string; memory?: boolean }): AppDeps
export interface AppDeps { store: Store; sources: RateSource[]; routes: RouteSource; issuer: CardIssuer; now: () => Date }
```
Implements `API_CONTRACT.md` exactly. Listens on `SM_PORT ?? 8787` when run
directly. `now` is injectable so tests can control the cancellation window.
Serves `dist/web` statically when it exists, so `npm run build && npm start` is a
single-origin production run.

Seed on first boot: a default policy for entity `acme`, caps
`metro ₹9,000 / tier1 ₹7,000 / tier2 ₹5,000`, `requireFlexible: false`,
blockedCountries `[]`, cost centres `["ENG-OPS","SALES","FINANCE"]`.

### Tests (`tests/api/*.test.ts`, supertest)
Happy-path book, idempotency replay, blocked-by-policy rejection at the API,
price drift 409, sold-out 410, card decline 402, cancel inside and outside the
window, CSV shape, admin auth, SSE event sequence.

---

## Stream D — web (`src/web/**`, excluding `design/tokens.css`)

Implements `DESIGN.md` against `API_CONTRACT.md`. Files: `index.html`, `main.tsx`,
`App.tsx`, `lib/api.ts`, `lib/fmt.ts`, `design/*.css`, `components/*`, `screens/*`.
Routes: `/` Search · `/results/:searchId` · `/confirm/:searchId/:offerId` ·
`/trip/:bookingId` · `/trips` · `/admin`.
May import pure helpers from `src/core/*` (money/format) — never from `server/`.

---
---

# Slice 2 module export contract

Frozen before implementation, exactly like Slice 1. Types come from
`src/core/types.ts`; ports from `src/supply/RateSource.ts`,
`src/payments/CardIssuer.ts`, `src/store/Store.ts`, `src/store/DocPersistence.ts`,
`src/notify/Notifier.ts`, `src/intent/IntentParser.ts`. **All of those are
read-only for every stream**, as are `API_CONTRACT.md`, `DESIGN.md`,
`src/web/design/tokens.css`, `package.json`, `tsconfig.json` and the vite/vitest
configs. Do not run `npm install`: `@vercel/blob` and `@anthropic-ai/sdk` are
already installed.

Slice 1 exports that are not mentioned here keep their signatures. Where a Slice
1 test asserts behaviour that Slice 2 deliberately changes, the owning stream
updates that test and says so in its report.

---

## Stream A — `src/core/*` (pure)

### `fx.ts` (new)
```ts
export const CURRENCY_EXPONENT: Readonly<Record<string, number>>   // INR,USD,EUR,GBP,AED,SGD 2; JPY 0; BHD,KWD 3
export function exponentOf(currency: Currency): number              // default 2
export function convert(amount: Money, rate: FxRate): Conversion    // rate.base must equal amount.currency
export function convertVia(amount: Money, to: Currency, pins: readonly FxRate[]): Conversion
export function pinMonthOf(at: Date): IsoMonth                      // UTC calendar month
export function monthLabel(month: IsoMonth): string                 // "2026-09" → "Sep" (fixed table, no Intl)
export function formatRate(rate: FxRate): string                    // "1 GBP = ₹106.25 · Sep pinned"
export class NoFxPinError extends Error
export class FxMismatchError extends Error
```
Integer arithmetic only, via `BigInt`:
`toMinor = from.minor × rateMicros × 10^exp(quote) ÷ (10^6 × 10^exp(base))`,
rounded **half to even**. `convertVia` returns `fx: null` for the same currency,
uses a direct pin when one exists, otherwise the inverse pin (inverse
`rateMicros = round_half_even(10^12 ÷ rateMicros)`), and otherwise throws
`NoFxPinError`. It never chains through a third currency.

### `policy.ts` (v2)
```ts
export const POLICY_EVALUATOR_VERSION = 2
export function capFor(policy: Policy, property: Property, rateCurrency?: Currency): Money | null
export function advisoryFor(policy: Policy, property: Property): TravelAdvisory | null
export function evaluate(args: { rate: Rate; property: Property; policy: Policy; fxPins: readonly FxRate[]; pinMonth: IsoMonth }): PolicyVerdict
export function evaluateV1(args: { rate: Rate; property: Property; policy: Policy }): PolicyVerdict
export function replay(booking: Booking, policy: Policy): PolicyVerdict
```
- `capFor`: named-city rows beat tier rows. Among rows at the winning level, a cap
  authored in `rateCurrency` beats one authored in another currency.
- `evaluateV1` is the Slice 1 evaluator, **frozen byte-for-byte**, including the
  Slice 1 check that over-cap returns `state: "blocked"`. Its output has no
  `evaluatorVersion`, `overage`, `fxPin` or `advisory` keys.
- `replay` dispatches on `booking.verdict.evaluatorVersion ?? 1`. For v2 it passes
  `[verdict.fxPin]` when non-null, so replay never needs today's pins.
- `evaluate` (v2) keeps the check order `blocked_country → blocked_supplier →
  flex_required → cap`, and always sets `evaluatorVersion: 2`, `overage`, `fxPin`
  and `advisory` (the last three may be null). Over cap is `state: "over"`.
- Currency handling: when the cap and the rate share a currency, compare `perNight`
  directly. Otherwise convert `rate.perNight` into the cap currency with
  `convertVia` over the **`pinned_monthly`** pins only, and record the pin used. If
  no pin exists the verdict is `over` (never silently in policy) with the no-pin
  reason below.
- `overage` and `overageMinor` are per night, **in the cap currency**.

Reason strings, exact (`N night`/`N nights` pluralised; em-dash U+2014; money via
`formatMoney`; month via `monthLabel`):
```
within, same ccy : "₹8,700/night is within your ₹9,000 Mumbai cap"
within, converted: "£412/night (₹43,775 at the Sep pinned rate) is within your ₹45,000 London cap"
over, same ccy   : "₹10,594/night is over your ₹9,000 Mumbai cap by ₹1,594 — ₹6,376 for 4 nights"
over, converted  : "£520/night (₹55,250 at the Sep pinned rate) is over your ₹45,000 London cap by ₹10,250 — ₹41,000 for 4 nights"
over, no pin     : "£520/night can't be checked against your ₹45,000 London cap — there is no pinned GBP→INR rate for Sep, so it needs approval"
no cap           : "₹8,700/night is within your travel policy — no cap is set for metro"
blocked_*        : unchanged from Slice 1
```
`pinMonth` is the month of evaluation, which a pure function cannot know, so the
caller passes it. It only names the month in the no-pin reason. `replay` takes it
from `verdict.fxPin?.pinMonth`, else from the booking's `createdAt`.

### `rank.ts` (v2)
```ts
export interface RankInput { offer: Offer; commute: Commute; verdict: PolicyVerdict; display: Conversion }
export function dedupeByProperty(inputs: readonly RankInput[]): RankInput[]
export function rankOffers(inputs: readonly RankInput[]): RankedOffer[]
```
`in` and `over` offers are numbered together, 1..n. Sort order: commute minutes →
`in` before `over` → negotiated channel → `display.to.minor` → property id.
Blocked offers get rank 0 and come last. Dedupe keeps one row per property,
preferring `in` over `over` over `blocked`, then negotiated, then the lower
`display.to.minor`, then rate id. It still never reads price before commute and
never reads commission.

### `approval.ts` (new)
```ts
export function validateJustification(policy: Policy, j: { code: string; text: string }): { ok: true } | { ok: false; message: string }
export function resolveApproverChain(args: { traveller: Traveller; directory: readonly Traveller[]; policy: Policy }): string[]
export function openApproval(args: { id: string; booking: Booking; justification: { code: string; text: string }; chain: readonly string[]; policy: Policy; now: Date }): ApprovalRequest
export function materialiseEscalations(req: ApprovalRequest, now: Date): { approval: ApprovalRequest; escalated: readonly ApprovalLevel[] }
export function currentLevel(req: ApprovalRequest): ApprovalLevel
export function canDecide(req: ApprovalRequest, approverId: string): boolean
export function slaView(req: ApprovalRequest, now: Date): { level: number; approverId: string; dueAt: IsoDateTime; remainingMs: number; breached: boolean; atTop: boolean; nextApproverId: string | null }
export function decide(req: ApprovalRequest, args: { approverId: string; decision: "approve" | "reject"; note: string | null; now: Date }): ApprovalRequest
export function withdraw(req: ApprovalRequest, now: Date): ApprovalRequest
export function recordOutcome(req: ApprovalRequest, outcome: ApprovalOutcome): ApprovalRequest
export class NotCurrentApproverError extends Error
export class AlreadyDecidedError extends Error
export class RejectionNoteRequiredError extends Error
```
- A justification is valid when its code is in `policy.approval.justificationReasons`
  and its trimmed text is at least 10 characters (spec §2.6).
- The chain walks `managerId` upward, skipping erased travellers and the traveller
  themself. It is cycle-safe and has at most `maxEscalations + 1` entries. When
  empty, use fallback approvers resolved by email; then admins other than the
  traveller; then `[]`.
- Escalation is deterministic from history: level n is due at
  `startedAt + slaMinutes`. When it breaches and a next approver exists within
  `maxEscalations`, the next level **starts at the previous `dueAt`** — not at
  `now` — so a late read produces the same history as an on-time one. Several
  levels may materialise in one call. Past the last level, `slaBreachedAtTop` is
  set and the state stays `pending`: it never expires.
- `canDecide`: any chain member at or below the current level. Escalation widens
  who may decide; it never revokes anyone. `decide` materialises escalations as
  of `now` first. A rejection requires a non-empty note.

### `gst.ts` (new) — India GST 2.0, rates effective 22 Sep 2025
```ts
export const SAC_ACCOMMODATION = "996311"
export const GST_STATE_NAMES: Readonly<Record<string, string>>        // at least 27,29,06,36,07,33,24,09,19,32
export function gstRatePercentForTariff(tariffPerNight: Money): 0 | 5 | 18   // INR: ≤₹1,000 → 0; ≤₹7,500 → 5; else 18
export function gstForStay(tariffPerNight: Money, nights: number): { ratePercent: 0 | 5 | 18; taxPerNight: Money; tax: Money }
export function gstinCheckDigit(first14: string): string
export function isValidGstin(gstin: string): boolean
export function financialYearOf(at: IsoDate | IsoDateTime): string    // Apr–Mar in Asia/Kolkata: "2026-27"
export function invoiceNumber(prefix: string, financialYear: string, sequence: number): string // "ACME/2627/000123"
export function buildInvoice(args: { id: string; booking: Booking; entity: LegalEntity; number: string; financialYear: string; issuedAt: IsoDateTime }): Invoice
export class InvoiceNumberTooLongError extends Error
```
- `taxPerNight` is rounded to whole rupees (half to even), and `tax = taxPerNight × nights`.
- `invoiceNumber` throws when the number exceeds 16 characters (GST rule 46).
- `buildInvoice` for an Indian property priced in INR gives `gst_tax_invoice`. The
  supplier is the hotel (name, `supplierGstin`, `stateCode`), the recipient is the
  entity, and `placeOfSupply` is `property.stateCode` (the location of the
  accommodation). Accommodation is intra-state for the hotel, so CGST =
  floor(tax/2) and SGST = tax − CGST.
- Lines must reconcile **exactly** to `booking.offer.rate.allInTotal`.
- ITC: under the 5% or 0% slab, `claimable: false` with
  `"The 5% slab carries no input tax credit"`. At 18% with the entity state equal
  to the property state, `claimable: true` with
  `"Charged as Karnataka CGST + SGST to your Karnataka GSTIN"`. At 18% in another
  state, `claimable: false` with `"Charged as Karnataka CGST + SGST — your GSTIN is
  registered in Maharashtra, so this credit can't be claimed there"`.
- Anywhere else the kind is `tax_summary`: each non-base component becomes an
  `otherTax` line, and ITC is `claimable: false` with `"This is a tax summary, not a
  GST document"`.

### `intent.ts` (new)
```ts
export function parseIntent(text: string, ctx: IntentContext): ParsedIntent  // IntentContext from src/intent/IntentParser.ts (type-only import)
```
Deterministic, with `now` and `timeZone` from ctx. It understands:
- **Weekday ranges** — "tue to fri", "Tuesday–Friday", "mon-wed next week" — taken as
  the next occurrence on or after tomorrow.
- **Explicit dates** — "12-15 Oct", "12 Oct to 15 Oct", "from 12th October for 3 nights",
  "tomorrow for 2 nights", "next week" (Mon–Fri). A date already passed rolls to next year.
- **Guests and rooms** — "for 2 people", "2 guests", "me and a colleague" → 2, "2 rooms".
- **Anchors** — "near X", "close to X", "at X", "X office", matched with
  `ctx.resolveAnchor`, stripping filler words.
- **Constraints** — "under the cap" / "in policy" / "within budget" → inPolicyOnly;
  "work-ready" / "desk" / "good wifi"; "free cancellation" / "flexible" / "refundable";
  "breakfast"; "walking distance" → maxCommuteMinutes 12; "within 15 min(utes)".
- **Confidence** — 1.0 when resolved from an explicit phrase, 0.7 for an inferred
  default (e.g. a weekday range without a week), 0 when missing.
- **Clarification** — exactly one question when anchor confidence or date
  confidence is below 0.6. Ask about the anchor first (options: up to 4 anchor
  labels), otherwise the dates (options: `"Tomorrow · 1 night"`,
  `"Mon–Wed next week"`, `"Mon–Fri next week"`).
- **readBack** — `"BKC, Mumbai · Tue 15 – Fri 18 Sep · 1 guest · in policy"`,
  omitting parts that are unknown.
- `parser: "rules"`.

### `modify.ts` (new)
```ts
export function canModify(booking: Booking, now: Date): { ok: true } | { ok: false; code: "not_confirmed" | "outside_free_window"; message: string }
export function quoteModify(args: { booking: Booking; newOffer: Offer; newVerdict: PolicyVerdict; searchId: string; now: Date }): ModifyQuote
```
Messages, exact:
- `"₹2,400 more than your current booking"`
- `"₹1,200 less than your current booking"`
- `"Same total as your current booking"`
- `"Your current booking can no longer be cancelled for free, so changing it would cost ₹26,328"`

### `booking.ts` (v2)
Transitions: `searched→held|pending_approval|confirmed` ·
`held→pending_approval|confirmed|cancelled` ·
`pending_approval→confirmed|rejected|cancelled` ·
`confirmed→cancelled|modified|settled`. Nothing leaves
`modified|rejected|cancelled|settled`.
Add `export function canWithdraw(b: Booking): boolean` (true only when `pending_approval`).
`isCancellableAt` is true only for `confirmed` bookings before the deadline.

### `duty.ts` (new)
```ts
export function travellersInMarket(args: { date: IsoDate; bookings: readonly Booking[]; travellers: readonly Traveller[]; policy: Policy }): InMarketTraveller[]
export function summariseByCountry(rows: readonly InMarketTraveller[]): Array<{ countryCode: string; count: number; advisories: number }>
```
In market means the booking is `confirmed` or `pending_approval` and
`checkIn ≤ date < checkOut`. Rows sort by country, then city, then name.

### `retention.ts` (new)
```ts
export const RETENTION: { readonly bookingsYears: 7; readonly locationDays: 90; readonly searchDays: 30 }
export function pseudonymFor(travellerId: string): string          // "erased-" + stableHash(id).slice(0, 10)
export function eraseTraveller(t: Traveller, now: Date): Traveller  // name "Erased traveller", email `${pseudonym}@erased.invalid`, erasedAt
export function scrubBookingForErasure(b: Booking): Booking         // anchor → { label: "(erased)", geo: {0,0}, city, countryCode }; money, tax and property facts kept
export function searchCutoff(now: Date): IsoDateTime
```

### `money.ts` / `format.ts` additions
```ts
export function absMoney(m: Money): Money
export function isZeroMoney(m: Money): boolean
export function formatRemaining(ms: number): string     // "1h 42m left" · "12m left" · "overdue by 7m"
```

---

## Stream B — supply, adapters, notifiers, intent adapters

### Fixtures v2
- **Anchors** — add Marina Bay Financial Centre, Singapore (SG); DIFC, Dubai (AE);
  Canary Wharf, London (GB). Real coordinates and aliases ("mbfc", "difc",
  "canary wharf").
- **Properties** — 5–7 invented properties around each new anchor. Every property
  has `timeZone`. International properties use `cityTier: "global"` — update the
  Slice 1 test that allows only three tiers. Indian properties get a `stateCode` for their real state
  (Maharashtra 27, Karnataka 29, Haryana 06, Telangana 36) and a checksum-valid
  `supplierGstin` built with `gstinCheckDigit` from `core/gst.ts`. Others get null
  for both. Names remain invented.
- **Rates**:
  - Every rate sets `tariffPerNight`, the per-night base.
  - **Indian rates are exactly two components**: `base "Room charge"` and
    `tax "GST (5%)"` or `"GST (18%)"`, from `gstForStay`. No service fee, so the GST
    invoice reconciles exactly.
  - International rates are in the local currency with local components: GB
    `VAT (20%)`; AE `VAT (5%)` plus a fee `Municipality fee (7%)`; SG a fee
    `Service charge (10%)` plus a tax `GST (9%)` applied on base + service charge.
    Components still sum exactly to `allInTotal`, and `perNight` stays exact.
  - Spread prices so the seeded caps produce `in`, `over` and a few `blocked` rates
    in every city.
- **Holds** — `fx-alpha` (up to 240 minutes) and `fx-gamma` (up to 120 minutes)
  support holds. About 70% of their rates are `holdable: true`. `fx-beta` and
  `fx-delta` do not support holds.
- **Stateless holds** — a `holdRef` is self-describing: it encodes the offer id,
  held total and `heldUntil`. That lets `book({ holdRef })` work on any serverless
  instance.
  - `book` with a valid hold books at the held total, even for a drift canary.
  - `book` with an expired hold throws `SupplierHoldExpiredError`.
  - `hold` on a non-holdable rate throws `SupplierHoldUnsupportedError`.
- **New canary** — a rate id ending `~LATEDRIFT` has a stable `priceCheck` but a
  `book` (without a hold) that throws `SupplierPriceDriftError`. That is how the
  "approved but the rate moved" outcome is tested without state. Place it on an
  over-cap, non-holdable BKC property.
- `createFixtureRateSources(opts?: { chaos?: ChaosConfig; now?: () => Date })`.

### `src/supply/ExpediaRapidRateSource.ts` (new)
```ts
export interface RapidConfig {
  apiKey: string; sharedSecret: string; baseUrl: string;       // https://test.ean.com (sandbox) | https://api.ean.com
  customerIp: string; posCountryCode: string; language: string; currency: Currency;
  salesChannel: string; salesEnvironment: string;
  propertyIdsForAnchor: (anchor: Anchor) => Promise<string[]>;
  fetch?: typeof fetch; now?: () => Date; timeoutMs?: number;
}
export function rapidAuthorizationHeader(apiKey: string, sharedSecret: string, unixSeconds: number): string
export function createExpediaRapidRateSource(cfg: RapidConfig): RateSource
```
**Ground every endpoint, parameter and response field in Expedia's official Rapid
documentation via WebFetch** (developers.expediagroup.com/rapid/…) before writing.
Wherever the docs are unreachable or ambiguous, write the code to the best
available shape and mark each such spot with `// UNVERIFIED:`, listing all of them
in your report. The signature is SHA-512 hex of `apiKey + sharedSecret +
unixSeconds`, sent as `Authorization: EAN APIKey=…,Signature=…,timestamp=…`.
`capabilities.live = true`.

Test against `tests/fixtures/rapid-mock.ts`, an in-process mock server that
implements exactly the shapes the adapter expects. **Never call a live Expedia
endpoint from tests.**

### `src/payments/StripeIssuingCardIssuer.ts` (new)
```ts
export function createStripeIssuingCardIssuer(cfg: { secretKey: string; cardholderId: string; baseUrl?: string; fetch?: typeof fetch }): CardIssuer
```
Ground it in Stripe's official Issuing API reference via WebFetch. Create a
virtual card with spending limits and allowed categories locked to lodging (verify
the exact category slug). **Never request, expand or log the card number or CVC.**
Cancelling a card is `void`. Mark unverified spots the same way. Test with a mock
`fetch`.

### `src/payments/SandboxCardIssuer.ts` (v2)
Honour `IssueCardRequest.validFrom`/`validUntil` and set `issuerId`,
`capabilities`. Still no PAN, not even a fake one.

### `src/notify/SlackWebhookNotifier.ts`, `src/notify/ConsoleEmailNotifier.ts` (new)
```ts
export function createSlackWebhookNotifier(cfg: { webhookUrl: string; fetch?: typeof fetch }): Notifier   // live: true
export function createConsoleEmailNotifier(cfg?: { log?: (line: string) => void }): Notifier             // live: false
```

### `src/intent/RuleIntentParser.ts`, `src/intent/ClaudeIntentParser.ts` (new)
```ts
export function createRuleIntentParser(): IntentParser                                   // wraps core parseIntent
export function createClaudeIntentParser(cfg: { client?: Anthropic; model?: string; timeoutMs?: number; fallback: IntentParser }): IntentParser
```
The Claude parser works like this:
- **Call** — `@anthropic-ai/sdk` with model `claude-opus-5` and
  `client.messages.parse` with `output_config: { format: zodOutputFormat(schema) }`
  (from `@anthropic-ai/sdk/helpers/zod`), `max_tokens` about 1024, and
  `output_config.effort: "low"`, because this is short, latency-sensitive extraction.
- **Prompt** — today's date and the traveller's time zone, so relative dates
  resolve.
- **After the call** — resolve the anchor with `ctx.resolveAnchor`, apply the same
  clarification rule as the rules parser, and return `parser: "claude"`.
- **Fallback** — on refusal (`stop_reason === "refusal"`), a null
  `parsed_output`, any `Anthropic.APIError`, or a timeout, return `fallback.parse(...)`.
- **Tests** — use an injected fake client only. Never call the real API.

---

## Stream C — persistence, server, cron, demo

### Persistence (`src/store/persistence/*.ts`) and store (`src/store/FileStore.ts`)
```ts
export function createMemoryPersistence(): DocPersistence
export function createFilePersistence(dir: string): DocPersistence
export function createBlobPersistence(cfg: { token: string; prefix: string }): DocPersistence
export function createStore(p: DocPersistence): Store
export function createMemoryStore(): Store                       // = createStore(createMemoryPersistence())
export function createFileStore(dir: string): Store              // = createStore(createFilePersistence(dir))
```
- Blob uses `@vercel/blob` with private access. Read with the cache bypassed so
  reads see writes. Create with `allowOverwrite: false`, which gives atomic create.
  Replace with `allowOverwrite: true` plus `ifMatch`, which gives CAS. Read the
  installed package's type definitions for exact option names; don't guess.
- Pathnames are `${prefix}/${collection}/${encodeURIComponent(id)}.json`.
- Streams are create-only documents under `${prefix}/_stream/${stream}/`.
- A single contract suite, `tests/api/persistence-contract.test.ts`, runs against
  memory and file, and against Blob when `SM_TEST_BLOB=1` and
  `BLOB_READ_WRITE_TOKEN` are set. Blob runs use a unique prefix and clean up
  after themselves. It must prove:
  - create-if-absent under 10 concurrent creators yields exactly one winner
  - CAS rejects a stale etag
  - reads see writes
  - `nextInvoiceSequence` under concurrency never duplicates or skips a number

### Server
```ts
export interface AppDeps {
  store: Store; sources: RateSource[]; routes: RouteSource; issuer: CardIssuer;
  notifiers: Notifier[]; intentParser: IntentParser;
  resolveAnchor: (query: string) => Anchor | null; knownAnchors: readonly Anchor[];
  now: () => Date; publicBaseUrl: string; demo: boolean;
}
export function createApp(deps: AppDeps): express.Express
export function buildDefaultDeps(opts?: { dir?: string; memory?: boolean }): AppDeps
export function seedDemo(deps: AppDeps): Promise<void>        // idempotent
```
`buildDefaultDeps` reads the environment:
- `SM_STORE=memory|file|blob` — default `blob` when `BLOB_READ_WRITE_TOKEN` and
  `VERCEL` are set, else `file`
- `SM_SUPPLY=fixture|rapid` — `rapid` requires `EAN_API_KEY` and `EAN_SHARED_SECRET`
  and otherwise refuses to boot
- `SM_ISSUER=sandbox|stripe`
- `SLACK_WEBHOOK_URL`
- `ANTHROPIC_API_KEY` — the Claude parser with rules fallback, else rules only
- `SM_DEMO`, `SM_PUBLIC_BASE_URL`, `CRON_SECRET`

On first boot seed the entity `acme`:
- ACME Travel Pvt Ltd, a checksum-valid Maharashtra GSTIN, settlement and
  reporting currency INR, invoice prefix `ACME`
- the policy v2: the Slice 1 caps plus Singapore SGD 450, Dubai AED 1,400, and
  **no** London cap in GBP. London gets only `{ cityTier: "global", city: "London",
  perNight: ₹45,000 }`, so the pinned conversion path is exercised.
- approval `{ mode: "hard", slaMinutes: 120, maxEscalations: 2, reasons:
  [client_site "Client or meeting is at this hotel", no_inventory "Nothing in
  policy near the meeting", late_change "Plans changed at short notice",
  safety "Safety or security", accessibility "Accessibility need"] }`
- advisories: Dubai caution
- monthly pins for the current month for USD, EUR, GBP, AED and SGD against INR

`seedDemo` (only when `SM_DEMO=1`) adds:
- the directory `asha@acme.test` (traveller, manager meera) →
  `meera@acme.test` (manager, manager vikram) → `vikram@acme.test` (VP), plus
  `admin@acme.test`
- one settled past stay for Asha, with its GST invoice
- one pending over-cap request from Asha to Meera

The core modules are:
- **`src/server/search.ts`** — signed, self-describing search ids with
  `get(id): Promise<SearchSession | undefined>` recomputing on a miss; stores
  `SearchRecord`s.
- **`src/server/bookings-service.ts`** — the request/confirm/withdraw/modify/cancel
  orchestration.
- **`src/server/approvals.ts`**, **`src/server/notify.ts`** (in-app record first,
  then best-effort channels, failures recorded).
- **`src/server/tokens.ts`** — one-tap action tokens, HMAC-signed with approval id,
  approver id, decision and expiry (72h), single-use via `consumeActionToken`.
- **`src/server/cron.ts`** — `export async function tick(deps: AppDeps, now: Date)`.
- **`src/server/letters.ts`** — the authorisation letter HTML.

Every route in `API_CONTRACT.md` Slice 2 is implemented exactly. Update
`src/vercel-entry.ts` to `buildDefaultDeps()` (no forced memory) and run `seedDemo`
when demo is on.

---

## Stream D — web

Implements the Slice 2 sections of `DESIGN.md` against the Slice 2 sections of
`API_CONTRACT.md`. New routes:
- `/approvals` — inbox
- `/a/:token` — one-tap decision
- `/trip/:bookingId/invoice` — printable invoice
- `/trip/:bookingId/modify` — modify flow

Extended screens: SignIn (demo personas), Search (chat entry), Results (the over
state and dual currency), Confirm (the justification and approval request path,
advisory flag), Trip (pending, SLA and escalation ladder, hold line, outcomes,
withdraw, invoice link, authorisation letter link, report card declined, modify),
Admin (tabs: Policy · Exceptions · In market · Directory · FX pins · Data rights ·
Metrics). The header shows an approvals count badge. `OfferCard` keeps its
approved `data-field` list; the verdict field may now render the `over` variant.
