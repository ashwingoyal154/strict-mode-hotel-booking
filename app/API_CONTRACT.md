# HTTP API contract — Slice 1

Frozen before implementation. Server and web are built against this; neither may
change it unilaterally. All bodies are JSON. All money is `{ minor, currency }`
with `minor` an integer. Dev server: API on `:8787`, web on `:5173` proxying `/api`.

Auth is a session cookie `sm_session`. Slice 1 ships a **dev SSO stub** standing in
for OIDC with JIT user creation; the seam is `src/server/auth.ts`.

## Conventions

Errors: `4xx/5xx` with `{ "error": { "code": string, "message": string, "detail"?: unknown } }`.
`code` is machine-readable and stable. `message` is shown to the traveller verbatim.

---

## Auth

### `POST /api/auth/login`
Dev stand-in for OIDC. Body `{ email: string, name?: string }`.
Creates the traveller on first sight (JIT). Sets `sm_session`. → `200 { traveller }`

### `POST /api/auth/logout` → `204`

### `GET /api/me` → `200 { traveller }` · `401 { error }`

---

## Search

### `POST /api/search`
Body:
```json
{ "anchorQuery": "Bandra Kurla Complex",
  "checkIn": "2026-06-11", "checkOut": "2026-06-15",
  "guests": 1, "rooms": 1 }
```
Resolves the anchor, starts a fan-out across all sources, returns immediately.
→ `202 { searchId, anchor, query, sources: [{ id, displayName }] }`
→ `400 anchor_not_found` when the anchor cannot be resolved.

### `GET /api/search/:searchId/events`  (Server-Sent Events)
Streaming is a designed UI state, not a spinner. Events:

| event | data |
|---|---|
| `source` | `{ sourceId, status: "pending"\|"answered"\|"failed", offerCount, durationMs }` |
| `results` | `{ results: RankedOffer[], answered, total }` — full re-ranked list each time |
| `done`   | `{ answered, total, failed, durationMs }` |

A failed source emits `source` with `status:"failed"` and the stream continues.
The page degrades (fewer results, a banner); it never errors.

### `GET /api/search/:searchId`
Settled snapshot, for tests, reloads and the confirm screen.
→ `200 { searchId, anchor, query, results: RankedOffer[], sources, blockedCount }`

`RankedOffer` is `src/core/types.ts#RankedOffer`. **Blocked offers are included**
but carry `verdict.state === "blocked"`; the UI hides them behind a disclosure.

---

## Bookings

### `POST /api/bookings`
Header **`Idempotency-Key: <uuid>`** is required.
Body:
```json
{ "searchId": "...", "offerId": "...", "costCentre": "ENG-OPS",
  "acceptedTotal": { "minor": 3480000, "currency": "INR" } }
```
`acceptedTotal` is the number the traveller was shown. The server re-prices with
the source and compares. This is how A3 is enforced: a mismatch can never be
absorbed silently.

→ `201 { booking }`
→ `200 { booking }` when the idempotency key has been seen (A14: exactly one booking)
→ `409 price_drift` with `detail: PriceDriftDetail` — client must re-confirm
→ `410 sold_out`
→ `403 blocked_by_policy` with `detail: { verdict }` — **also enforced here, not only in the UI (A6)**
→ `402 card_declined` with `detail: { declineCode }`
→ `503 source_unavailable`

### `GET /api/bookings` → `200 { bookings: Booking[] }` (caller's own, newest first)

### `GET /api/bookings/:id` → `200 { booking }` · `404` · `403` if not the caller's

### `POST /api/bookings/:id/cancel`
→ `200 { booking }` with `state:"cancelled"`
→ `409 outside_free_window` with `detail: { cancellationDeadline }`
Slice 1 only supports cancellation inside the free window (A7).

---

## Admin  (requires `traveller.isAdmin`)

### `GET /api/admin/policy` → `200 { policy }`
### `PUT /api/admin/policy`
Body: `Policy` minus `version`/`updatedAt`/`updatedBy`. Saving increments the
version and keeps the prior version readable (A12 replay).
→ `200 { policy }` · `400 invalid_policy`

### `GET /api/admin/bookings` → `200 { bookings }` (whole entity)
### `GET /api/admin/bookings.csv` → `200` `text/csv`
Columns: `confirmation_code,created_at,traveller_email,property,city,check_in,check_out,nights,commute_minutes,commute_mode,all_in_minor,currency,per_night_minor,cap_per_night_minor,policy_state,policy_reason,policy_version,cost_centre,state,card_last4`

### `GET /api/admin/source-log?limit=100` → `200 { entries: SourceLogEntry[] }`

---

## Ops

### `GET /api/health` → `200 { ok: true, sources: [{ id, ok }] }`
### `GET /api/version` → `200 { version, slice: 1, policyVersion }`

---
---

# Slice 2 — The Real World

