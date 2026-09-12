/**
 * Shared domain types. The contract every module is written against.
 *
 * Slice 1 (Strict Mode) constraints encoded here:
 *  - PolicyState is 'in' | 'blocked' only. Over-cap is NOT bookable; it resolves
 *    to 'blocked' with reasonCode 'over_cap'. Slice 2 adds 'over' + approvals.
 *  - Money is integer minor units + currency. Never a float, never a Number for
 *    display. Slice 1 runs one currency; the type is already slice-2 shaped.
 *  - No card primary account number (PAN) appears in ANY type in this file.
 *    That is acceptance criterion A13, enforced by construction.
 */

// ---------- identity & money ----------

export type Currency = string; // ISO 4217, e.g. "INR"

/** An amount in integer minor units (paise, cents). Never a float. */
export interface Money {
  readonly minor: number;
  readonly currency: Currency;
}

export type IsoDate = string; // "2026-06-11"
export type IsoDateTime = string; // "2026-06-11T09:00:00.000Z"

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

// ---------- supply ----------

export type PropertyId = string;
export type OfferId = string;

export interface Property {
  readonly id: PropertyId;
  readonly name: string;
  readonly addressLine: string;
  readonly city: string;
  readonly cityTier: string; // policy caps are authored per tier
  readonly countryCode: string; // ISO 3166-1 alpha-2
  readonly geo: GeoPoint;
  readonly phone: string;
  readonly brand: string | null;
  /** Wi-Fi + desk + quiet workspace. The one amenity signal the product shows. */
  readonly workReady: boolean;
  readonly thumbnailUrl: string | null;
}

export type RateComponentKind = "base" | "tax" | "fee";

export interface RateComponent {
  readonly kind: RateComponentKind;
  readonly label: string;
  readonly amount: Money;
}

export type SupplyChannel = "fixture" | "public" | "bedbank" | "negotiated";

export interface Rate {
  readonly id: OfferId;
  readonly propertyId: PropertyId;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly nights: number;
  readonly currency: Currency;
  /** Must sum exactly to allInTotal. Verified by pricing.assertComponentsSum. */
  readonly components: readonly RateComponent[];
  readonly allInTotal: Money;
  readonly perNight: Money;
  readonly breakfastIncluded: boolean;
  /** null = non-refundable. */
  readonly refundableUntil: IsoDateTime | null;
  readonly channel: SupplyChannel;
  readonly supplierRef: string;
  readonly sourceId: string;
}

/** A property and one bookable rate for it. */
export interface Offer {
  readonly property: Property;
  readonly rate: Rate;
}

// ---------- routing ----------

export type CommuteMode = "walk" | "transit" | "drive";

export interface Commute {
  readonly minutes: number;
  readonly mode: CommuteMode;
  readonly distanceMeters: number;
}

// ---------- search ----------

export interface Anchor {
  /** What the traveller typed or picked, shown back to them verbatim. */
  readonly label: string;
  readonly geo: GeoPoint;
  readonly city: string;
  readonly countryCode: string;
}

export interface SearchQuery {
  readonly anchor: Anchor;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly guests: number;
  readonly rooms: number;
}

// ---------- policy ----------

export type PolicyState = "in" | "blocked";

export type PolicyReasonCode =
  | "within_cap"
  | "over_cap"
  | "blocked_country"
  | "blocked_supplier"
  | "flex_required";

export interface PolicyVerdict {
  readonly state: PolicyState;
  readonly reasonCode: PolicyReasonCode;
  /** Human sentence shown verbatim in the UI. Part of the stored audit record. */
  readonly reason: string;
  readonly policyVersion: number;
  /** The cap that applied, when one did. */
  readonly capPerNight: Money | null;
  /** Positive when over cap, in minor units of the rate currency. */
  readonly overageMinor: number | null;
}

export interface PolicyCap {
  readonly cityTier: string;
  /** Overrides the tier cap for this exact city name. */
  readonly city: string | null;
  readonly perNight: Money;
}

export interface Policy {
  readonly version: number;
  readonly entityId: string;
  readonly caps: readonly PolicyCap[];
  /** When true, non-refundable rates are blocked. */
  readonly requireFlexible: boolean;
  readonly blockedCountries: readonly string[];
  readonly blockedSuppliers: readonly string[];
  readonly costCentres: readonly string[];
  readonly defaultCostCentre: string;
  readonly incidentalsBufferMinor: number;
  readonly updatedAt: IsoDateTime;
  readonly updatedBy: string;
}

// ---------- ranking ----------

export interface RankedOffer {
  readonly offer: Offer;
  readonly commute: Commute;
  readonly verdict: PolicyVerdict;
  /** 1-based. The product's only ranking signal is commute time. */
  readonly rank: number;
  /** Shown inline beside the rank. Never a tooltip. */
  readonly rankReason: string;
}

// ---------- payments ----------

/**
 * An issued single-use virtual card. Deliberately carries NO pan, cvv, or
 * anything that could become one. A13 is enforced by this type's shape.
 */
export interface IssuedCard {
  readonly tokenRef: string;
  readonly last4: string;
  readonly brand: string;
  readonly expMonth: number;
  readonly expYear: number;
  readonly authorisedTotal: Money;
  readonly incidentalsBufferMinor: number;
}

// ---------- booking ----------

export type BookingState =
  | "searched"
  | "held"
  | "confirmed"
  | "cancelled"
  | "settled";

export interface Traveller {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly entityId: string;
  readonly defaultCostCentre: string;
  readonly isAdmin: boolean;
  readonly createdAt: IsoDateTime;
}

export interface Booking {
  readonly id: string;
  readonly confirmationCode: string;
  readonly travellerId: string;
  readonly entityId: string;
  readonly state: BookingState;
  /** Frozen at confirmation. Reporting reads this, never live supply. */
  readonly offer: Offer;
  readonly commute: Commute;
  /** Frozen verdict. A12 replays policy against this and must match byte-for-byte. */
  readonly verdict: PolicyVerdict;
  readonly anchor: Anchor;
  readonly costCentre: string;
  readonly card: IssuedCard | null;
  readonly cancellationDeadline: IsoDateTime | null;
  readonly createdAt: IsoDateTime;
  readonly cancelledAt: IsoDateTime | null;
  readonly idempotencyKey: string;
  readonly supplierBookingRef: string | null;
}

// ---------- immutable supplier log ----------

export interface SourceLogEntry {
  readonly id: string;
  readonly at: IsoDateTime;
  readonly sourceId: string;
  readonly operation: "search" | "priceCheck" | "book" | "cancel" | "issueCard" | "voidCard";
  readonly correlationId: string;
  readonly request: unknown;
  readonly response: unknown;
  readonly errorMessage: string | null;
  readonly durationMs: number;
}

// ---------- errors the API surfaces ----------

export type BookingFailureKind =
  | "price_drift"
  | "sold_out"
  | "blocked_by_policy"
  | "card_declined"
  | "source_unavailable";

export interface PriceDriftDetail {
  readonly kind: "price_drift";
  readonly acceptedTotal: Money;
  readonly currentTotal: Money;
  readonly deltaMinor: number;
  readonly message: string;
}
