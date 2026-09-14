/**
 * Shared domain types. The contract every module is written against.
 *
 * Slice 2 (The Real World) extends Slice 1 without breaking its stored records:
 *  - PolicyState gains 'over'. Over-cap is now bookable, but only through a hard
 *    approval. 'blocked' remains unbookable at any price (country, supplier, flex).
 *  - Three currencies exist per booking — supplier, display, settlement — and every
 *    conversion is stored with the FX rate that produced it. Money stays integer
 *    minor units; an FX rate is an integer scaled by 1e6, never a float.
 *  - A policy verdict records which evaluator produced it and which FX pin it used,
 *    so A12's byte-identical replay still holds after the evaluator changes.
 *    Slice 1 verdicts carry neither field; absent means evaluator v1.
 *  - No card primary account number appears in ANY type in this file (A13).
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
export type IsoMonth = string; // "2026-09"

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

// ---------- foreign exchange ----------

/**
 * One conversion rate. `rateMicros` is quote units per ONE base unit, times 1e6,
 * as an integer: 1 GBP = 106.25 INR is { base: "GBP", quote: "INR", rateMicros:
 * 106_250_000 }. Currency exponents (JPY has none, BHD has three) are applied by
 * core/fx.ts, never by callers.
 */
export interface FxRate {
  readonly base: Currency;
  readonly quote: Currency;
  readonly rateMicros: number;
  /**
   * 'pinned_monthly' is the corporate rate for a calendar month and is what policy
   * evaluation uses — a live rate would give the same booking different verdicts on
   * different days (spec §2.5). 'spot' is display-only.
   */
  readonly source: "pinned_monthly" | "spot";
  readonly pinMonth: IsoMonth | null;
  readonly asOf: IsoDateTime;
}

/** A stored conversion. `fx` is null when `from` and `to` share a currency. */
export interface Conversion {
  readonly from: Money;
  readonly to: Money;
  readonly fx: FxRate | null;
}

/** The three currencies of one booking (spec §2.5). None is ever re-derived later. */
export interface BookingAmounts {
  /** What the rate is sold in, and what the card is authorised in. */
  readonly supplier: Money;
  /** Supplier → the traveller's display currency. */
  readonly display: Conversion;
  /** Supplier → the billing entity's settlement currency, frozen at confirmation. */
  readonly settlement: Conversion;
}

// ---------- organisation ----------

export interface LegalEntity {
  readonly id: string;
  readonly legalName: string;
  /** 15-character GSTIN, or null outside India. */
  readonly gstin: string | null;
  /** Two-digit GST state code the GSTIN is registered in, e.g. "27" (Maharashtra). */
  readonly stateCode: string | null;
  readonly address: string;
  readonly settlementCurrency: Currency;
  readonly reportingCurrency: Currency;
  /** Prefix for the GST invoice series, e.g. "ACME". Series numbers are ≤16 chars. */
  readonly invoiceSeriesPrefix: string;
}

// ---------- supply ----------

export type PropertyId = string;
export type OfferId = string;

export interface Property {
  readonly id: PropertyId;
  readonly name: string;
  readonly addressLine: string;
  readonly city: string;
  readonly cityTier: string;
  readonly countryCode: string; // ISO 3166-1 alpha-2
  readonly geo: GeoPoint;
  readonly phone: string;
  readonly brand: string | null;
  readonly workReady: boolean;
  readonly thumbnailUrl: string | null;
  /** GST state code of the property's location — the place of supply (India only). */
  readonly stateCode: string | null;
  /** The hotel's own GSTIN, which issues the tax invoice (India only). */
  readonly supplierGstin: string | null;
  /** IANA zone, for check-in times and cancellation deadlines in local time. */
  readonly timeZone: string;
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
  /** Must sum exactly to allInTotal. */
  readonly components: readonly RateComponent[];
  readonly allInTotal: Money;
  readonly perNight: Money;
  /** The pre-tax room tariff per night — the figure GST slabs are decided on. */
  readonly tariffPerNight: Money;
  readonly breakfastIncluded: boolean;
  readonly refundableUntil: IsoDateTime | null;
  readonly channel: SupplyChannel;
  readonly supplierRef: string;
  readonly sourceId: string;
  /** Whether this specific rate can be held while an approval is pending. */
  readonly holdable: boolean;
}

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

// ---------- travel advisories (duty of care) ----------

export interface TravelAdvisory {
  readonly countryCode: string;
  /** null = the whole country. */
  readonly city: string | null;
  readonly level: "caution" | "high";
  readonly note: string;
  readonly updatedAt: IsoDateTime;
}

// ---------- policy ----------

