/**
 * Booking orchestration — request, confirm, approve, withdraw, cancel, modify.
 *
 * The money path runs in one order and only one:
 *
 *   reserve the idempotency key (atomic, in the store)
 *   → price-check with the source (its answer is authoritative)
 *   → policy v2 with this month's pins
 *   → blocked: 403 · over without a valid reason: 422 · over with no approver: 409
 *   → drift against the number the traveller accepted (never absorbed)
 *   → in:   issue the card → book → confirm
 *   → over: attempt a hold → pending_approval → open the approval → notify
 *
 * No card is issued while a request is pending. Every failure that leaves nothing
 * behind releases the key so the traveller can retry on it; a success completes
 * the key the instant the booking is persisted, so no later failure can release a
 * key whose booking exists.
 */

import { z } from "zod";

import {
  AlreadyDecidedError,
  canDecide,
  decide,
  NotCurrentApproverError,
  openApproval,
  recordOutcome,
  RejectionNoteRequiredError,
  resolveApproverChain,
  validateJustification,
  withdraw,
} from "../core/approval.ts";
import { assertTransition, canWithdraw, isCancellableAt } from "../core/booking.ts";
import { formatDateRange, formatDeadline } from "../core/format.ts";
import { convertVia, pinMonthOf } from "../core/fx.ts";
import { isValidIdempotencyKey, newConfirmationCode, newId, stableHash } from "../core/ids.ts";
import { canModify, quoteModify } from "../core/modify.ts";
import { formatMoney, money } from "../core/money.ts";
import { evaluate } from "../core/policy.ts";
import { driftBetween } from "../core/pricing.ts";
import type {
  ApprovalOutcome,
  ApprovalRequest,
  Booking,
  BookingAmounts,
  CardEvent,
  CardEventKind,
  Conversion,
  Currency,
  FxRate,
  HoldStatus,
  IssuedCard,
  Money,
  Offer,
  Policy,
  PriceDriftDetail,
  SearchQuery,
  Traveller,
} from "../core/types.ts";
import { CardDeclinedError } from "../payments/CardIssuer.ts";
import {
  SupplierHoldExpiredError,
  SupplierPriceDriftError,
  SupplierSoldOutError,
  type RateSource,
  type SupplierBooking,
} from "../supply/RateSource.ts";
import {
  buildApprovalView,
  notifyApprovalRequested,
  readApprovalView,
  refreshApproval,
} from "./approvals.ts";
import { withCorrelationId } from "./audit.ts";
import { notify, notifyAdmins } from "./notify.ts";
import { errorResult, ok, type HttpResult, type ServerContext } from "./routes/http.ts";
import { checkoutInstant, addDays, errorMessage, sleep } from "./time.ts";
import { verifyActionToken, type ActionTokenClaims } from "./tokens.ts";

export const NOT_HELD_MESSAGE = "Not held · this hotel can't hold rates, so the price may move before approval";
const HOLD_FAILED_MESSAGE = "Not held · we couldn't hold this rate, so the price may move before approval";
const HOLD_RELEASED_MESSAGE = "Hold released · nothing is being kept for this request";

const IN_FLIGHT_WAIT_MS = 15_000;
const STALE_RESERVATION_MS = 5 * 60_000;

// ---------- bodies ----------

export const moneySchema = z.object({
  minor: z.number().int("money is integer minor units, never a float"),
  currency: z.string().trim().length(3),
});

export const createBookingBody = z.object({
  searchId: z.string().trim().min(1),
  offerId: z.string().trim().min(1),
  costCentre: z.string().trim().min(1).max(64).optional(),
  acceptedTotal: moneySchema,
  justification: z
    .object({ code: z.string().trim().max(64), text: z.string().max(1000) })
    .nullable()
    .optional(),
});
export type CreateBookingBody = z.infer<typeof createBookingBody>;

export const modifyQuoteBody = z.object({
  searchId: z.string().trim().min(1),
  offerId: z.string().trim().min(1),
});

export const modifyBody = modifyQuoteBody.extend({ acceptedNewTotal: moneySchema });

// ---------- small helpers ----------

function freeze<T>(value: T): T {
  // A snapshot that aliases live supply is not a snapshot, and A12 replay would drift with it.
  return structuredClone(value);
}

export function sourceFor(ctx: ServerContext, sourceId: string): RateSource | undefined {
  return ctx.sources.find((s) => s.id === sourceId);
}

/** Bookings do not store party size; Slice 2 searches default to one guest in one room. */
export function queryFromBooking(b: Booking): SearchQuery {
  return { anchor: b.anchor, checkIn: b.offer.rate.checkIn, checkOut: b.offer.rate.checkOut, guests: 1, rooms: 1 };
}

export function safeConvert(amount: Money, to: Currency, pins: readonly FxRate[]): Conversion {
  try {
    return convertVia(amount, to, pins);
  } catch {
    // No pin: record that no conversion happened rather than invent a rate.
    return { from: amount, to: amount, fx: null };
  }
}

function buildAmounts(
  supplier: Money,
  displayCurrency: Currency,
  settlementCurrency: Currency,
  pins: readonly FxRate[],
): BookingAmounts {
  return {
    supplier,
    display: safeConvert(supplier, displayCurrency, pins),
    settlement: safeConvert(supplier, settlementCurrency, pins),
  };
}

/** The policy buffer is authored in the reporting currency; the card is authorised in the supplier's. */
function bufferMinorFor(policy: Policy, currency: Currency, pins: readonly FxRate[]): number {
  const authored = policy.reportingCurrency ?? currency;
  if (authored === currency) return policy.incidentalsBufferMinor;
  try {
    return convertVia(money(policy.incidentalsBufferMinor, authored), currency, pins).to.minor;
  } catch {
    return 0;
  }
}

function holdTime(heldUntil: string, timeZone: string | undefined): string {
  try {
    return formatDeadline(heldUntil, timeZone ?? "Asia/Kolkata").split(",")[0] ?? heldUntil;
  } catch {
    return heldUntil;
  }
}

