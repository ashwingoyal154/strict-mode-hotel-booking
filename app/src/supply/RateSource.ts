import type { Currency, IsoDateTime, Money, Offer, OfferId, SearchQuery } from "../core/types.ts";

/**
 * The single seam between this platform and hotel supply.
 *
 * Spec §3.1: no booking, policy, billing or UI code may know which RateSource it
 * is talking to. Slice 2 adds the live Expedia Rapid adapter behind this line, and
 * gate S1 is exactly the claim that swapping to it changes nothing above here.
 */
export interface RateSource {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: RateSourceCapabilities;

  /** May reject on timeout. The caller fans out and never blocks on the slowest. */
  searchAvailability(query: SearchQuery, signal: AbortSignal): Promise<Offer[]>;

  /** Re-price one offer. The return is authoritative. null = the rate is gone. */
  priceCheck(offerId: OfferId, query: SearchQuery): Promise<Offer | null>;

  /**
   * Hold a rate while an approval is pending. Throws SupplierHoldUnsupportedError
   * when the source or this particular rate cannot be held — the caller must then
   * tell the traveller the rate may move, never pretend it is held.
   */
  hold(req: SupplierHoldRequest): Promise<SupplierHold>;

  releaseHold(holdRef: string): Promise<void>;

  book(req: SupplierBookRequest): Promise<SupplierBooking>;

  cancel(supplierBookingRef: string): Promise<void>;
}

export interface RateSourceCapabilities {
  /** Whether the source can hold any rate at all. Individual rates also carry `holdable`. */
  readonly holds: boolean;
  readonly maxHoldMinutes: number;
  /** True for a real supplier integration, false for fixtures. Surfaced in /api/health. */
  readonly live: boolean;
  readonly currencies: readonly Currency[] | "any";
}

export interface SupplierHoldRequest {
  readonly offerId: OfferId;
  readonly query: SearchQuery;
  readonly expectedTotal: Money;
  /** The hold is requested for this long, capped at capabilities.maxHoldMinutes. */
  readonly minutes: number;
  readonly correlationId: string;
}

export interface SupplierHold {
  readonly holdRef: string;
  readonly heldTotal: Money;
  readonly heldUntil: IsoDateTime;
}

export interface SupplierBookRequest {
  readonly offerId: OfferId;
  readonly query: SearchQuery;
  readonly travellerName: string;
  readonly travellerEmail: string;
  /** Total the platform has authorised. The source must not exceed it. */
  readonly authorisedTotal: Money;
  readonly cardTokenRef: string;
  readonly correlationId: string;
  /** Book against a hold, which guarantees the held price until heldUntil. */
  readonly holdRef: string | null;
}

export interface SupplierBooking {
  readonly supplierBookingRef: string;
  readonly confirmedTotal: Money;
  readonly cancellationDeadline: IsoDateTime | null;
  readonly checkInTime: string;
}

export class SupplierPriceDriftError extends Error {
  constructor(readonly currentTotal: Money, readonly previousTotal: Money) {
    super("supplier price drift");
    this.name = "SupplierPriceDriftError";
  }
}

export class SupplierSoldOutError extends Error {
  constructor() {
    super("supplier sold out");
    this.name = "SupplierSoldOutError";
  }
}

export class SupplierHoldUnsupportedError extends Error {
  constructor(readonly reason: string) {
    super(`hold unsupported: ${reason}`);
    this.name = "SupplierHoldUnsupportedError";
  }
}

export class SupplierHoldExpiredError extends Error {
  constructor(readonly holdRef: string) {
    super(`hold expired: ${holdRef}`);
    this.name = "SupplierHoldExpiredError";
  }
}

/** A transport-level failure talking to a live supplier: timeout, 5xx, auth. Retryable. */
export class SupplierUnavailableError extends Error {
  constructor(readonly sourceId: string, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "SupplierUnavailableError";
  }
}
