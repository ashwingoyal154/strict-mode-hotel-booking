/**
 * Shared builders for the core unit tests. Not a test file (no `.test.ts`), so
 * vitest never runs it; it exists because Slice 2 grew Property, Rate, Policy and
 * Booking enough that every test file re-declaring them would drift.
 */
import type {
  Booking,
  FxRate,
  JustificationReason,
  Policy,
  PolicyCap,
  PolicyVerdict,
  Property,
  Rate,
  Traveller,
} from "../../src/core/types.ts";
import { money } from "../../src/core/money.ts";

export function property(over: Partial<Property> = {}): Property {
  return {
    id: "prop_mum_1",
    name: "The Kurla Works",
    addressLine: "G Block, BKC",
    city: "Mumbai",
    cityTier: "metro",
    countryCode: "IN",
    geo: { lat: 19.0654, lng: 72.8686 },
    phone: "+91 22 0000 0000",
    brand: null,
    workReady: true,
    thumbnailUrl: null,
    stateCode: "27",
    supplierGstin: "27AAPFU0939F1ZV",
    timeZone: "Asia/Kolkata",
    ...over,
  };
}

/** ₹8,700/night over four nights = ₹34,800 all-in, the worked example in MODULE_EXPORTS. */
export function rate(over: Partial<Rate> = {}): Rate {
  return {
    id: "off_1",
    propertyId: "prop_mum_1",
    checkIn: "2026-06-11",
    checkOut: "2026-06-15",
    nights: 4,
    currency: "INR",
    components: [{ kind: "base", label: "Room", amount: money(3480000, "INR") }],
    allInTotal: money(3480000, "INR"),
    perNight: money(870000, "INR"),
    tariffPerNight: money(870000, "INR"),
    breakfastIncluded: true,
    refundableUntil: "2026-06-09T12:30:00.000Z",
    channel: "public",
    supplierRef: "sup-1",
    sourceId: "src_a",
    holdable: false,
    ...over,
  };
}

export function londonProperty(over: Partial<Property> = {}): Property {
  return property({
    id: "prop_lon_1",
    name: "Dockside Rooms",
    addressLine: "1 Quay Walk",
    city: "London",
    cityTier: "global",
    countryCode: "GB",
    geo: { lat: 51.5054, lng: -0.0235 },
    phone: "+44 20 0000 0000",
    stateCode: null,
    supplierGstin: null,
    timeZone: "Europe/London",
    ...over,
  });
}

/** A GBP rate priced per night, with a single base component. */
export function gbpRate(perNightMinor: number, nights = 4, over: Partial<Rate> = {}): Rate {
  const total = money(perNightMinor * nights, "GBP");
  return rate({
    id: "off_lon_1",
    propertyId: "prop_lon_1",
    nights,
    currency: "GBP",
    components: [{ kind: "base", label: "Room charge", amount: total }],
    allInTotal: total,
    perNight: money(perNightMinor, "GBP"),
    tariffPerNight: money(perNightMinor, "GBP"),
    ...over,
  });
}

export const JUSTIFICATION_REASONS: readonly JustificationReason[] = [
  { code: "client_site", label: "Client or meeting is at this hotel" },
  { code: "no_inventory", label: "Nothing in policy near the meeting" },
  { code: "late_change", label: "Plans changed at short notice" },
  { code: "safety", label: "Safety or security" },
  { code: "accessibility", label: "Accessibility need" },
];

export function policy(over: Partial<Policy> = {}): Policy {
  const caps: readonly PolicyCap[] = [
    { cityTier: "metro", city: null, perNight: money(900000, "INR") },
    { cityTier: "tier1", city: null, perNight: money(700000, "INR") },
    { cityTier: "tier2", city: null, perNight: money(500000, "INR") },
  ];
  return {
    version: 1,
    entityId: "acme",
    caps,
    requireFlexible: false,
    blockedCountries: [],
    blockedSuppliers: [],
    costCentres: ["ENG-OPS", "SALES", "FINANCE"],
    defaultCostCentre: "ENG-OPS",
    incidentalsBufferMinor: 200000,
    reportingCurrency: "INR",
    approval: {
      mode: "hard",
      slaMinutes: 120,
      maxEscalations: 2,
      justificationReasons: JUSTIFICATION_REASONS,
      fallbackApproverEmails: [],
    },
    advisories: [],
    updatedAt: "2026-06-01T00:00:00.000Z",
    updatedBy: "admin@acme.test",
    ...over,
  };
}

/** A verdict exactly as Slice 1 stored it: no evaluatorVersion, overage, fxPin or advisory. */
export const SLICE1_IN_VERDICT: PolicyVerdict = {
  state: "in",
  reasonCode: "within_cap",
  reason: "₹8,700/night is within your ₹9,000 metro cap",
  policyVersion: 1,
  capPerNight: money(900000, "INR"),
  overageMinor: null,
};

export function booking(over: Partial<Booking> = {}): Booking {
  const offer = over.offer ?? { property: property(), rate: rate() };
  const total = offer.rate.allInTotal;
  return {
    id: "bkg_1",
    confirmationCode: "7KQM4Z",
    travellerId: "trv_asha",
    entityId: "acme",
    state: "confirmed",
    offer,
    commute: { minutes: 7, mode: "walk", distanceMeters: 559 },
    verdict: SLICE1_IN_VERDICT,
    anchor: {
      label: "BKC",
      geo: offer.property.geo,
      city: offer.property.city,
      countryCode: offer.property.countryCode,
    },
    costCentre: "ENG-OPS",
    card: null,
    cancellationDeadline: "2026-06-09T12:30:00.000Z",
    createdAt: "2026-06-01T10:00:00.000Z",
    cancelledAt: null,
    idempotencyKey: "11111111-2222-3333-4444-555555555555",
    supplierBookingRef: "SUP-1",
    amounts: {
      supplier: total,
      display: { from: total, to: total, fx: null },
      settlement: { from: total, to: total, fx: null },
    },
    approvalId: null,
    hold: null,
    confirmedAt: "2026-06-01T10:00:05.000Z",
    checkInTime: "14:00",
    cancellationReason: null,
    replaces: null,
    replacedBy: null,
    settledAt: null,
    invoiceId: null,
    ...over,
  };
}

export function traveller(over: Partial<Traveller> = {}): Traveller {
  return {
    id: "trv_asha",
    email: "asha@acme.test",
    name: "Asha Rao",
    entityId: "acme",
    defaultCostCentre: "ENG-OPS",
    isAdmin: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    managerId: null,
    displayCurrency: null,
    erasedAt: null,
    ...over,
  };
}

/** A monthly pin: `rateMicros` quote units per one base unit, × 1e6. */
export function pin(base: string, quote: string, rateMicros: number, over: Partial<FxRate> = {}): FxRate {
  return {
    base,
    quote,
    rateMicros,
    source: "pinned_monthly",
    pinMonth: "2026-09",
    asOf: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}