export function readIdempotencyKey(raw: string | undefined): { key: string } | HttpResult {
  if (raw === undefined || raw.trim() === "") {
    return errorResult(
      400,
      "idempotency_key_required",
      "Idempotency-Key header is required so a double submit cannot create two bookings.",
    );
  }
  const key = raw.trim();
  if (!isValidIdempotencyKey(key)) {
    return errorResult(400, "invalid_idempotency_key", "Idempotency-Key must be 8 to 200 printable characters.");
  }
  return { key };
}

async function recordCardEvent(
  ctx: ServerContext,
  booking: Booking,
  kind: CardEventKind,
  declineCode: string | null,
  note: string | null,
): Promise<CardEvent> {
  const event: CardEvent = {
    id: newId("cev"),
    bookingId: booking.id,
    entityId: booking.entityId,
    at: ctx.now().toISOString(),
    kind,
    declineCode,
    note,
  };
  await ctx.store.appendCardEvent(event);
  return event;
}

async function recordCardEventQuietly(
  ctx: ServerContext,
  booking: Booking,
  kind: CardEventKind,
  declineCode: string | null,
): Promise<void> {
  try {
    await recordCardEvent(ctx, booking, kind, declineCode, null);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`card event ${kind} for ${booking.id} not recorded: ${errorMessage(err)}`);
  }
}

async function voidCard(ctx: ServerContext, booking: Booking, tokenRef: string): Promise<void> {
  try {
    await ctx.issuer.void(tokenRef);
  } catch {
    // Logged by audit.ts. A failed void must not mask the failure the traveller needs to
    // see; reconciliation owns the orphan.
  }
  await recordCardEventQuietly(ctx, booking, "voided", null);
}

// ---------- idempotency ----------

async function withIdempotency(
  ctx: ServerContext,
  args: { key: string; travellerId: string; requestHash: string },
  run: (markPersisted: (bookingId: string) => Promise<void>) => Promise<HttpResult>,
  replay: (bookingId: string) => Promise<HttpResult>,
): Promise<HttpResult> {
  const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
  for (;;) {
    const r = await ctx.store.reserveIdempotencyKey({
      key: args.key,
      travellerId: args.travellerId,
      requestHash: args.requestHash,
      createdAt: ctx.now().toISOString(),
    });
    if (r.reserved) break;
    const existing = r.existing;
    if (existing.travellerId !== args.travellerId || existing.requestHash !== args.requestHash) {
      return errorResult(
        409,
        "idempotency_key_conflict",
        "That idempotency key was already used for a different request.",
      );
    }
    if (existing.state === "completed" && existing.bookingId !== null) return replay(existing.bookingId);
    // A reservation whose instance died mid-request would otherwise block the key forever.
    if (ctx.now().getTime() - Date.parse(existing.createdAt) > STALE_RESERVATION_MS) {
      await ctx.store.releaseIdempotencyKey(args.key);
      continue;
    }
    if (Date.now() > deadline) {
      return errorResult(
        409,
        "idempotency_key_conflict",
        "This request is still being processed. Try again in a moment.",
        { state: "in_flight" },
      );
    }
    // Same key, same body, in flight on this or another instance: wait for its answer.
    await sleep(40);
  }

  let persisted = false;
  const markPersisted = async (bookingId: string): Promise<void> => {
    await ctx.store.completeIdempotencyKey(args.key, bookingId);
    persisted = true;
  };
  try {
    return await run(markPersisted);
  } finally {
    if (!persisted) await ctx.store.releaseIdempotencyKey(args.key).catch(() => undefined);
  }
}

// ---------- issue + book, shared by confirm, approve and modify ----------

type BookAttempt =
  | { readonly kind: "booked"; readonly card: IssuedCard; readonly supplier: SupplierBooking }
  | { readonly kind: "declined"; readonly declineCode: string }
  | { readonly kind: "drift"; readonly detail: PriceDriftDetail }
  | { readonly kind: "sold_out" }
  | { readonly kind: "unavailable" };

async function issueAndBook(
  ctx: ServerContext,
  args: {
    booking: Booking;
    offer: Offer;
    query: SearchQuery;
    traveller: Traveller;
    policy: Policy;
    pins: readonly FxRate[];
    holdRef: string | null;
    source: RateSource;
  },
): Promise<BookAttempt> {
  const { booking, offer, query, traveller, policy, pins, source } = args;
  const total = offer.rate.allInTotal;

  let card: IssuedCard;
  try {
    card = await ctx.issuer.issue({
      exactTotal: total,
      incidentalsBufferMinor: bufferMinorFor(policy, total.currency, pins),
      entityId: booking.entityId,
      reference: booking.id,
      correlationId: booking.id,
      travellerName: traveller.name,
      validFrom: addDays(offer.rate.checkIn, -1),
      validUntil: addDays(offer.rate.checkOut, 1),
      merchantCategory: "lodging",
    });
  } catch (err) {
    if (err instanceof CardDeclinedError) {
      await recordCardEventQuietly(ctx, booking, "issue_declined", err.declineCode);
      return { kind: "declined", declineCode: err.declineCode };
    }
    return { kind: "unavailable" };
  }
  await recordCardEventQuietly(ctx, booking, "issued", null);

  const bookWith = (holdRef: string | null): Promise<SupplierBooking> =>
    source.book({
      offerId: offer.rate.id,
      query,
      travellerName: traveller.name,
      travellerEmail: traveller.email,
      authorisedTotal: total,
      cardTokenRef: card.tokenRef,
      correlationId: booking.id,
      holdRef,
    });

  let supplier: SupplierBooking;
  try {
    try {
      supplier = await bookWith(args.holdRef);
    } catch (err) {
      // An expired hold is not a lost room: book fresh on the same card. The
      // confirmed-total check below still refuses any price but the authorised one.
      if (err instanceof SupplierHoldExpiredError && args.holdRef !== null) supplier = await bookWith(null);
      else throw err;
    }
  } catch (err) {
    await voidCard(ctx, booking, card.tokenRef);
    if (err instanceof SupplierPriceDriftError) {
      const detail: PriceDriftDetail = driftBetween(total, err.currentTotal) ?? {
        kind: "price_drift",
        acceptedTotal: total,
        currentTotal: err.currentTotal,
        deltaMinor: 0,
        message: "The price changed while we were booking.",
      };
      return { kind: "drift", detail };
    }
    if (err instanceof SupplierSoldOutError) return { kind: "sold_out" };
    return { kind: "unavailable" };
  }

  const confirmedDrift = driftBetween(total, supplier.confirmedTotal);
  if (confirmedDrift !== null) {
    // The source confirmed a different number than it was authorised for. That is
    // drift; it surfaces, and the stay it created is undone.
    try {
      await source.cancel(supplier.supplierBookingRef);
    } catch {
      // Logged; reconciliation owns it.
    }
    await voidCard(ctx, booking, card.tokenRef);
    return { kind: "drift", detail: confirmedDrift };
  }
  return { kind: "booked", card, supplier };
}