Additive to everything above. Where Slice 2 changes a Slice 1 behaviour it says
so explicitly under **Changed**. Money is still `{ minor, currency }`; an FX rate
is `FxRate` from `src/core/types.ts`.

## Changed from Slice 1

- **Over-cap is bookable through approval.** `verdict.state` is now
  `"in" | "over" | "blocked"`. `over` offers are ranked and numbered alongside
  `in` offers. Only `blocked` offers sit behind the disclosure.
- **`POST /api/bookings` has three outcomes by verdict** — see below. An over-cap
  rate posted without a justification is `422 justification_required`, not 403.
- **`searchId` is self-describing and signed.** Any instance can serve any search:
  `GET /api/search/:id` recomputes on a cache miss. A tampered id is
  `404 search_not_found`; one older than 30 minutes is `410 search_expired`.
- `RankedOffer` gains `display: Conversion` (all-in total in the display currency).
- `GET /api/me` → `{ traveller, entity, approvalsPending: number, demo: boolean }`.
- `GET /api/version` → `{ version, slice: 2, policyVersion, evaluatorVersion, adapters: { store, supply, issuer, notifiers, intent } }`.
- `GET /api/health` sources now report `{ id, ok, live }`.
- `GET /api/admin/bookings.csv` appends columns:
  `supplier_minor,supplier_currency,settlement_minor,settlement_currency,fx_rate_micros,fx_pin_month,approval_state,approval_outcome,invoice_number`.

## Auth

### `GET /api/auth/demo-personas`
→ `200 { enabled: boolean, personas: [{ email, name, role, blurb }] }`
Enabled only when `SM_DEMO=1`. Lets a demo sign in as a traveller, their manager
and the admin without inventing accounts.

## Chat entry

### `POST /api/intent`
Body `{ text: string }` (1–500 chars). → `200 { intent: ParsedIntent, searchRequest: SearchRequest | null }`
`searchRequest` is `{ anchorQuery, checkIn, checkOut, guests, rooms }` when the
intent is complete and confident, else `null` and `intent.clarification` holds
**exactly one** question. **This endpoint never books and has no path to booking.**
The client posts `searchRequest` to `/api/search` itself.

## Search

### `POST /api/search`
Body adds optional `displayCurrency` (defaults to the traveller's, then the
entity reporting currency). Response adds `displayCurrency` and `fxPinMonth`.

## Bookings

### `POST /api/bookings`
Header `Idempotency-Key` required. Body:
```json
{ "searchId": "...", "offerId": "...", "costCentre": "ENG-OPS",
  "acceptedTotal": { "minor": 4238000, "currency": "INR" },
  "justification": { "code": "client_site", "text": "Client workshop is in this building" } }
```
`justification` is ignored for `in` offers and required for `over` offers.

| verdict | outcome |
|---|---|
| `in` | `201 { booking, approval: null }` — confirmed, card issued (Slice 1 behaviour) |
| `over`, no/invalid justification | `422 justification_required` · `detail: { verdict, reasons: JustificationReason[], message? }` |
| `over`, valid justification | `202 { booking, approval }` — `booking.state = "pending_approval"`, **no card issued**, hold attempted, approver notified |
| `blocked` | `403 blocked_by_policy` · `detail: { verdict }` |

Also: `409 no_approver` when no approver can be resolved; every Slice 1 error
(`409 price_drift`, `410 sold_out`, `402 card_declined`, `503 source_unavailable`,
`409 idempotency_key_conflict`) still applies. Idempotency now holds **across
instances**: the key is reserved atomically in the store before any supplier call.

### `GET /api/bookings/:id`
→ `200 { booking, approval: ApprovalView | null, invoice: Invoice | null }`

### `POST /api/bookings/:id/withdraw`
Traveller withdraws a pending request. Releases the hold.
→ `200 { booking, approval }` (`cancelled` / `withdrawn`) · `409 not_pending`

### `POST /api/bookings/:id/modify/quote`
Body `{ searchId, offerId }` → `200 { quote: ModifyQuote }`
`409 outside_free_window` · `409 not_confirmed` · `422 modify_over_cap` (Slice 2
modifies only to in-policy rates; an over-cap change is a new request).

### `POST /api/bookings/:id/modify`
Header `Idempotency-Key`. Body `{ searchId, offerId, acceptedNewTotal: Money }`.
Books the new stay **first**, then cancels the old one, so a traveller is never
left without a room.
→ `201 { booking: newBooking, replaced: oldBooking, warnings: string[] }`
The old booking becomes `modified` with `replacedBy`. If cancelling the old stay
fails after the new one is booked, both are kept and `warnings` says so plainly.
Same drift/sold-out/declined errors as booking.

### `GET /api/bookings/:id/invoice`
→ `200 { invoice }` · `404 invoice_not_ready` · `detail: { availableAfter: IsoDateTime, message }`

