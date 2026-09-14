/**
 * First-boot seeding and the demo data set.
 *
 * `seedBase` runs on every instance boot and only writes what is absent: the
 * `acme` entity, policy v2, and (on first boot) the current month's FX pins.
 * `seedDemo` runs only when `SM_DEMO=1` and is idempotent across concurrent
 * instances: deterministic ids plus an atomic idempotency-key claim per step.
 */

import { openApproval, resolveApproverChain } from "../core/approval.ts";
import { estimateCommute } from "../core/commute.ts";
import { pinMonthOf } from "../core/fx.ts";
import { gstinCheckDigit } from "../core/gst.ts";
import { newConfirmationCode } from "../core/ids.ts";
import { money } from "../core/money.ts";
import { evaluate } from "../core/policy.ts";
import type {
  ApprovalPolicy,
  Booking,
  FxRate,
  IsoMonth,
  LegalEntity,
  Offer,
  Policy,
  PolicyState,
  PolicyVerdict,
  SearchQuery,
  Traveller,
} from "../core/types.ts";
import type { Store } from "../store/Store.ts";
import { notifyApprovalRequested } from "./approvals.ts";
import { DEFAULT_ENTITY_ID, normaliseEmail } from "./auth.ts";
import { issueInvoiceFor } from "./cron.ts";
import type { AppDeps } from "./deps.ts";
import { NOT_HELD_MESSAGE } from "./bookings-service.ts";
import { addDays, checkoutInstant, dateIn, errorMessage } from "./time.ts";

// ---------- entity, policy, pins ----------

export function defaultEntity(): LegalEntity {
  const first14 = "27AAACA1234A1Z";
  return {
    id: DEFAULT_ENTITY_ID,
    legalName: "ACME Travel Pvt Ltd",
    gstin: `${first14}${gstinCheckDigit(first14)}`,
    stateCode: "27",
    address: "9th Floor, Meridian Works, G Block, Bandra Kurla Complex, Mumbai 400051, Maharashtra",
    settlementCurrency: "INR",
    reportingCurrency: "INR",
    invoiceSeriesPrefix: "ACME",
  };
}

export function defaultApprovalPolicy(): ApprovalPolicy {
  return {
    mode: "hard",
    slaMinutes: 120,
    maxEscalations: 2,
    justificationReasons: [
      { code: "client_site", label: "Client or meeting is at this hotel" },
      { code: "no_inventory", label: "Nothing in policy near the meeting" },
      { code: "late_change", label: "Plans changed at short notice" },
      { code: "safety", label: "Safety or security" },
      { code: "accessibility", label: "Accessibility need" },
    ],
    fallbackApproverEmails: [],
  };
}

/**
 * Slice 1 caps, plus Singapore and Dubai caps authored in their own currencies.
 * London deliberately has only an INR cap, so a GBP rate there is checked through
 * the monthly pinned conversion.
 */
export function defaultPolicy(now: Date): Policy {
  return {
    version: 1,
    entityId: DEFAULT_ENTITY_ID,
    caps: [
      { cityTier: "metro", city: "Mumbai", perNight: money(900_000, "INR") },
      { cityTier: "metro", city: "Bengaluru", perNight: money(850_000, "INR") },
      { cityTier: "metro", city: "Gurugram", perNight: money(800_000, "INR") },
      { cityTier: "tier1", city: "Hyderabad", perNight: money(700_000, "INR") },
      { cityTier: "tier1", city: "Pune", perNight: money(650_000, "INR") },
      { cityTier: "metro", city: null, perNight: money(900_000, "INR") },
      { cityTier: "tier1", city: null, perNight: money(700_000, "INR") },
      { cityTier: "tier2", city: null, perNight: money(500_000, "INR") },
      { cityTier: "global", city: "Singapore", perNight: money(45_000, "SGD") },
      { cityTier: "global", city: "Dubai", perNight: money(140_000, "AED") },
      { cityTier: "global", city: "London", perNight: money(4_500_000, "INR") },
    ],
    requireFlexible: false,
    blockedCountries: [],
    blockedSuppliers: [],
    costCentres: ["ENG-OPS", "SALES", "FINANCE"],
    defaultCostCentre: "ENG-OPS",
    incidentalsBufferMinor: 200_000,
    reportingCurrency: "INR",
    approval: defaultApprovalPolicy(),
    advisories: [
      {
        countryCode: "AE",
        city: "Dubai",
        level: "caution",
        note: "Regional tension: check in with the travel desk on arrival and keep your itinerary current.",
        updatedAt: now.toISOString(),
      },
    ],
    updatedAt: now.toISOString(),
    updatedBy: "system@seed",
  };
}