function attemptFailure(attempt: Exclude<BookAttempt, { kind: "booked" }>): HttpResult {
  switch (attempt.kind) {
    case "declined":
      return errorResult(402, "card_declined", "The company card was declined, so nothing was booked.", {
        declineCode: attempt.declineCode,
      });
    case "drift":
      return errorResult(409, "price_drift", attempt.detail.message, attempt.detail);
    case "sold_out":
      return errorResult(410, "sold_out", "That room sold out as we were booking it.");
    case "unavailable":
      return errorResult(503, "source_unavailable", "The hotel's system did not respond. Nothing was charged.");
  }
}

// ---------- holds ----------

async function attemptHold(
  ctx: ServerContext,
  source: RateSource,
  offer: Offer,
  query: SearchQuery,
  policy: Policy,
  bookingId: string,
): Promise<{ status: HoldStatus } | { drift: PriceDriftDetail }> {
  const notHeld = (message: string): { status: HoldStatus } => ({
    status: { held: false, supplierHoldRef: null, heldUntil: null, message },
  });
  if (!source.capabilities.holds || !offer.rate.holdable) return notHeld(NOT_HELD_MESSAGE);
  const wanted = policy.approval.slaMinutes * (policy.approval.maxEscalations + 1);
  const minutes = Math.min(wanted, source.capabilities.maxHoldMinutes);
  if (minutes <= 0) return notHeld(NOT_HELD_MESSAGE);

  let hold;
  try {
    hold = await source.hold({
      offerId: offer.rate.id,
      query,
      expectedTotal: offer.rate.allInTotal,
      minutes,
      correlationId: bookingId,
    });
  } catch {
    return notHeld(HOLD_FAILED_MESSAGE);
  }

  const drift = driftBetween(offer.rate.allInTotal, hold.heldTotal);
  if (drift !== null) {
    try {
      await source.releaseHold(hold.holdRef);
    } catch {
      // Logged.
    }
    return { drift };
  }
  return {
    status: {
      held: true,
      supplierHoldRef: hold.holdRef,
      heldUntil: hold.heldUntil,
      message: `Held until ${holdTime(hold.heldUntil, offer.property.timeZone)} · the price above is guaranteed until then`,
    },
  };
}

/** Releases a live hold, best effort. Returns the hold status to store, or null when there was none. */
async function releaseHold(ctx: ServerContext, booking: Booking): Promise<HoldStatus | null> {
  const hold = booking.hold;
  if (hold === null || !hold.held || hold.supplierHoldRef === null) return null;
  const source = sourceFor(ctx, booking.offer.rate.sourceId);
  if (source !== undefined) {
    try {
      await withCorrelationId(booking.id, () => source.releaseHold(hold.supplierHoldRef as string));
    } catch {
      // Logged. The hold lapses at heldUntil regardless.
    }
  }
  return { held: false, supplierHoldRef: hold.supplierHoldRef, heldUntil: null, message: HOLD_RELEASED_MESSAGE };
}

// ---------- POST /api/bookings ----------

export async function requestBooking(
  ctx: ServerContext,
  traveller: Traveller,
  key: string,
  body: CreateBookingBody,
): Promise<HttpResult> {
  const requestHash = stableHash({
    op: "book",
    searchId: body.searchId,
    offerId: body.offerId,
    costCentre: body.costCentre ?? null,
    acceptedTotal: { minor: body.acceptedTotal.minor, currency: body.acceptedTotal.currency },
    justification: body.justification ?? null,
  });
  return withIdempotency(
    ctx,
    { key, travellerId: traveller.id, requestHash },
    (mark) => attemptBooking(ctx, traveller, key, body, mark),
    (bookingId) => replayBooking(ctx, traveller, bookingId),
  );
}

async function replayBooking(ctx: ServerContext, traveller: Traveller, bookingId: string): Promise<HttpResult> {
  const booking = await ctx.store.getBooking(bookingId);
  if (booking === null) return errorResult(404, "not_found", "That trip does not exist.");
  if (booking.travellerId !== traveller.id) {
    return errorResult(409, "idempotency_key_conflict", "That idempotency key belongs to another traveller.");
  }
  const approval = await approvalViewFor(ctx, booking);
  return ok(200, { booking, approval });
}

export async function approvalViewFor(ctx: ServerContext, booking: Booking) {
  if (booking.approvalId === null) return null;
  const approval = await ctx.store.getApproval(booking.approvalId);
  return approval === null ? null : readApprovalView(ctx, approval);
}

