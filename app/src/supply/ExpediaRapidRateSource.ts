/**
 * Expedia Rapid (EPS) supply, behind the same RateSource port as the fixtures.
 *
 * Gate S1 is the claim that swapping to this adapter changes nothing above the
 * port. `tests/acceptance/S1-supply-swap.test.ts` proves exactly that against an
 * in-process mock of the Rapid shapes implemented here. S2 and S3 — parity and
 * card acceptance on LIVE Rapid inventory — need Expedia Partner Solutions
 * credentials and cannot be claimed from a mock.
 *
 * Grounding. Verified against Expedia's public docs: the signature scheme (SHA-512
 * of apiKey + sharedSecret + unix seconds), `GET /v3/properties/availability` and
 * its query parameters, and the `occupancy_pricing[occ].totals.inclusive.
 * request_currency` pricing shape. Everything else is marked `UNVERIFIED:` and
 * must be confirmed in the Rapid sandbox before live traffic.
 *
 * Statelessness. Production is serverless, so an offer id carries the property id
 * and the price-check link inside itself, and a supplier booking ref carries the
 * cancel link. No instance needs to remember a search to book from it.
 *
 * Card data (A13). Rapid can take card details in a booking request. This adapter
 * never does: it books on a payment type that carries no card number, and refuses
 * at construction to be configured with one that would.
 */
import { createHash } from "node:crypto";

import { exponentOf } from "../core/fx.ts";
import { money } from "../core/money.ts";
import type { Anchor, Currency, Money, Offer, OfferId, Property, Rate, RateComponent, SearchQuery } from "../core/types.ts";
import { nightsBetween } from "../core/commute.ts";
import type { RateSource, SupplierBookRequest, SupplierBooking } from "./RateSource.ts";
import {
  SupplierHoldUnsupportedError,
  SupplierPriceDriftError,
  SupplierSoldOutError,
  SupplierUnavailableError,
} from "./RateSource.ts";

export const RAPID_SOURCE_ID = "expedia-rapid";

/** Payment types that would put a card number in the booking request. Refused (A13). */
const CARD_BEARING_PAYMENT_TYPES = new Set(["customer_card", "corporate_card", "virtual_card"]);