export type PolicyState = "in" | "over" | "blocked";

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
  readonly capPerNight: Money | null;
  /**
   * Slice 1: overage in the rate currency. Slice 2: overage in the CAP currency,
   * because that is the currency the policy is argued in. Equals `overage.minor`
   * whenever `overage` is present.
   */
  readonly overageMinor: number | null;
  /** Absent on Slice 1 verdicts, which means evaluator v1. */
  readonly evaluatorVersion?: number;
  /** Per-night overage in the cap currency. Absent on Slice 1 verdicts. */
  readonly overage?: Money | null;
  /** The monthly pin used when the cap and the rate are in different currencies. */
  readonly fxPin?: FxRate | null;
  /** A caution/high advisory for the property's city or country, flagged at confirm. */
  readonly advisory?: TravelAdvisory | null;
}

export interface PolicyCap {
  readonly cityTier: string;
  readonly city: string | null;
  /** The cap's currency is the currency it was authored in. */
  readonly perNight: Money;
}

export interface JustificationReason {
  readonly code: string;
  readonly label: string;
}

export interface ApprovalPolicy {
  /** Slice 2 ships hard approval only: nothing over cap books without a yes. */
  readonly mode: "hard";
  readonly slaMinutes: number;
  /** How many times a request may climb the manager chain on SLA breach. */
  readonly maxEscalations: number;
  readonly justificationReasons: readonly JustificationReason[];
  /** Used when a traveller has no manager in the directory. */
  readonly fallbackApproverEmails: readonly string[];
}

export interface Policy {
  readonly version: number;
  readonly entityId: string;
  readonly caps: readonly PolicyCap[];
  readonly requireFlexible: boolean;
  readonly blockedCountries: readonly string[];
  readonly blockedSuppliers: readonly string[];
  readonly costCentres: readonly string[];
  readonly defaultCostCentre: string;
  readonly incidentalsBufferMinor: number;
  readonly reportingCurrency: Currency;
  readonly approval: ApprovalPolicy;
  readonly advisories: readonly TravelAdvisory[];
  readonly updatedAt: IsoDateTime;
  readonly updatedBy: string;
}

// ---------- ranking ----------

export interface RankedOffer {
  readonly offer: Offer;
  readonly commute: Commute;
  readonly verdict: PolicyVerdict;
  /** 1-based over 'in' and 'over' offers. Blocked offers carry 0. */
  readonly rank: number;
  readonly rankReason: string;
  /** allInTotal converted to the traveller's display currency. */
  readonly display: Conversion;
}

// ---------- payments ----------

/** Deliberately carries NO pan, cvv, or anything that could become one (A13). */
export interface IssuedCard {
  readonly tokenRef: string;
  readonly last4: string;
  readonly brand: string;
  readonly expMonth: number;
  readonly expYear: number;
  /** Authorised in the supplier currency — the currency the hotel charges in. */
  readonly authorisedTotal: Money;
  readonly incidentalsBufferMinor: number;
  readonly issuerId: string;
  readonly validFrom: IsoDate;
  readonly validUntil: IsoDate;
}

export type CardEventKind = "issued" | "issue_declined" | "voided" | "desk_declined";

export interface CardEvent {
  readonly id: string;
  readonly bookingId: string;
  readonly entityId: string;
  readonly at: IsoDateTime;
  readonly kind: CardEventKind;
  readonly declineCode: string | null;
  readonly note: string | null;
}

// ---------- identity ----------

export interface Traveller {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly entityId: string;
  readonly defaultCostCentre: string;
  readonly isAdmin: boolean;
  readonly createdAt: IsoDateTime;
  /** From the uploaded directory. null = no manager known; fallback approvers apply. */
  readonly managerId: string | null;
  readonly displayCurrency: Currency | null;
  /** Set when erased under a data-rights request; personal fields are pseudonymised. */
  readonly erasedAt: IsoDateTime | null;
}

export interface DirectoryEntry {
  readonly email: string;
  readonly name: string;
  readonly managerEmail: string | null;
  readonly costCentre: string | null;
  readonly isAdmin: boolean;
}

// ---------- approvals ----------

export type ApprovalState = "pending" | "approved" | "rejected" | "withdrawn";

/** What happened to the booking after a decision. An approval can succeed and the rate still be lost. */
export type ApprovalOutcome = "confirmed" | "rate_lost" | "sold_out" | "card_declined";

export interface ApprovalLevel {
  /** 0 = the first approver. */
  readonly level: number;
  readonly approverId: string;
  readonly startedAt: IsoDateTime;
  readonly dueAt: IsoDateTime;
  readonly cause: "initial" | "sla_breach";
}