async function attemptBooking(
  ctx: ServerContext,
  traveller: Traveller,
  key: string,
  body: CreateBookingBody,
  markPersisted: (bookingId: string) => Promise<void>,
): Promise<HttpResult> {
  const lookup = await ctx.searches.resolve(body.searchId, traveller.id);
  if (!lookup.ok) return errorResult(lookup.status, lookup.code, lookup.message);
  const session = lookup.session;
  await session.settled();
  const ranked = session.find(body.offerId);
  if (ranked === undefined) return errorResult(404, "offer_not_found", "That room is no longer part of this search.");

  const [policy, entity] = await Promise.all([
    ctx.policyFor(traveller.entityId),
    ctx.entityFor(traveller.entityId),
  ]);
  const costCentre = body.costCentre ?? traveller.defaultCostCentre ?? policy.defaultCostCentre;
  if (!policy.costCentres.includes(costCentre)) {
    return errorResult(400, "invalid_cost_centre", `"${costCentre}" is not a cost centre on your policy.`, {
      costCentres: policy.costCentres,
    });
  }

  const source = sourceFor(ctx, ranked.offer.rate.sourceId);
  if (source === undefined) return errorResult(503, "source_unavailable", "We cannot reach the hotel's system right now.");

  const bookingId = newId("bkg");
  return withCorrelationId(bookingId, async (): Promise<HttpResult> => {
    // --- re-price. The source's answer is authoritative, never the cached rate.
    let fresh: Offer | null;
    try {
      fresh = await source.priceCheck(body.offerId, session.query);
    } catch {
      return errorResult(503, "source_unavailable", "We could not confirm this rate. Try again in a moment.");
    }
    if (fresh === null) return errorResult(410, "sold_out", "That room has just sold out. Here are the next best options.");

    // --- policy v2, server-side (A6), against this month's pins.
    const now = ctx.now();
    const pinMonth = pinMonthOf(now);
    const pins = await ctx.store.getFxPins(pinMonth);
    const verdict = evaluate({ rate: fresh.rate, property: fresh.property, policy, fxPins: pins, pinMonth });
    if (verdict.state === "blocked") return errorResult(403, "blocked_by_policy", verdict.reason, { verdict });

    let chain: string[] = [];
    let justification: { code: string; text: string } | null = null;
    if (verdict.state === "over") {
      const reasons = policy.approval.justificationReasons;
      const given = body.justification ?? null;
      if (given === null) {
        return errorResult(
          422,
          "justification_required",
          "This rate is over your cap, so it needs a reason before it goes to your approver.",
          { verdict, reasons },
        );
      }
      const valid = validateJustification(policy, given);
      if (!valid.ok) {
        return errorResult(422, "justification_required", valid.message, { verdict, reasons, message: valid.message });
      }
      const directory = await ctx.store.listTravellers(traveller.entityId);
      chain = resolveApproverChain({ traveller, directory, policy });
      if (chain.length === 0) {
        return errorResult(
          409,
          "no_approver",
          "Nobody can approve this request yet. Ask your travel admin to add your manager to the directory.",
        );
      }
      justification = { code: given.code, text: given.text.trim() };
    }

    // --- price parity (A3). Drift is never absorbed.
    const drift = driftBetween(body.acceptedTotal, fresh.rate.allInTotal);
    if (drift !== null) return errorResult(409, "price_drift", drift.message, drift);

    const base: Booking = {
      id: bookingId,
      confirmationCode: newConfirmationCode(),
      travellerId: traveller.id,
      entityId: traveller.entityId,
      state: "searched",
      offer: freeze(fresh),
      commute: freeze(ranked.commute),
      verdict: freeze(verdict),
      anchor: freeze(session.query.anchor),
      costCentre,
      card: null,
      cancellationDeadline: fresh.rate.refundableUntil,
      createdAt: now.toISOString(),
      cancelledAt: null,
      idempotencyKey: key,
      supplierBookingRef: null,
      amounts: buildAmounts(fresh.rate.allInTotal, session.displayCurrency, entity.settlementCurrency, pins),
      approvalId: null,
      hold: null,
      confirmedAt: null,
      checkInTime: null,
      cancellationReason: null,
      replaces: null,
      replacedBy: null,
      settledAt: null,
      invoiceId: null,
    };

    if (verdict.state === "in") {
      const attempt = await issueAndBook(ctx, {
        booking: base,
        offer: fresh,
        query: session.query,
        traveller,
        policy,
        pins,
        holdRef: null,
        source,
      });
      if (attempt.kind !== "booked") return attemptFailure(attempt);
      assertTransition("searched", "confirmed");
      const booking: Booking = {
        ...base,
        state: "confirmed",
        card: attempt.card,
        supplierBookingRef: attempt.supplier.supplierBookingRef,
        cancellationDeadline: attempt.supplier.cancellationDeadline,
        checkInTime: attempt.supplier.checkInTime,
        confirmedAt: ctx.now().toISOString(),
      };
      await ctx.store.putBooking(booking);
      await markPersisted(booking.id);
      return ok(201, { booking, approval: null });
    }

    // --- over cap, justified: hold where possible, never issue a card.
    const hold = await attemptHold(ctx, source, fresh, session.query, policy, bookingId);
    if ("drift" in hold) return errorResult(409, "price_drift", hold.drift.message, hold.drift);

    assertTransition("searched", "pending_approval");
    const approvalId = newId("apr");
    const booking: Booking = { ...base, state: "pending_approval", approvalId, hold: hold.status };
    const approval = openApproval({
      id: approvalId,
      booking,
      justification: justification as { code: string; text: string },
      chain,
      policy,
      now: ctx.now(),
    });
    await ctx.store.putApproval(approval);
    await ctx.store.putBooking(booking);
    await markPersisted(booking.id);
    await notifyApprovalRequested(ctx, approval, booking, traveller);
    return ok(202, { booking, approval: await buildApprovalView(ctx, approval) });
  });
}

// ---------- POST /api/approvals/:id/decision ----------