export interface RapidConfig {
  readonly apiKey: string;
  readonly sharedSecret: string;
  /** https://test.ean.com (sandbox) or https://api.ean.com (production). */
  readonly baseUrl: string;
  readonly customerIp: string;
  readonly posCountryCode: string;
  readonly language: string;
  readonly currency: Currency;
  readonly salesChannel: string;
  readonly salesEnvironment: string;
  /** Candidate Rapid property ids near an anchor, from the geography/content pipeline. */
  readonly propertyIdsForAnchor: (anchor: Anchor) => Promise<string[]>;
  /** Static property content, cached out of band (spec §3.1: cache content, never price). */
  readonly propertyFor: (propertyId: string) => Property | null;
  /** UNVERIFIED: Rapid's enum for affiliate-collect/invoiced payment. Must not carry a card. */
  readonly paymentType?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

/** `Authorization` header value for a Rapid request (verified against the signature-authentication docs). */
export function rapidAuthorizationHeader(apiKey: string, sharedSecret: string, unixSeconds: number): string {
  const signature = createHash("sha512").update(`${apiKey}${sharedSecret}${unixSeconds}`).digest("hex");
  return `EAN APIKey=${apiKey},Signature=${signature},timestamp=${unixSeconds}`;
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function unb64(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** A decimal string such as "12345.60" to integer minor units, exactly — no float. */
export function decimalToMinor(value: string, currency: Currency): number {
  const exp = exponentOf(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) throw new Error(`not a decimal amount: "${value}"`);
  const fraction = (match[3] ?? "").padEnd(exp, "0");
  if (fraction.length > exp && /[1-9]/.test(fraction.slice(exp))) {
    throw new Error(`"${value}" has more precision than ${currency} allows`);
  }
  const minor = Number(`${match[2]}${fraction.slice(0, exp)}`);
  return match[1] === "-" ? -minor : minor;
}

interface RapidAmount {
  readonly value: string;
  readonly currency: string;
}

interface RapidTotals {
  readonly inclusive?: { readonly request_currency?: RapidAmount };
  /** UNVERIFIED: the pre-tax total used here as the room charge. */
  readonly exclusive?: { readonly request_currency?: RapidAmount };
}

interface RapidRate {
  readonly id: string;
  readonly refundable?: boolean;
  /** UNVERIFIED: the earliest penalty `start` is taken as the end of free cancellation. */
  readonly cancel_penalties?: ReadonlyArray<{ readonly start?: string }>;
  readonly occupancy_pricing?: Readonly<Record<string, { readonly totals?: RapidTotals }>>;
  readonly links?: { readonly price_check?: { readonly href?: string } };
}

interface RapidProperty {
  readonly property_id: string;
  readonly rooms?: ReadonlyArray<{ readonly id: string; readonly room_name?: string; readonly rates?: readonly RapidRate[] }>;
}

interface OfferRef {
  readonly propertyId: string;
  readonly priceCheckHref: string;
}

function encodeOfferId(ref: OfferRef): OfferId {
  return `rapid~${ref.propertyId}~${b64(ref.priceCheckHref)}`;
}

function decodeOfferId(offerId: OfferId): OfferRef | null {
  const parts = offerId.split("~");
  if (parts.length !== 3 || parts[0] !== "rapid" || parts[1] === undefined || parts[2] === undefined) return null;
  return { propertyId: parts[1], priceCheckHref: unb64(parts[2]) };
}

export function createExpediaRapidRateSource(cfg: RapidConfig): RateSource {
  const paymentType = cfg.paymentType ?? "affiliate_collect";
  if (CARD_BEARING_PAYMENT_TYPES.has(paymentType)) {
    throw new Error(`Rapid payment type "${paymentType}" would send card details to Expedia; refused (A13)`);
  }
  const doFetch = cfg.fetch ?? fetch;
  const now = cfg.now ?? (() => new Date());
  const timeoutMs = cfg.timeoutMs ?? 8_000;

  async function call(method: string, pathOrHref: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const url = pathOrHref.startsWith("http") ? pathOrHref : `${cfg.baseUrl}${pathOrHref}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        signal: combined,
        headers: {
          Authorization: rapidAuthorizationHeader(cfg.apiKey, cfg.sharedSecret, Math.floor(now().getTime() / 1000)),
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "User-Agent": "StrictMode/2.0",
          // UNVERIFIED: header name for the traveller's IP.
          "Customer-Ip": cfg.customerIp,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      if (signal?.aborted === true) throw err;
      throw new SupplierUnavailableError(RAPID_SOURCE_ID, `Rapid request failed: ${(err as Error).message}`);
    }
    if (res.status === 401 || res.status === 403 || res.status >= 500) {
      throw new SupplierUnavailableError(RAPID_SOURCE_ID, `Rapid answered ${res.status}`, res.status);
    }
    return res;
  }

  function toMoney(amount: RapidAmount | undefined, fallbackCurrency: Currency): Money | null {
    if (amount === undefined) return null;
    const currency = amount.currency || fallbackCurrency;
    return money(decimalToMinor(amount.value, currency), currency);
  }

  function buildRate(
    property: Property,
    query: SearchQuery,
    rate: RapidRate,
    roomName: string,
    priceCheckHref: string,
  ): Rate | null {
    const occupancy = String(query.guests);
    const totals = rate.occupancy_pricing?.[occupancy]?.totals ?? Object.values(rate.occupancy_pricing ?? {})[0]?.totals;
    const inclusive = toMoney(totals?.inclusive?.request_currency, cfg.currency);
    if (inclusive === null) return null;
    const exclusive = toMoney(totals?.exclusive?.request_currency, inclusive.currency) ?? inclusive;
    const nights = Math.max(1, nightsBetween(query.checkIn, query.checkOut));

    const components: RateComponent[] = [{ kind: "base", label: roomName, amount: exclusive }];
    const taxMinor = inclusive.minor - exclusive.minor;
    if (taxMinor > 0) components.push({ kind: "tax", label: "Taxes and fees", amount: money(taxMinor, inclusive.currency) });

    const penaltyStarts = (rate.cancel_penalties ?? [])
      .map((p) => p.start)
      .filter((s): s is string => typeof s === "string")
      .sort();
    const refundableUntil = rate.refundable === true ? penaltyStarts[0] ?? null : null;

    return {
      id: encodeOfferId({ propertyId: property.id, priceCheckHref }),
      propertyId: property.id,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      nights,
      currency: inclusive.currency,
      components,
      allInTotal: inclusive,
      perNight: money(Math.floor(inclusive.minor / nights), inclusive.currency),
      tariffPerNight: money(Math.floor(exclusive.minor / nights), inclusive.currency),
      breakfastIncluded: false, // UNVERIFIED: amenity mapping from rate amenities is not implemented.
      refundableUntil,
      channel: "public",
      supplierRef: rate.id,
      sourceId: RAPID_SOURCE_ID,
      holdable: false,
    };
  }

  /** UNVERIFIED: price-check response shape — `status` plus the same occupancy_pricing, and `links.book.href`. */
  interface PriceCheckBody {
    readonly status?: string;
    readonly occupancy_pricing?: RapidRate["occupancy_pricing"];
    readonly links?: { readonly book?: { readonly href?: string } };
  }

  async function priceCheckRaw(offerId: OfferId, query: SearchQuery): Promise<{ offer: Offer; bookHref: string } | null> {
    const ref = decodeOfferId(offerId);
    if (ref === null) return null;
    const property = cfg.propertyFor(ref.propertyId);
    if (property === null) return null;
    const res = await call("GET", ref.priceCheckHref);
    if (res.status === 404 || res.status === 410) return null;
    const body = (await res.json()) as PriceCheckBody;
    if (body.status === "sold_out") return null;
    const rate = buildRate(
      property,
      query,
      { id: offerId, refundable: true, occupancy_pricing: body.occupancy_pricing },
      "Room charge",
      ref.priceCheckHref,
    );
    const bookHref = body.links?.book?.href;
    if (rate === null || bookHref === undefined) return null;
    return { offer: { property, rate: { ...rate, id: offerId } }, bookHref };
  }

  return {
    id: RAPID_SOURCE_ID,
    displayName: "Expedia Rapid",
    capabilities: { holds: false, maxHoldMinutes: 0, live: true, currencies: "any" },

    async searchAvailability(query, signal) {
      const ids = await cfg.propertyIdsForAnchor(query.anchor);
      if (ids.length === 0) return [];
      const params = new URLSearchParams({
        checkin: query.checkIn,
        checkout: query.checkOut,
        currency: cfg.currency,
        country_code: cfg.posCountryCode,
        language: cfg.language,
        rate_plan_count: "1",
        sales_channel: cfg.salesChannel,
        sales_environment: cfg.salesEnvironment,
      });
      for (let room = 0; room < query.rooms; room++) params.append("occupancy", String(query.guests));
      for (const id of ids) params.append("property_id", id);

      const res = await call("GET", `/v3/properties/availability?${params.toString()}`, undefined, signal);
      if (res.status === 404) return [];
      const properties = (await res.json()) as RapidProperty[];

      const offers: Offer[] = [];
      for (const rp of properties) {
        const property = cfg.propertyFor(rp.property_id);
        if (property === null) continue;
        for (const room of rp.rooms ?? []) {
          for (const rate of room.rates ?? []) {
            const href = rate.links?.price_check?.href;
            if (href === undefined) continue;
            const built = buildRate(property, query, rate, room.room_name ?? "Room charge", href);
            if (built !== null) offers.push({ property, rate: built });
          }
        }
      }
      return offers;
    },

    async priceCheck(offerId, query) {
      const checked = await priceCheckRaw(offerId, query);
      return checked === null ? null : checked.offer;
    },

    async hold() {
      // Rapid supports holding a booking (hold + resume), but not a price hold while an
      // approval is pending in the sense this port means. Honest, not pretended.
      throw new SupplierHoldUnsupportedError("Expedia Rapid rates are not held while an approval is pending");
    },

    async releaseHold() {
      // Nothing is ever held.
    },

    async book(req: SupplierBookRequest): Promise<SupplierBooking> {
      const checked = await priceCheckRaw(req.offerId, req.query);
      if (checked === null) throw new SupplierSoldOutError();
      const current = checked.offer.rate.allInTotal;
      if (current.currency !== req.authorisedTotal.currency || current.minor !== req.authorisedTotal.minor) {
        throw new SupplierPriceDriftError(current, req.authorisedTotal);
      }
      const [given, ...rest] = req.travellerName.trim().split(/\s+/);
      // UNVERIFIED: create-itinerary body field names and the affiliate-collect payment enum.
      const res = await call("POST", checked.bookHref, {
        affiliate_reference_id: req.correlationId.slice(0, 28),
        hold: false,
        email: req.travellerEmail,
        rooms: [{ given_name: given ?? req.travellerName, family_name: rest.join(" ") || given || req.travellerName }],
        payments: [{ type: paymentType }],
      });
      if (res.status === 409 || res.status === 410) throw new SupplierSoldOutError();
      if (!res.ok) throw new SupplierUnavailableError(RAPID_SOURCE_ID, `Rapid booking answered ${res.status}`, res.status);
      const body = (await res.json()) as { itinerary_id?: string; links?: { cancel?: { href?: string } } };
      if (body.itinerary_id === undefined) {
        throw new SupplierUnavailableError(RAPID_SOURCE_ID, "Rapid booking returned no itinerary id");
      }
      const cancelHref = body.links?.cancel?.href ?? "";
      return {
        supplierBookingRef: `${body.itinerary_id}~${b64(cancelHref)}`,
        confirmedTotal: current,
        cancellationDeadline: checked.offer.rate.refundableUntil,
        checkInTime: "14:00", // UNVERIFIED: check-in time comes from Rapid content, not shopping.
      };
    },

    async cancel(supplierBookingRef: string) {
      const [, encoded] = supplierBookingRef.split("~");
      const href = encoded === undefined ? "" : unb64(encoded);
      if (href === "") throw new SupplierUnavailableError(RAPID_SOURCE_ID, "No Rapid cancel link was recorded for this booking");
      // UNVERIFIED: cancellation is a DELETE on the itinerary/room link.
      const res = await call("DELETE", href);
      if (!res.ok && res.status !== 404) {
        throw new SupplierUnavailableError(RAPID_SOURCE_ID, `Rapid cancel answered ${res.status}`, res.status);
      }
    },
  };
}