/** Corporate monthly rates, quote INR. 1 GBP = ₹106.25 matches the policy reason examples. */
export function defaultFxPins(month: IsoMonth, now: Date): FxRate[] {
  const pin = (base: string, rateMicros: number): FxRate => ({
    base,
    quote: "INR",
    rateMicros,
    source: "pinned_monthly",
    pinMonth: month,
    asOf: now.toISOString(),
  });
  return [
    pin("USD", 83_500_000),
    pin("EUR", 90_750_000),
    pin("GBP", 106_250_000),
    pin("AED", 22_730_000),
    pin("SGD", 62_000_000),
  ];
}

/** A Slice 1 policy record lacks the Slice 2 fields; carry its values forward into a new version. */
export function needsUpgrade(p: Policy): boolean {
  const loose = p as Partial<Policy>;
  return loose.approval === undefined || loose.reportingCurrency === undefined || loose.advisories === undefined;
}

export function upgradePolicy(p: Policy, now: Date): Policy {
  const d = defaultPolicy(now);
  const loose = p as Partial<Policy>;
  return {
    ...p,
    version: p.version + 1,
    reportingCurrency: loose.reportingCurrency ?? d.reportingCurrency,
    approval: loose.approval ?? d.approval,
    advisories: loose.advisories ?? d.advisories,
    updatedAt: now.toISOString(),
    updatedBy: "system@upgrade",
  };
}

export async function seedBase(deps: { store: Store; now: () => Date }): Promise<void> {
  const now = deps.now();
  const store = deps.store;
  const firstBoot = (await store.getEntity(DEFAULT_ENTITY_ID)) === null;
  if (firstBoot) await store.putEntity(defaultEntity());

  const policy = await store.getCurrentPolicy(DEFAULT_ENTITY_ID);
  if (policy === null) await store.savePolicy(defaultPolicy(now));
  else if (needsUpgrade(policy)) await store.savePolicy(upgradePolicy(policy, now));

  if (firstBoot) {
    const month = pinMonthOf(now);
    if ((await store.getFxPins(month)).length === 0) await store.putFxPins(month, defaultFxPins(month, now));
  }
}

// ---------- demo ----------

export interface DemoPersona {
  readonly email: string;
  readonly name: string;
  readonly role: "traveller" | "manager" | "admin";
  readonly blurb: string;
}

export const DEMO_PERSONAS: readonly DemoPersona[] = [
  { email: "asha@acme.test", name: "Asha Rao", role: "traveller", blurb: "Books her own trips · reports to Meera" },
  { email: "meera@acme.test", name: "Meera Iyer", role: "manager", blurb: "Approves over-cap requests · reports to Vikram" },
  { email: "admin@acme.test", name: "Travel Admin", role: "admin", blurb: "Owns policy, the directory and data rights" },
];

const DEMO_DIRECTORY = [
  { key: "vikram", email: "vikram@acme.test", name: "Vikram Mehta", manager: null, isAdmin: false },
  { key: "meera", email: "meera@acme.test", name: "Meera Iyer", manager: "vikram", isAdmin: false },
  { key: "asha", email: "asha@acme.test", name: "Asha Rao", manager: "meera", isAdmin: false },
  { key: "admin", email: "admin@acme.test", name: "Travel Admin", manager: null, isAdmin: true },
] as const;

export const DEMO_PAST_BOOKING_ID = "bkg_demo_past_stay";
export const DEMO_PENDING_BOOKING_ID = "bkg_demo_pending";
export const DEMO_PENDING_APPROVAL_ID = "apr_demo_pending";

const CANARY_ID = /~(DRIFT|SOLDOUT|LATEDRIFT)$/;

async function withSeedLock(store: Store, key: string, now: Date, fn: () => Promise<string | null>): Promise<void> {
  const claim = await store.reserveIdempotencyKey({
    key,
    travellerId: "system",
    requestHash: "seed",
    createdAt: now.toISOString(),
  });
  if (!claim.reserved) return;
  let done = false;
  try {
    const id = await fn();
    if (id !== null) {
      await store.completeIdempotencyKey(key, id);
      done = true;
    }
  } finally {
    if (!done) await store.releaseIdempotencyKey(key).catch(() => undefined);
  }
}