export async function decideApproval(
  ctx: ServerContext,
  args: {
    approvalId: string;
    decision: "approve" | "reject";
    note: string | null;
    actionToken: string | undefined;
    sessionTraveller: Traveller | undefined;
  },
): Promise<HttpResult> {
  const now = ctx.now();
  let claims: ActionTokenClaims | null = null;
  let approverId: string;
  if (args.actionToken !== undefined) {
    const verified = verifyActionToken(args.actionToken, now);
    if (!verified.ok) return errorResult(401, "invalid_action_token", verified.reason);
    if (verified.claims.approvalId !== args.approvalId || verified.claims.decision !== args.decision) {
      return errorResult(401, "invalid_action_token", "This link is for a different decision.");
    }
    claims = verified.claims;
    approverId = claims.approverId;
  } else if (args.sessionTraveller !== undefined) {
    approverId = args.sessionTraveller.id;
  } else {
    return errorResult(401, "unauthenticated", "Sign in to continue.");
  }

  const stored = await ctx.store.getApproval(args.approvalId);
  if (stored === null) return errorResult(404, "not_found", "That approval request does not exist.");
  const approver = await ctx.store.getTraveller(approverId);
  if (approver === null || approver.erasedAt !== null) {
    return claims !== null
      ? errorResult(401, "invalid_action_token", "This link is not valid.")
      : errorResult(403, "not_current_approver", "You are not an approver on this request.");
  }

  const { approval } = await refreshApproval(ctx, stored);
  if (args.decision === "reject" && args.note === null) {
    return errorResult(422, "note_required", "Add a note so the traveller knows why it was rejected.");
  }

  if (claims !== null) {
    const first = await ctx.store.consumeActionToken({
      tokenId: claims.tokenId,
      approvalId: claims.approvalId,
      consumedAt: now.toISOString(),
    });
    if (!first) return errorResult(401, "invalid_action_token", "This link has already been used.");
  }

  if (approval.state !== "pending") {
    return errorResult(409, "already_decided", `This request has already been ${approval.state}.`);
  }
  if (!canDecide(approval, approverId)) {
    return errorResult(403, "not_current_approver", "You are not an approver at this request's current level.");
  }

  let decided: ApprovalRequest;
  try {
    decided = await ctx.store.mutateApproval(args.approvalId, (current) =>
      decide(current, { approverId, decision: args.decision, note: args.note, now }),
    );
  } catch (err) {
    if (err instanceof AlreadyDecidedError) {
      return errorResult(409, "already_decided", "This request was decided a moment ago.");
    }
    if (err instanceof NotCurrentApproverError) {
      return errorResult(403, "not_current_approver", "You are not an approver at this request's current level.");
    }
    if (err instanceof RejectionNoteRequiredError) {
      return errorResult(422, "note_required", "Add a note so the traveller knows why it was rejected.");
    }
    throw err;
  }

  const booking = await ctx.store.getBooking(decided.bookingId);
  if (booking === null) throw new Error(`approval ${decided.id} points at missing booking ${decided.bookingId}`);
  return args.decision === "reject"
    ? rejectBooking(ctx, decided, booking, approver)
    : completeApproval(ctx, decided, booking, approver);
}

async function rejectBooking(
  ctx: ServerContext,
  approval: ApprovalRequest,
  booking: Booking,
  approver: Traveller,
): Promise<HttpResult> {
  const hold = await releaseHold(ctx, booking);
  const updated = await ctx.store.mutateBooking(booking.id, (cur) =>
    cur.state === "pending_approval" ? { ...cur, state: "rejected", hold: hold ?? cur.hold } : cur,
  );
  const traveller = await ctx.store.getTraveller(booking.travellerId);
  if (traveller !== null) {
    await withCorrelationId(booking.id, () =>
      notify(ctx, {
        recipient: traveller,
        kind: "approval_decided",
        subject: `${approver.name} rejected your request · ${booking.offer.property.name}`,
        body: `"${approval.decisionNote ?? ""}"\nNothing was booked. Search again for a rate within your policy.`,
        actionUrl: `${ctx.publicBaseUrl.replace(/\/+$/, "")}/trip/${booking.id}`,
        approvalId: approval.id,
        bookingId: booking.id,
      }),
    );
  }
  return ok(200, { approval: await buildApprovalView(ctx, approval), booking: updated });
}

/**
 * The approval won; now race the rate. Re-price, then book against the hold if one
 * is still live, else book fresh. Drift, sell-out and a declined card are outcomes,
 * not errors. A transport failure is neither: the decision is rolled back to
 * pending so it can be retried, because no outcome is true yet.
 */