export interface ApprovalRequest {
  readonly id: string;
  readonly bookingId: string;
  readonly travellerId: string;
  readonly entityId: string;
  readonly state: ApprovalState;
  readonly justificationCode: string;
  readonly justificationText: string;
  readonly verdict: PolicyVerdict;
  /** In the cap currency. */
  readonly overagePerNight: Money;
  readonly overageStay: Money;
  readonly slaMinutes: number;
  /** Approver ids in escalation order, resolved from the directory at request time. */
  readonly chain: readonly string[];
  /** Materialised history. The last entry is the current level. */
  readonly levels: readonly ApprovalLevel[];
  /** Pending at the last available level and past due. Surfaced to admins; the request never expires. */
  readonly slaBreachedAtTop: boolean;
  readonly createdAt: IsoDateTime;
  readonly decidedAt: IsoDateTime | null;
  readonly decidedBy: string | null;
  readonly decisionNote: string | null;
  readonly outcome: ApprovalOutcome | null;
}

/** The honest state of a rate while its approval is pending. */
export interface HoldStatus {
  readonly held: boolean;
  readonly supplierHoldRef: string | null;
  readonly heldUntil: IsoDateTime | null;
  /** Shown verbatim to the traveller. Never claims a hold that does not exist. */
  readonly message: string;
}

// ---------- notifications ----------

export type NotificationChannel = "in_app" | "email" | "slack" | "push";

export type NotificationKind =
  | "approval_requested"
  | "approval_escalated"
  | "approval_decided"
  | "approval_rate_lost"
  | "booking_confirmed"
  | "card_declined_at_desk";

export interface NotificationRecord {
  readonly id: string;
  readonly at: IsoDateTime;
  readonly recipientId: string;
  readonly channel: NotificationChannel;
  readonly kind: NotificationKind;
  readonly subject: string;
  readonly body: string;
  readonly actionUrl: string | null;
  readonly approvalId: string | null;
  readonly bookingId: string | null;
  readonly delivery: "sent" | "failed";
  readonly deliveryError: string | null;
  readonly readAt: IsoDateTime | null;
}

// ---------- booking ----------

export type BookingState =
  | "searched"
  | "held"
  | "pending_approval"
  | "confirmed"
  | "modified"
  | "rejected"
  | "cancelled"
  | "settled";

export type CancellationReason =
  | "traveller"
  | "withdrawn"
  | "rate_lost"
  | "sold_out"
  | "card_declined"
  | "modified";

export interface Booking {
  readonly id: string;
  readonly confirmationCode: string;
  readonly travellerId: string;
  readonly entityId: string;
  readonly state: BookingState;
  /** Frozen at request time. Reporting reads this, never live supply. */
  readonly offer: Offer;
  readonly commute: Commute;
  readonly verdict: PolicyVerdict;
  readonly anchor: Anchor;
  readonly costCentre: string;
  /** Issued at confirmation — never while an approval is pending. */
  readonly card: IssuedCard | null;
  readonly cancellationDeadline: IsoDateTime | null;
  readonly createdAt: IsoDateTime;
  readonly cancelledAt: IsoDateTime | null;
  readonly idempotencyKey: string;
  readonly supplierBookingRef: string | null;
  readonly amounts: BookingAmounts;
  readonly approvalId: string | null;
  readonly hold: HoldStatus | null;
  readonly confirmedAt: IsoDateTime | null;
  readonly checkInTime: string | null;
  readonly cancellationReason: CancellationReason | null;
  /** Modify chain: this booking replaced `replaces`, and was replaced by `replacedBy`. */
  readonly replaces: string | null;
  readonly replacedBy: string | null;
  readonly settledAt: IsoDateTime | null;
  readonly invoiceId: string | null;
}

// ---------- modify ----------

export interface ModifyQuote {
  readonly bookingId: string;
  readonly searchId: string;
  readonly newOfferId: OfferId;
  readonly currentTotal: Money;
  readonly newTotal: Money;
  /** Signed: positive costs more, negative costs less. Only set when currencies match. */
  readonly delta: Money | null;
  /** What cancelling the current booking costs. Zero inside the free window. */
  readonly cancellationCost: Money;
  readonly verdict: PolicyVerdict;
  readonly message: string;
}

// ---------- tax invoices ----------

export interface InvoiceParty {
  readonly name: string;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly address: string;
}

export interface InvoiceLine {
  readonly description: string;
  /** SAC 996311 for hotel room accommodation. null outside GST. */
  readonly sac: string | null;
  readonly taxableValue: Money;
  readonly taxRatePercent: number;
  readonly cgst: Money | null;
  readonly sgst: Money | null;
  readonly igst: Money | null;
  /** VAT / occupancy tax outside India, itemised but not a GST document. */
  readonly otherTax: Money | null;
  readonly total: Money;
}

