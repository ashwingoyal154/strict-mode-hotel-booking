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