async function completeApproval(
  ctx: ServerContext,
  approval: ApprovalRequest,
  booking: Booking,
  approver: Traveller,
): Promise<HttpResult> {
  const rollback = async (message: string): Promise<HttpResult> => {
    await ctx.store.mutateApproval(approval.id, (cur) =>
      cur.state === "approved" && cur.outcome === null && cur.decidedBy === approver.id
        ? { ...cur, state: "pending", decidedAt: null, decidedBy: null, decisionNote: null }
        : cur,
    );
    return errorResult(503, "source_unavailable", message);
  };

  const traveller = await ctx.store.getTraveller(booking.travellerId);
  const source = sourceFor(ctx, booking.offer.rate.sourceId);
  if (traveller === null || source === undefined) {
    return rollback("We cannot reach the hotel's system right now. Try approving again in a moment.");
  }
  const [policy, entity] = await Promise.all([ctx.policyFor(booking.entityId), ctx.entityFor(booking.entityId)]);

  return withCorrelationId(booking.id, async (): Promise<HttpResult> => {
    const now = ctx.now();
    const query = queryFromBooking(booking);
    const hold = booking.hold;
    const holdRef =
      hold !== null &&
      hold.held &&
      hold.supplierHoldRef !== null &&
      hold.heldUntil !== null &&
      Date.parse(hold.heldUntil) > now.getTime()
        ? hold.supplierHoldRef
        : null;
    const accepted = booking.offer.rate.allInTotal;

    let fresh: Offer | null = null;
    try {
      fresh = await source.priceCheck(booking.offer.rate.id, query);
    } catch {
      if (holdRef === null) return rollback("We couldn't reach the hotel to re-check the rate. Try again in a moment.");
    }
    if (holdRef === null) {
      if (fresh === null) return settleLost(ctx, { approval, booking, traveller, approver, outcome: "sold_out" });
      if (driftBetween(accepted, fresh.rate.allInTotal) !== null) {
        return settleLost(ctx, {
          approval,
          booking,
          traveller,
          approver,
          outcome: "rate_lost",
          current: fresh.rate.allInTotal,
        });
      }
    }

    const pins = await ctx.store.getFxPins(pinMonthOf(now));
    const attempt = await issueAndBook(ctx, {
      booking,
      offer: booking.offer,
      query,
      traveller,
      policy,
      pins,
      holdRef,
      source,
    });

    switch (attempt.kind) {
      case "unavailable":
        return rollback("The hotel's system did not respond. Nothing was charged — try approving again.");
      case "declined":
        return settleLost(ctx, {
          approval,
          booking,
          traveller,
          approver,
          outcome: "card_declined",
          declineCode: attempt.declineCode,
        });
      case "sold_out":
        return settleLost(ctx, { approval, booking, traveller, approver, outcome: "sold_out" });
      case "drift":
        return settleLost(ctx, {
          approval,
          booking,
          traveller,
          approver,
          outcome: "rate_lost",
          current: attempt.detail.currentTotal,
        });
      case "booked":
        break;
    }

    const confirmedAt = ctx.now().toISOString();
    const updated = await ctx.store.mutateBooking(booking.id, (cur) => {
      if (cur.state !== "pending_approval") return cur;
      assertTransition(cur.state, "confirmed");
      return {
        ...cur,
        state: "confirmed",
        card: attempt.card,
        supplierBookingRef: attempt.supplier.supplierBookingRef,
        cancellationDeadline: attempt.supplier.cancellationDeadline,
        checkInTime: attempt.supplier.checkInTime,
        confirmedAt,
        // Settlement is frozen at confirmation, with the pin in force when it happened.
        amounts: { ...cur.amounts, settlement: safeConvert(cur.amounts.supplier, entity.settlementCurrency, pins) },
      };
    });
    const recorded = await ctx.store.mutateApproval(approval.id, (cur) => recordOutcome(cur, "confirmed"));

    await notify(ctx, {
      recipient: traveller,
      kind: "booking_confirmed",
      subject: `Approved — you're booked at ${booking.offer.property.name}`,
      body: `${approver.name} approved your request. ${formatMoney(accepted)} is booked at ${booking.offer.property.name}, ${formatDateRange(booking.offer.rate.checkIn, booking.offer.rate.checkOut)}. Confirmation ${booking.confirmationCode}. The company card ends ${attempt.card.last4}.`,
      actionUrl: `${ctx.publicBaseUrl.replace(/\/+$/, "")}/trip/${booking.id}`,
      approvalId: approval.id,
      bookingId: booking.id,
    });

    return ok(200, { approval: await buildApprovalView(ctx, recorded), booking: updated });
  });
}

async function settleLost(
  ctx: ServerContext,
  args: {
    approval: ApprovalRequest;
    booking: Booking;
    traveller: Traveller;
    approver: Traveller;
    outcome: Exclude<ApprovalOutcome, "confirmed">;
    current?: Money;
    declineCode?: string;
  },
): Promise<HttpResult> {
  const { approval, booking, traveller, approver, outcome } = args;
  const hold = await releaseHold(ctx, booking);
  const at = ctx.now().toISOString();
  const updated = await ctx.store.mutateBooking(booking.id, (cur) =>
    cur.state === "pending_approval"
      ? { ...cur, state: "cancelled", cancelledAt: at, cancellationReason: outcome, hold: hold ?? cur.hold }
      : cur,
  );
  const recorded = await ctx.store.mutateApproval(approval.id, (cur) => recordOutcome(cur, outcome));

  const accepted = booking.offer.rate.allInTotal;
  const property = booking.offer.property.name;
  let message: string;
  if (outcome === "rate_lost") {
    const current = args.current ?? accepted;
    message = `Approved — but the rate moved from ${formatMoney(accepted)} to ${formatMoney(current)}. Nothing was booked.`;
  } else if (outcome === "sold_out") {
    message = `Approved — but ${property} sold out before we could book it. Nothing was booked.`;
  } else {
    const code = args.declineCode === undefined ? "" : ` (${args.declineCode})`;
    message = `Approved — but the company card for ${formatMoney(accepted)} was declined${code}. Nothing was booked.`;
  }

  await notify(ctx, {
    recipient: traveller,
    kind: outcome === "card_declined" ? "approval_decided" : "approval_rate_lost",
    subject: `${approver.name} approved your request, but nothing was booked`,
    body: `${message}\nSearch again to find the next best option.`,
    actionUrl: `${ctx.publicBaseUrl.replace(/\/+$/, "")}/trip/${booking.id}`,
    approvalId: approval.id,
    bookingId: booking.id,
  });

  return ok(200, { approval: await buildApprovalView(ctx, recorded), booking: updated });
}

// ---------- withdraw / cancel ----------

export async function withdrawBooking(ctx: ServerContext, booking: Booking): Promise<HttpResult> {
  if (!canWithdraw(booking) || booking.approvalId === null) {
    return errorResult(409, "not_pending", "Only a request that is waiting for approval can be withdrawn.");
  }
  const now = ctx.now();
  let approval: ApprovalRequest;
  try {
    // The approval is the lock: a concurrent decision and a withdrawal cannot both win it.
    approval = await ctx.store.mutateApproval(booking.approvalId, (cur) => withdraw(cur, now));
  } catch (err) {
    if (err instanceof AlreadyDecidedError) {
      return errorResult(409, "not_pending", "This request has already been decided.");
    }
    throw err;
  }
  const hold = await releaseHold(ctx, booking);
  const updated = await ctx.store.mutateBooking(booking.id, (cur) =>
    cur.state === "pending_approval"
      ? {
          ...cur,
          state: "cancelled",
          cancelledAt: now.toISOString(),
          cancellationReason: "withdrawn",
          hold: hold ?? cur.hold,
        }
      : cur,
  );
  return ok(200, { booking: updated, approval: await buildApprovalView(ctx, approval) });
}

