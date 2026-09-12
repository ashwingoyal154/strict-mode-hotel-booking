import { readFileSync } from "node:fs";

import type { Booking, Policy, PolicyCap, Property, Rate } from "../../src/core/types.ts";
import { CurrencyMismatchError, money } from "../../src/core/money.ts";
import {
  POLICY_EVALUATOR_VERSION,
  capFor,
  evaluate,
  replay,
} from "../../src/core/policy.ts";

// ---------- builders ----------

function property(over: Partial<Property> = {}): Property {
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
    ...over,
  };
}

/** ₹8,700/night over four nights = ₹34,800 all-in, the worked example in MODULE_EXPORTS. */
function rate(over: Partial<Rate> = {}): Rate {
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
    breakfastIncluded: true,
    refundableUntil: "2026-06-09T12:30:00.000Z",
    channel: "public",
    supplierRef: "sup-1",
    sourceId: "src_a",
    ...over,
  };
}

function policy(over: Partial<Policy> = {}): Policy {
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
    updatedAt: "2026-06-01T00:00:00.000Z",
    updatedBy: "admin@acme.test",
    ...over,
  };
}

/**
 * A policy whose Mumbai cap is a named-city override, which is the shape that
 * produces the city-labelled reason strings quoted in MODULE_EXPORTS.
 */
function mumbaiCap(minor: number): Policy {
  return policy({ caps: [{ cityTier: "metro", city: "Mumbai", perNight: money(minor, "INR") }] });
}

function booking(over: Partial<Booking> = {}): Booking {
  const p = property();
  const r = rate();
  return {
    id: "bkg_1",
    confirmationCode: "7KQM4Z",
    travellerId: "trv_1",
    entityId: "acme",
    state: "confirmed",
    offer: { property: p, rate: r },
    commute: { minutes: 7, mode: "walk", distanceMeters: 559 },
    verdict: evaluate({ rate: r, property: p, policy: policy() }),
    anchor: { label: "Bandra Kurla Complex", geo: p.geo, city: "Mumbai", countryCode: "IN" },
    costCentre: "ENG-OPS",
    card: null,
    cancellationDeadline: "2026-06-09T12:30:00.000Z",
    createdAt: "2026-06-01T10:00:00.000Z",
    cancelledAt: null,
    idempotencyKey: "11111111-2222-3333-4444-555555555555",
    supplierBookingRef: "SUP-1",
    ...over,
  };
}

// ---------- caps ----------

describe("capFor", () => {
  it("resolves the cap for the property's city tier", () => {
    expect(capFor(policy(), property())).toEqual(money(900000, "INR"));
    expect(capFor(policy(), property({ cityTier: "tier2" }))).toEqual(money(500000, "INR"));
  });

  it("lets a named-city override beat the tier cap", () => {
    const withOverride = policy({
      caps: [
        { cityTier: "metro", city: null, perNight: money(900000, "INR") },
        { cityTier: "metro", city: "Mumbai", perNight: money(800000, "INR") },
      ],
    });
    expect(capFor(withOverride, property())).toEqual(money(800000, "INR"));
  });

  it("applies a city override only to that city", () => {
    const withOverride = policy({
      caps: [
        { cityTier: "metro", city: null, perNight: money(900000, "INR") },
        { cityTier: "metro", city: "Mumbai", perNight: money(800000, "INR") },
      ],
    });
    expect(capFor(withOverride, property({ city: "Delhi" }))).toEqual(money(900000, "INR"));
  });

  it("returns null when the policy authors no cap for this market", () => {
    expect(capFor(policy({ caps: [] }), property())).toBeNull();
    expect(capFor(policy(), property({ cityTier: "resort" }))).toBeNull();
  });
});

// ---------- the five reason strings, byte for byte ----------