export interface Invoice {
  readonly id: string;
  readonly bookingId: string;
  readonly entityId: string;
  /** A GST tax invoice for Indian entities; an itemised tax summary everywhere else. */
  readonly kind: "gst_tax_invoice" | "tax_summary";
  /** GST rule 46: consecutive, unique per financial year, at most 16 characters. */
  readonly number: string;
  readonly financialYear: string; // "2026-27"
  readonly issuedAt: IsoDateTime;
  readonly supplier: InvoiceParty;
  readonly recipient: InvoiceParty;
  /** GST state code of the property — the place of supply for accommodation. */
  readonly placeOfSupply: string | null;
  readonly lines: readonly InvoiceLine[];
  readonly taxableTotal: Money;
  readonly taxTotal: Money;
  readonly grandTotal: Money;
  /** Whether the entity can claim input tax credit, and the precise reason. */
  readonly itc: { readonly claimable: boolean; readonly reason: string };
}

// ---------- chat entry ----------

export interface ClarifyingQuestion {
  readonly field: "anchor" | "dates" | "guests";
  readonly question: string;
  /** Tap-to-answer options. May be empty when free text is the only sensible reply. */
  readonly options: readonly string[];
}

export interface ParsedIntent {
  readonly text: string;
  readonly anchorQuery: string | null;
  readonly anchor: Anchor | null;
  readonly checkIn: IsoDate | null;
  readonly checkOut: IsoDate | null;
  readonly guests: number | null;
  readonly rooms: number | null;
  readonly constraints: {
    readonly inPolicyOnly: boolean;
    readonly workReady: boolean;
    readonly freeCancellation: boolean;
    readonly breakfast: boolean;
    readonly maxCommuteMinutes: number | null;
  };
  /** 0..1 per field. Below 0.6 the parser must ask rather than guess. */
  readonly confidence: { readonly anchor: number; readonly dates: number };
  /** Exactly one question when something is missing or unclear, never more. */
  readonly clarification: ClarifyingQuestion | null;
  /** The machine-voice read-back: "BKC, Mumbai · Tue 15 – Fri 18 Sep · 1 guest". */
  readonly readBack: string;
  readonly parser: "rules" | "claude";
}

// ---------- duty of care ----------

export interface InMarketTraveller {
  readonly travellerId: string;
  readonly name: string;
  readonly email: string;
  readonly bookingId: string;
  readonly confirmationCode: string;
  readonly state: BookingState;
  readonly propertyName: string;
  readonly propertyPhone: string;
  readonly addressLine: string;
  readonly city: string;
  readonly countryCode: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly advisory: TravelAdvisory | null;
}

// ---------- data rights ----------

export interface SearchRecord {
  readonly id: string;
  readonly travellerId: string;
  readonly entityId: string;
  readonly anchor: Anchor;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly createdAt: IsoDateTime;
}

export interface DataExport {
  readonly exportedAt: IsoDateTime;
  readonly traveller: Traveller;
  readonly bookings: readonly Booking[];
  readonly approvals: readonly ApprovalRequest[];
  readonly invoices: readonly Invoice[];
  readonly notifications: readonly NotificationRecord[];
  readonly searches: readonly SearchRecord[];
  readonly cardEvents: readonly CardEvent[];
  readonly sourceLog: readonly SourceLogEntry[];
}

export interface ErasureReceipt {
  readonly travellerId: string;
  readonly erasedAt: IsoDateTime;
  readonly pseudonym: string;
  /** Kept, with personal fields stripped, because tax law outranks erasure (spec §3.2). */
  readonly retained: { readonly bookings: number; readonly invoices: number; readonly basis: string };
  readonly deleted: { readonly searches: number; readonly notifications: number };
}

// ---------- immutable supplier log ----------

export interface SourceLogEntry {
  readonly id: string;
  readonly at: IsoDateTime;
  readonly sourceId: string;
  readonly operation:
    | "search"
    | "priceCheck"
    | "hold"
    | "releaseHold"
    | "book"
    | "cancel"
    | "issueCard"
    | "voidCard"
    | "notify"
    | "parseIntent";
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
  | "justification_required"
  | "card_declined"
  | "source_unavailable";

export interface PriceDriftDetail {
  readonly kind: "price_drift";
  readonly acceptedTotal: Money;
  readonly currentTotal: Money;
  readonly deltaMinor: number;
  readonly message: string;
}