async function upsertDemoDirectory(deps: AppDeps): Promise<Map<string, Traveller>> {
  const now = deps.now();
  const people = new Map<string, Traveller>();
  for (const spec of DEMO_DIRECTORY) {
    const managerId = spec.manager === null ? null : (people.get(spec.manager)?.id ?? null);
    const existing = await deps.store.getTravellerByEmail(normaliseEmail(spec.email));
    if (existing !== null) {
      // The demo cast is authoritative: a person who signed in before seeding finished
      // was JIT-created with a guessed name and possibly the first-user admin flag.
      // Write only when something actually differs, because on Blob every write is a
      // network round trip on a cold instance.
      const unchanged =
        existing.managerId === managerId && existing.isAdmin === spec.isAdmin && existing.name === spec.name;
      const next = unchanged
        ? existing
        : await deps.store.mutateTraveller(existing.id, (cur) => ({
            ...cur,
            name: spec.name,
            managerId,
            isAdmin: spec.isAdmin,
          }));
      people.set(spec.key, next);
    } else {
      const created: Traveller = {
        id: `trv_demo_${spec.key}`,
        email: spec.email,
        name: spec.name,
        entityId: DEFAULT_ENTITY_ID,
        defaultCostCentre: "ENG-OPS",
        isAdmin: spec.isAdmin,
        createdAt: now.toISOString(),
        managerId,
        displayCurrency: null,
        erasedAt: null,
      };
      await deps.store.putTraveller(created);
      people.set(spec.key, created);
    }
  }
  return people;
}

async function pickOffer(
  deps: AppDeps,
  query: SearchQuery,
  policy: Policy,
  state: PolicyState,
): Promise<{ offer: Offer; verdict: PolicyVerdict } | null> {
  const now = deps.now();
  const pinMonth = pinMonthOf(now);
  const pins = await deps.store.getFxPins(pinMonth);
  const answers = await Promise.allSettled(
    deps.sources.map((s) => s.searchAvailability(query, AbortSignal.timeout(3_000))),
  );
  const candidates: Array<{ offer: Offer; verdict: PolicyVerdict; minutes: number }> = [];
  for (const answer of answers) {
    if (answer.status !== "fulfilled") continue;
    for (const offer of answer.value) {
      if (CANARY_ID.test(offer.rate.id)) continue;
      if (offer.property.countryCode !== "IN" || offer.rate.currency !== "INR") continue;
      try {
        const verdict = evaluate({ rate: offer.rate, property: offer.property, policy, fxPins: pins, pinMonth });
        if (verdict.state !== state) continue;
        candidates.push({ offer, verdict, minutes: estimateCommute(query.anchor.geo, offer.property.geo).minutes });
      } catch {
        // skip
      }
    }
  }
  candidates.sort((a, b) => a.minutes - b.minutes || (a.offer.rate.id < b.offer.rate.id ? -1 : 1));
  const best = candidates[0];
  return best === undefined ? null : { offer: best.offer, verdict: best.verdict };
}