describe("evaluate — reason strings are the stored record (A12)", () => {
  it("within_cap reads exactly as specified", () => {
    const verdict = evaluate({ rate: rate(), property: property(), policy: mumbaiCap(900000) });
    expect(verdict.state).toBe("in");
    expect(verdict.reasonCode).toBe("within_cap");
    expect(verdict.reason).toBe("₹8,700/night is within your ₹9,000 Mumbai cap");
    expect(verdict.capPerNight).toEqual(money(900000, "INR"));
    expect(verdict.overageMinor).toBeNull();
  });

  it("labels an in-policy verdict with the tier when the cap is a tier cap", () => {
    // The seeded policy authors caps per tier, so this is the common production shape.
    const verdict = evaluate({ rate: rate(), property: property(), policy: policy() });
    expect(verdict.reason).toBe("₹8,700/night is within your ₹9,000 metro cap");
  });

  it("over_cap reads exactly as specified, em dash and all", () => {
    const verdict = evaluate({ rate: rate(), property: property(), policy: mumbaiCap(800000) });
    expect(verdict.state).toBe("blocked");
    expect(verdict.reasonCode).toBe("over_cap");
    expect(verdict.reason).toBe(
      "₹8,700/night is over your ₹8,000 Mumbai cap by ₹700 — ₹2,800 for 4 nights",
    );
    expect(verdict.reason).toContain("—"); // em dash, not a hyphen
    expect(verdict.capPerNight).toEqual(money(800000, "INR"));
    expect(verdict.overageMinor).toBe(70000);
  });

  it("blocked_country reads exactly as specified", () => {
    const verdict = evaluate({
      rate: rate(),
      property: property({ countryCode: "AE", city: "Dubai", cityTier: "metro" }),
      policy: policy({ blockedCountries: ["AE"] }),
    });
    expect(verdict.state).toBe("blocked");
    expect(verdict.reasonCode).toBe("blocked_country");
    expect(verdict.reason).toBe("Bookings in AE are blocked by your travel policy");
    expect(verdict.capPerNight).toBeNull();
    expect(verdict.overageMinor).toBeNull();
  });

  it("blocked_supplier reads exactly as specified", () => {
    const verdict = evaluate({
      rate: rate({ sourceId: "src_rogue" }),
      property: property(),
      policy: policy({ blockedSuppliers: ["src_rogue"] }),
    });
    expect(verdict.reasonCode).toBe("blocked_supplier");
    expect(verdict.reason).toBe("This supplier is not approved by your travel policy");
  });

  it("flex_required reads exactly as specified", () => {
    const verdict = evaluate({
      rate: rate({ refundableUntil: null }),
      property: property(),
      policy: policy({ requireFlexible: true }),
    });
    expect(verdict.reasonCode).toBe("flex_required");
    expect(verdict.reason).toBe("Your policy requires a free-cancellation rate");
  });

  it("labels the cap with the tier when no city override matched", () => {
    const verdict = evaluate({
      rate: rate(),
      property: property({ city: "Pune", cityTier: "tier1", geo: { lat: 18.59, lng: 73.74 } }),
      policy: policy(),
    });
    // ₹8,700 is over the ₹7,000 tier1 cap, and the label is the tier, not the city.
    expect(verdict.reason).toBe(
      "₹8,700/night is over your ₹7,000 tier1 cap by ₹1,700 — ₹6,800 for 4 nights",
    );
  });

  it("says plainly when no cap is authored for the market", () => {
    const verdict = evaluate({ rate: rate(), property: property(), policy: policy({ caps: [] }) });
    expect(verdict.state).toBe("in");
    expect(verdict.reasonCode).toBe("within_cap");
    expect(verdict.reason).toBe(
      "₹8,700/night is within your travel policy — no cap is set for metro",
    );
    expect(verdict.capPerNight).toBeNull();
  });

  it("renders paise when a rate carries them", () => {
    const verdict = evaluate({
      rate: rate({ perNight: money(870050, "INR") }),
      property: property(),
      policy: mumbaiCap(900000),
    });
    expect(verdict.reason).toBe("₹8,700.50/night is within your ₹9,000 Mumbai cap");
  });
});

// ---------- the check order ----------

describe("evaluate — the check order is frozen", () => {
  const everythingWrong = policy({
    blockedCountries: ["AE"],
    blockedSuppliers: ["src_a"],
    requireFlexible: true,
    caps: [{ cityTier: "metro", city: null, perNight: money(100000, "INR") }],
  });

  it("reports blocked_country first, ahead of supplier, flex and cap", () => {
    const verdict = evaluate({
      rate: rate({ refundableUntil: null }),
      property: property({ countryCode: "AE" }),
      policy: everythingWrong,
    });
    expect(verdict.reasonCode).toBe("blocked_country");
  });

  it("reports blocked_supplier ahead of flex and cap", () => {
    const verdict = evaluate({
      rate: rate({ refundableUntil: null }),
      property: property(),
      policy: everythingWrong,
    });
    expect(verdict.reasonCode).toBe("blocked_supplier");
  });

  it("reports flex_required ahead of over_cap", () => {
    const verdict = evaluate({
      rate: rate({ refundableUntil: null, sourceId: "src_ok" }),
      property: property(),
      policy: everythingWrong,
    });
    expect(verdict.reasonCode).toBe("flex_required");
  });

  it("reports over_cap once nothing earlier applies", () => {
    const verdict = evaluate({
      rate: rate({ sourceId: "src_ok" }),
      property: property(),
      policy: everythingWrong,
    });
    expect(verdict.reasonCode).toBe("over_cap");
  });
});

// ---------- boundaries ----------