export async function cancelBooking(ctx: ServerContext, booking: Booking): Promise<HttpResult> {
  if (booking.state === "cancelled") return ok(200, { booking });
  const now = ctx.now();
  if (!isCancellableAt(booking, now)) {
    return errorResult(
      409,
      "outside_free_window",
      booking.state !== "confirmed"
        ? "Only a confirmed booking can be cancelled."
        : booking.cancellationDeadline === null
          ? "This rate is non-refundable, so it cannot be cancelled for free."
          : "The free-cancellation window has closed. Contact support to cancel this trip.",
      { cancellationDeadline: booking.cancellationDeadline },
    );
  }
  const source = sourceFor(ctx, booking.offer.rate.sourceId);
  if (source === undefined) return errorResult(503, "source_unavailable", "We cannot reach the hotel's system right now.");

  try {
    await withCorrelationId(booking.id, async () => {
      if (booking.supplierBookingRef !== null) await source.cancel(booking.supplierBookingRef);
    });
  } catch {
    return errorResult(503, "source_unavailable", "We could not reach the hotel to cancel. Try again.");
  }
  if (booking.card !== null) {
    const tokenRef = booking.card.tokenRef;
    // Void before persisting: an un-voided card on a cancelled booking is a live authorisation.
    await withCorrelationId(booking.id, () => voidCard(ctx, booking, tokenRef));
  }
  const updated = await ctx.store.mutateBooking(booking.id, (cur) =>
    cur.state === "confirmed"
      ? { ...cur, state: "cancelled", cancelledAt: now.toISOString(), cancellationReason: "traveller" }
      : cur,
  );
  return ok(200, { booking: updated });
}

// ---------- modify ----------

export async function quoteModification(
  ctx: ServerContext,
  traveller: Traveller,
  booking: Booking,
  body: z.infer<typeof modifyQuoteBody>,
): Promise<HttpResult> {
  const now = ctx.now();
  const allowed = canModify(booking, now);
  if (!allowed.ok) return errorResult(409, allowed.code, allowed.message);

  const lookup = await ctx.searches.resolve(body.searchId, traveller.id);
  if (!lookup.ok) return errorResult(lookup.status, lookup.code, lookup.message);
  await lookup.session.settled();
  const ranked = lookup.session.find(body.offerId);
  if (ranked === undefined) return errorResult(404, "offer_not_found", "That room is no longer part of this search.");

  const policy = await ctx.policyFor(traveller.entityId);
  const pinMonth = pinMonthOf(now);
  const pins = await ctx.store.getFxPins(pinMonth);
  const verdict = evaluate({ rate: ranked.offer.rate, property: ranked.offer.property, policy, fxPins: pins, pinMonth });
  const refused = modifyVerdictRefusal(verdict);
  if (refused !== null) return refused;

  return ok(200, {
    quote: quoteModify({ booking, newOffer: ranked.offer, newVerdict: verdict, searchId: body.searchId, now }),
  });
}

function modifyVerdictRefusal(verdict: Booking["verdict"]): HttpResult | null {
  if (verdict.state === "blocked") return errorResult(403, "blocked_by_policy", verdict.reason, { verdict });
  if (verdict.state === "over") {
    return errorResult(
      422,
      "modify_over_cap",
      "A change can only move to an in-policy rate. An over-cap hotel needs a new request.",
      { verdict },
    );
  }
  return null;
}

export async function modifyBooking(
  ctx: ServerContext,
  traveller: Traveller,
  booking: Booking,
  key: string,
  body: z.infer<typeof modifyBody>,
): Promise<HttpResult> {
  const requestHash = stableHash({
    op: "modify",
    bookingId: booking.id,
    searchId: body.searchId,
    offerId: body.offerId,
    acceptedNewTotal: { minor: body.acceptedNewTotal.minor, currency: body.acceptedNewTotal.currency },
  });
  return withIdempotency(
    ctx,
    { key, travellerId: traveller.id, requestHash },
    (mark) => attemptModify(ctx, traveller, booking.id, key, body, mark),
    async (newBookingId) => {
      const created = await ctx.store.getBooking(newBookingId);
      if (created === null) return errorResult(404, "not_found", "That trip does not exist.");
      const replaced = created.replaces === null ? null : await ctx.store.getBooking(created.replaces);
      return ok(200, { booking: created, replaced, warnings: [] });
    },
  );
}

