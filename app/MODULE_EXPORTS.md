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