describe("evaluate — cap boundaries", () => {
  it("treats a rate exactly at the cap as in policy", () => {
    const verdict = evaluate({
      rate: rate({ perNight: money(900000, "INR") }),
      property: property(),
      policy: mumbaiCap(900000),
    });
    expect(verdict.state).toBe("in");
    expect(verdict.reason).toBe("₹9,000/night is within your ₹9,000 Mumbai cap");
  });

  it("blocks a rate one paisa over the cap", () => {
    const verdict = evaluate({
      rate: rate({ perNight: money(900001, "INR") }),
      property: property(),
      policy: mumbaiCap(900000),
    });
    expect(verdict.reasonCode).toBe("over_cap");
    expect(verdict.overageMinor).toBe(1);
    expect(verdict.reason).toBe(
      "₹9,000.01/night is over your ₹9,000 Mumbai cap by ₹0.01 — ₹0.04 for 4 nights",
    );
  });

  it("never reports a negative overage for an in-policy rate", () => {
    const verdict = evaluate({
      rate: rate({ perNight: money(100000, "INR") }),
      property: property(),
      policy: policy(),
    });
    expect(verdict.overageMinor).toBeNull();
  });

  it("ignores requireFlexible when the rate is refundable", () => {
    const verdict = evaluate({
      rate: rate(),
      property: property(),
      policy: policy({ requireFlexible: true }),
    });
    expect(verdict.state).toBe("in");
  });

  it("scales the stay overage by the night count", () => {
    const oneNight = evaluate({
      rate: rate({ nights: 1, checkOut: "2026-06-12" }),
      property: property(),
      policy: mumbaiCap(800000),
    });
    expect(oneNight.reason).toBe(
      "₹8,700/night is over your ₹8,000 Mumbai cap by ₹700 — ₹700 for 1 night",
    );
  });

  it("refuses to compare a cap to a rate in another currency", () => {
    expect(() =>
      evaluate({
        rate: rate({ currency: "USD", perNight: money(20000, "USD") }),
        property: property(),
        policy: policy(),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("carries the authored policy version into the verdict", () => {
    const verdict = evaluate({ rate: rate(), property: property(), policy: policy({ version: 9 }) });
    expect(verdict.policyVersion).toBe(9);
  });

  it("exposes an evaluator version distinct from the policy version", () => {
    expect(POLICY_EVALUATOR_VERSION).toBe(1);
  });
});

// ---------- purity and replay ----------

describe("evaluate — purity", () => {
  it("returns byte-identical output for identical input, twice", () => {
    const args = { rate: rate(), property: property(), policy: policy() };
    expect(JSON.stringify(evaluate(args))).toBe(JSON.stringify(evaluate(args)));
  });

  it("does not depend on the key order of its inputs", () => {
    const a = evaluate({ rate: rate(), property: property(), policy: policy() });
    // Same values, rebuilt in a different literal order.
    const reordered = {
      policy: policy(),
      property: property(),
      rate: rate(),
    };
    expect(JSON.stringify(evaluate(reordered))).toBe(JSON.stringify(a));
  });

  it("does not depend on the order caps were authored in", () => {
    const forwards = policy({
      caps: [
        { cityTier: "metro", city: null, perNight: money(900000, "INR") },
        { cityTier: "metro", city: "Mumbai", perNight: money(800000, "INR") },
      ],
    });
    const backwards = policy({ caps: [...forwards.caps].reverse() });
    expect(evaluate({ rate: rate(), property: property(), policy: forwards }).reason).toBe(
      evaluate({ rate: rate(), property: property(), policy: backwards }).reason,
    );
  });

  it("does not mutate its inputs", () => {
    const r = rate();
    const p = property();
    const pol = policy();
    const before = JSON.stringify({ r, p, pol });
    evaluate({ rate: r, property: p, policy: pol });
    expect(JSON.stringify({ r, p, pol })).toBe(before);
  });

  it("reads no clock and no randomness", () => {
    const source = readFileSync(new URL("../../src/core/policy.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Date\.now|new Date|Math\.random|toLocale|Intl\./);
  });
});

describe("replay — A12", () => {
  it("reproduces a stored verdict byte-identically from the frozen offer", () => {
    const b = booking();
    expect(replay(b, policy())).toEqual(b.verdict);
    expect(JSON.stringify(replay(b, policy()))).toBe(JSON.stringify(b.verdict));
  });

  it("reproduces the verdict no matter how many times it is replayed", () => {
    const b = booking();
    const runs = [replay(b, policy()), replay(b, policy()), replay(b, policy())];
    for (const run of runs) expect(JSON.stringify(run)).toBe(JSON.stringify(b.verdict));
  });

  it("reads the booking's own snapshot, not live supply", () => {
    // The snapshot is over the cap; the booking's stored verdict was "in" under a
    // looser policy. Replaying against the stricter policy must reflect the snapshot.
    const b = booking();
    const stricter: Policy = { ...mumbaiCap(800000), version: 2 };
    const replayed = replay(b, stricter);
    expect(replayed.reasonCode).toBe("over_cap");
    expect(replayed.policyVersion).toBe(2);
    expect(replayed.reason).toBe(
      "₹8,700/night is over your ₹8,000 Mumbai cap by ₹700 — ₹2,800 for 4 nights",
    );
  });

  it("agrees with evaluate on the same inputs", () => {
    const b = booking();
    expect(replay(b, policy())).toEqual(
      evaluate({ rate: b.offer.rate, property: b.offer.property, policy: policy() }),
    );
  });
});
