import type { Offer, OfferId, SearchQuery, Money, IsoDateTime } from "../core/types.ts";

/**
 * The single seam between this platform and hotel supply.
 *
 * Spec §3.1: no booking, policy, billing or UI code may know which RateSource it
 * is talking to. Slice 1 ships FixtureRateSource; slice 2 swaps in a live
 * supplier adapter with zero changes above this line (gate S1).
 */
export interface RateSource {
  readonly id: string;
  /** Shown in the streaming source counter. */
  readonly displayName: string;

  /** May reject on timeout. The caller fans out and never blocks on the slowest. */
  searchAvailability(query: SearchQuery, signal: AbortSignal): Promise<Offer[]>;

  /**
   * Re-price one offer at confirmation time. The return is authoritative.
   * null means the rate is gone (sold out / withdrawn).
   */
  priceCheck(offerId: OfferId, query: SearchQuery): Promise<Offer | null>;

  book(req: SupplierBookRequest): Promise<SupplierBooking>;

  cancel(supplierBookingRef: string): Promise<void>;
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
}

export interface SupplierBooking {
  readonly supplierBookingRef: string;
  readonly confirmedTotal: Money;
  readonly cancellationDeadline: IsoDateTime | null;
  readonly checkInTime: string; // "14:00" local
}

/** Thrown by a source when the rate moved between search and book. */
export class SupplierPriceDriftError extends Error {
  constructor(readonly currentTotal: Money, readonly previousTotal: Money) {
    super("supplier price drift");
    this.name = "SupplierPriceDriftError";
  }
}

/** Thrown by a source when the rate is gone. */
export class SupplierSoldOutError extends Error {
  constructor() {
    super("supplier sold out");
    this.name = "SupplierSoldOutError";
  }
}