function demoBooking(args: {
  id: string;
  traveller: Traveller;
  offer: Offer;
  verdict: PolicyVerdict;
  query: SearchQuery;
  createdAt: string;
}): Booking {
  const total = args.offer.rate.allInTotal;
  return {
    id: args.id,
    confirmationCode: newConfirmationCode(),
    travellerId: args.traveller.id,
    entityId: args.traveller.entityId,
    state: "searched",
    offer: structuredClone(args.offer),
    commute: estimateCommute(args.query.anchor.geo, args.offer.property.geo),
    verdict: structuredClone(args.verdict),
    anchor: args.query.anchor,
    costCentre: args.traveller.defaultCostCentre,
    card: null,
    cancellationDeadline: args.offer.rate.refundableUntil,
    createdAt: args.createdAt,
    cancelledAt: null,
    idempotencyKey: `seed-${args.id}`,
    supplierBookingRef: null,
    amounts: {
      supplier: total,
      display: { from: total, to: total, fx: null },
      settlement: { from: total, to: total, fx: null },
    },
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
}

/** Idempotent. Does nothing unless `deps.demo` is on. */
export async function seedDemo(deps: AppDeps): Promise<void> {
  if (!deps.demo) return;
  await seedBase(deps);
  // Every cold serverless instance runs this. Once the demo stay and the pending
  // request both exist the cast is already in place, so stop after two reads rather
  // than re-writing the directory on every cold start: those writes are what made
  // the first request on a new instance take twenty seconds.
  const [pastStay, pendingStay] = await Promise.all([
    deps.store.getBooking(DEMO_PAST_BOOKING_ID),
    deps.store.getBooking(DEMO_PENDING_BOOKING_ID),
  ]);
  if (pastStay !== null && pendingStay !== null) return;
  const people = await upsertDemoDirectory(deps);
  const asha = people.get("asha");
  if (asha === undefined) return;
  const policy = await deps.store.getCurrentPolicy(DEFAULT_ENTITY_ID);
  if (policy === null) return;
  const anchor = deps.resolveAnchor("bkc") ?? deps.knownAnchors[0];
  if (anchor === undefined) return;
  const now = deps.now();
  const today = dateIn(now, "Asia/Kolkata");

  try {
    if ((await deps.store.getBooking(DEMO_PAST_BOOKING_ID)) === null) {
      await withSeedLock(deps.store, "seed:demo:past-stay", now, async () => {
        const query: SearchQuery = { anchor, checkIn: addDays(today, -10), checkOut: addDays(today, -7), guests: 1, rooms: 1 };
        const picked = await pickOffer(deps, query, policy, "in");
        if (picked === null) return null;
        const total = picked.offer.rate.allInTotal;
        const createdAt = new Date(Date.parse(`${query.checkIn}T06:00:00.000Z`) - 14 * 86_400_000).toISOString();
        const settledAt = new Date(checkoutInstant(query.checkOut, picked.offer.property.timeZone).getTime() + 3_600_000);
        const booking: Booking = {
          ...demoBooking({ id: DEMO_PAST_BOOKING_ID, traveller: asha, offer: picked.offer, verdict: picked.verdict, query, createdAt }),
          state: "settled",
          card: {
            tokenRef: "tok_demo_past_stay",
            last4: "4417",
            brand: "Sandbox Network",
            expMonth: Number(addDays(query.checkOut, 1).slice(5, 7)),
            expYear: Number(addDays(query.checkOut, 1).slice(0, 4)),
            authorisedTotal: total,
            incidentalsBufferMinor: policy.incidentalsBufferMinor,
            issuerId: "demo-seed",
            validFrom: addDays(query.checkIn, -1),
            validUntil: addDays(query.checkOut, 1),
          },
          supplierBookingRef: "demo-past-stay",
          confirmedAt: createdAt,
          checkInTime: "14:00",
          settledAt: settledAt.toISOString(),
        };
        await deps.store.putBooking(booking);
        await issueInvoiceFor(deps, booking, now);
        return booking.id;
      });
    }

    const meera = people.get("meera");
    if (meera !== undefined && (await deps.store.getBooking(DEMO_PENDING_BOOKING_ID)) === null) {
      await withSeedLock(deps.store, "seed:demo:pending", now, async () => {
        const query: SearchQuery = { anchor, checkIn: addDays(today, 14), checkOut: addDays(today, 17), guests: 1, rooms: 1 };
        const picked = await pickOffer(deps, query, policy, "over");
        if (picked === null) return null;
        const openedAt = new Date(now.getTime() - 25 * 60_000);
        const booking: Booking = {
          ...demoBooking({
            id: DEMO_PENDING_BOOKING_ID,
            traveller: asha,
            offer: picked.offer,
            verdict: picked.verdict,
            query,
            createdAt: openedAt.toISOString(),
          }),
          state: "pending_approval",
          approvalId: DEMO_PENDING_APPROVAL_ID,
          hold: { held: false, supplierHoldRef: null, heldUntil: null, message: NOT_HELD_MESSAGE },
        };
        const directory = await deps.store.listTravellers(DEFAULT_ENTITY_ID);
        const chain = resolveApproverChain({ traveller: asha, directory, policy });
        if (chain.length === 0) return null;
        const approval = openApproval({
          id: DEMO_PENDING_APPROVAL_ID,
          booking,
          justification: { code: "client_site", text: "The client workshop is in this building all three days." },
          chain,
          policy,
          now: openedAt,
        });
        await deps.store.putApproval(approval);
        await deps.store.putBooking(booking);
        await notifyApprovalRequested(deps, approval, booking, asha);
        return booking.id;
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`seedDemo: ${errorMessage(err)}`);
  }
}