### `GET /api/bookings/:id/authorisation-letter`
→ `200 text/html` — the hotel-facing letter for the single-use card: guest name,
dates, card last4, authorised amount, incidentals buffer, "do not charge the guest".
`409 no_card` when nothing is issued yet.

### `POST /api/bookings/:id/card-declined`
Body `{ note?: string }`. The traveller reports the card was declined at the desk.
Records a `desk_declined` card event (S3 metric) and notifies admins.
→ `201 { cardEvent }`

## Approvals

`ApprovalView` = `ApprovalRequest` plus:
```ts
{ booking: Booking,
  traveller: { id, name, email },
  approvers: Array<{ id, name, email, level }>,   // the resolved chain
  sla: { level, approverId, approverName, dueAt, remainingMs, breached, atTop, nextApproverName: string | null } }
```
Every read materialises SLA escalations as of now, so a late reader sees the
same escalation history an on-time reader would have.

### `GET /api/approvals?scope=mine|entity&state=pending|approved|rejected|withdrawn`
`scope=mine` (default): requests where the caller is in the chain at or below
the current level. `scope=entity` requires admin. → `200 { approvals: ApprovalView[] }`

### `GET /api/approvals/:id` → `200 { approval: ApprovalView }` · `403` · `404`

### `POST /api/approvals/:id/decision`
Body `{ decision: "approve" | "reject", note?: string, actionToken?: string }`.
Authorised by a session whose traveller may decide, **or** a valid one-tap token.
Rejecting requires a note. Approving re-prices, then books against the hold if
one exists, issues the card and confirms. An approval can still lose the rate —
that is `outcome`, not an error:
→ `200 { approval: ApprovalView, booking }` with `approval.outcome` one of
`confirmed | rate_lost | sold_out | card_declined`.
`409 already_decided` · `403 not_current_approver` · `422 note_required` ·
`401 invalid_action_token` (expired, tampered or already used)

### `GET /api/approvals/action/:token`
Read-only preview for the one-tap link. No side effects on GET.
→ `200 { valid: true, decision: "approve" | "reject", approval: ApprovalView, approverName }`
→ `200 { valid: false, reason: string }`

## Notifications

### `GET /api/notifications` → `200 { notifications: NotificationRecord[], unread: number }`
### `POST /api/notifications/:id/read` → `200 { notification }`

## Me

### `GET /api/me/export` → `200 DataExport` (the caller's own data)

## Admin (requires `isAdmin`)

### `GET /api/admin/policy` · `PUT /api/admin/policy`
`Policy` now includes `reportingCurrency`, `approval`, `advisories`. Caps carry
their own currency.

### `GET /api/admin/entity` · `PUT /api/admin/entity` — `LegalEntity`
`400 invalid_gstin` when the GSTIN fails its checksum.

### `GET /api/admin/fx-pins?month=2026-09` → `200 { month, rates: FxRate[] }`
### `PUT /api/admin/fx-pins` body `{ month, rates: [{ base, quote, rateMicros }] }` → `200 { month, rates }`

### `GET /api/admin/directory` → `200 { travellers: Array<Traveller & { managerName: string | null }> }`
### `POST /api/admin/directory`
Body `{ entries: DirectoryEntry[] }` **or** `{ csv: "email,name,manager_email,cost_centre,is_admin\n..." }`
→ `200 { created, updated, unresolvedManagers: string[], cycles: string[] }`

### `GET /api/admin/approvals?state=` → `200 { approvals: ApprovalView[] }`
The exception list: every over-cap request with its justification, decision,
outcome and whether it breached SLA at the top of the chain.

### `GET /api/admin/in-market?date=YYYY-MM-DD` (default today in `Asia/Kolkata`)
→ `200 { date, travellers: InMarketTraveller[], byCountry: [{ countryCode, count, advisories }] }`

### `GET /api/admin/travellers/:id/export` → `200 DataExport`
### `POST /api/admin/travellers/:id/erase`
Body `{ confirmEmail }` — must equal the traveller's current email.
→ `200 ErasureReceipt` · `422 confirmation_mismatch` · `409 already_erased`

### `GET /api/admin/metrics`
→ `200 { bookings, confirmed, inPolicyRate, approvals: { total, pending, withinSlaRate, rateLostRate }, cards: { issued, issueDeclined, deskDeclined, declineRate }, invoices }`

## Cron

### `GET|POST /api/cron/tick`
`Authorization: Bearer ${CRON_SECRET}` (or an admin session in demo mode).
Materialises SLA escalations and sends their notifications, settles stays whose
checkout has passed, issues invoices for them, and purges search history older
than 30 days. Idempotent: running it twice changes nothing the second time.
→ `200 { escalated, settled, invoiced, purgedSearches }`

The same tick also runs opportunistically inside requests, at most once every 30
seconds per instance, because Vercel Hobby cron fires only daily and an SLA
measured in minutes cannot wait for it.