async function attemptModify(
  ctx: ServerContext,
  traveller: Traveller,
  bookingId: string,
  key: string,
  body: z.infer<typeof modifyBody>,
  markPersisted: (bookingId: string) => Promise<void>,
): Promise<HttpResult> {
  const current = await ctx.store.getBooking(bookingId);
  if (current === null) return errorResult(404, "not_found", "That trip does not exist.");
  const allowed = canModify(current, ctx.now());
  if (!allowed.ok) return errorResult(409, allowed.code, allowed.message);

  const lookup = await ctx.searches.resolve(body.searchId, traveller.id);
  if (!lookup.ok) return errorResult(lookup.status, lookup.code, lookup.message);
  const session = lookup.session;
  await session.settled();
  const ranked = session.find(body.offerId);
  if (ranked === undefined) return errorResult(404, "offer_not_found", "That room is no longer part of this search.");

  const [policy, entity] = await Promise.all([ctx.policyFor(traveller.entityId), ctx.entityFor(traveller.entityId)]);
  const source = sourceFor(ctx, ranked.offer.rate.sourceId);
  if (source === undefined) return errorResult(503, "source_unavailable", "We cannot reach the hotel's system right now.");

  const newBookingId = newId("bkg");
  return withCorrelationId(newBookingId, async (): Promise<HttpResult> => {
    let fresh: Offer | null;
    try {
      fresh = await source.priceCheck(body.offerId, session.query);
    } catch {
      return errorResult(503, "source_unavailable", "We could not confirm this rate. Try again in a moment.");
    }
    if (fresh === null) return errorResult(410, "sold_out", "That room has just sold out.");

    const now = ctx.now();
    const pinMonth = pinMonthOf(now);
    const pins = await ctx.store.getFxPins(pinMonth);
    const verdict = evaluate({ rate: fresh.rate, property: fresh.property, policy, fxPins: pins, pinMonth });
    const refused = modifyVerdictRefusal(verdict);
    if (refused !== null) return refused;

    const drift = driftBetween(body.acceptedNewTotal, fresh.rate.allInTotal);
    if (drift !== null) return errorResult(409, "price_drift", drift.message, drift);

    const base: Booking = {
      id: newBookingId,
      confirmationCode: newConfirmationCode(),
      travellerId: traveller.id,
      entityId: traveller.entityId,
      state: "searched",
      offer: freeze(fresh),
      commute: freeze(ranked.commute),
      verdict: freeze(verdict),
      anchor: freeze(session.query.anchor),
      costCentre: current.costCentre,
      card: null,
      cancellationDeadline: fresh.rate.refundableUntil,
      createdAt: now.toISOString(),
      cancelledAt: null,
      idempotencyKey: key,
      supplierBookingRef: null,
      amounts: buildAmounts(fresh.rate.allInTotal, session.displayCurrency, entity.settlementCurrency, pins),
      approvalId: null,
      hold: null,
      confirmedAt: null,
      checkInTime: null,
      cancellationReason: null,
      replaces: current.id,
      replacedBy: null,
      settledAt: null,
      invoiceId: null,
    };

    // --- book the new stay FIRST. A traveller is never left without a room.
    const attempt = await issueAndBook(ctx, {
      booking: base,
      offer: fresh,
      query: session.query,
      traveller,
      policy,
      pins,
      holdRef: null,
      source,
    });
    if (attempt.kind !== "booked") return attemptFailure(attempt);
    const created: Booking = {
      ...base,
      state: "confirmed",
      card: attempt.card,
      supplierBookingRef: attempt.supplier.supplierBookingRef,
      cancellationDeadline: attempt.supplier.cancellationDeadline,
      checkInTime: attempt.supplier.checkInTime,
      confirmedAt: ctx.now().toISOString(),
    };
    await ctx.store.putBooking(created);
    await markPersisted(created.id);

    // --- then cancel the old one.
    const warnings: string[] = [];
    let replaced: Booking = current;
    try {
      const oldSource = sourceFor(ctx, current.offer.rate.sourceId);
      if (oldSource === undefined) throw new Error(`source ${current.offer.rate.sourceId} is not configured`);
      await withCorrelationId(current.id, async () => {
        if (current.supplierBookingRef !== null) await oldSource.cancel(current.supplierBookingRef);
      });
      const card = current.card;
      if (card !== null) await withCorrelationId(current.id, () => voidCard(ctx, current, card.tokenRef));
      const at = ctx.now().toISOString();
      replaced = await ctx.store.mutateBooking(current.id, (cur) =>
        cur.state === "confirmed"
          ? { ...cur, state: "modified", replacedBy: created.id, cancelledAt: at, cancellationReason: "modified" }
          : cur,
      );
    } catch {
      warnings.push(
        `Your new stay at ${created.offer.property.name} is booked (confirmation ${created.confirmationCode}), but we couldn't cancel your old booking at ${current.offer.property.name} (confirmation ${current.confirmationCode}). Both bookings are active: cancel the old one from its trip page, or contact the travel desk.`,
      );
      replaced = (await ctx.store.getBooking(current.id)) ?? current;
    }
    return ok(201, { booking: created, replaced, warnings });
  });
}

// ---------- desk decline, invoice ----------

export async function reportDeskDecline(
  ctx: ServerContext,
  traveller: Traveller,
  booking: Booking,
  note: string | null,
): Promise<HttpResult> {
  if (booking.card === null) return errorResult(409, "no_card", "There is no company card on this booking yet.");
  const cardEvent = await recordCardEvent(ctx, booking, "desk_declined", null, note);
  const property = booking.offer.property;
  await withCorrelationId(booking.id, () =>
    notifyAdmins(ctx, booking.entityId, {
      kind: "card_declined_at_desk",
      subject: `Card declined at the desk · ${property.name}`,
      body: [
        `${traveller.name} reports the company card ending ${booking.card?.last4 ?? ""} was declined at check-in (confirmation ${booking.confirmationCode}).`,
        note === null ? null : `Note: "${note}"`,
        `Call the hotel on ${property.phone} and send the authorisation letter.`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
      actionUrl: `${ctx.publicBaseUrl.replace(/\/+$/, "")}/admin`,
      approvalId: null,
      bookingId: booking.id,
    }),
  );
  return ok(201, { cardEvent });
}

export async function invoiceFor(ctx: ServerContext, booking: Booking): Promise<HttpResult> {
  const invoice = await ctx.store.getInvoiceForBooking(booking.id);
  if (invoice !== null) return ok(200, { invoice });
  const availableAfter = checkoutInstant(booking.offer.rate.checkOut, booking.offer.property.timeZone).toISOString();
  const stayed = booking.state === "confirmed" || booking.state === "settled" || booking.state === "pending_approval";
  const message = stayed
    ? `Your tax invoice is issued after checkout. It will be ready after ${formatDeadline(availableAfter, booking.offer.property.timeZone ?? "Asia/Kolkata")}.`
    : "No invoice is issued for a stay that did not go ahead.";
  return errorResult(404, "invoice_not_ready", message, { availableAfter, message });
}
