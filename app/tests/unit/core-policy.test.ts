import { readFileSync } from "node:fs";

import type { Booking, Policy } from "../../src/core/types.ts";
import { CurrencyMismatchError, money } from "../../src/core/money.ts";
import {
  POLICY_EVALUATOR_VERSION,
  advisoryFor,
  capFor,
  evaluate,
  evaluateV1,
  replay,
} from "../../src/core/policy.ts";
import { booking, gbpRate, londonProperty, pin, policy, property, rate } from "./core-builders.ts";

const mumbaiCap = (minor: number): Policy =>
  policy({ caps: [{ cityTier: "metro", city: "Mumbai", perNight: money(minor, "INR") }] });

const londonCap = policy({ caps: [{ cityTier: "global", city: "London", perNight: money(4500000, "INR") }] });
const GBP_INR = pin("GBP", "INR", 106_250_000);

const v2 = (over: { rate?: ReturnType<typeof rate>; policy?: Policy; pins?: ReturnType<typeof pin>[]; london?: boolean }) =>
  evaluate({
    rate: over.rate ?? rate(),
    property: over.london === true ? londonProperty() : property(),
    policy: over.policy ?? policy(),
    fxPins: over.pins ?? [],
    pinMonth: "2026-09",
  });

// ---------- evaluator v1, frozen ----------

describe("evaluateV1 — the Slice 1 evaluator, byte for byte", () => {
  it("produces the five Slice 1 reason strings, with over cap still 'blocked'", () => {
    expect(evaluateV1({ rate: rate(), property: property(), policy: mumbaiCap(900000) })).toEqual({
      state: "in",
      reasonCode: "within_cap",
      reason: "₹8,700/night is within your ₹9,000 Mumbai cap",
      policyVersion: 1,
      capPerNight: money(900000, "INR"),
      overageMinor: null,
    });
    expect(evaluateV1({ rate: rate(), property: property(), policy: mumbaiCap(800000) })).toEqual({
      state: "blocked",
      reasonCode: "over_cap",
      reason: "₹8,700/night is over your ₹8,000 Mumbai cap by ₹700 — ₹2,800 for 4 nights",
      policyVersion: 1,
      capPerNight: money(800000, "INR"),
      overageMinor: 70000,
    });
    expect(
      evaluateV1({ rate: rate(), property: property({ countryCode: "AE" }), policy: policy({ blockedCountries: ["AE"] }) })
        .reason,
    ).toBe("Bookings in AE are blocked by your travel policy");
    expect(evaluateV1({ rate: rate(), property: property(), policy: policy({ blockedSuppliers: ["src_a"] }) }).reason).toBe(
      "This supplier is not approved by your travel policy",
    );
    expect(
      evaluateV1({ rate: rate({ refundableUntil: null }), property: property(), policy: policy({ requireFlexible: true }) })
        .reason,
    ).toBe("Your policy requires a free-cancellation rate");
    expect(evaluateV1({ rate: rate(), property: property(), policy: policy({ caps: [] }) }).reason).toBe(
      "₹8,700/night is within your travel policy — no cap is set for metro",
    );
  });

  it("carries no Slice 2 keys", () => {
    const verdict = evaluateV1({ rate: rate(), property: property(), policy: mumbaiCap(800000) });
    expect(Object.keys(verdict)).toEqual(["state", "reasonCode", "reason", "policyVersion", "capPerNight", "overageMinor"]);
  });

  it("still refuses to compare across currencies, as Slice 1 did", () => {
    expect(() => evaluateV1({ rate: gbpRate(41200), property: londonProperty(), policy: londonCap })).toThrow(
      CurrencyMismatchError,
    );
  });
});

// ---------- caps and advisories ----------

describe("capFor and advisoryFor", () => {
  it("lets a named city beat a tier, and a same-currency row win within a level", () => {
    const p = policy({
      caps: [
        { cityTier: "global", city: null, perNight: money(40000, "GBP") },
        { cityTier: "global", city: "London", perNight: money(4500000, "INR") },
        { cityTier: "global", city: "London", perNight: money(42000, "GBP") },
      ],
    });
    expect(capFor(p, londonProperty(), "GBP")).toEqual(money(42000, "GBP"));
    expect(capFor(p, londonProperty(), "USD")).toEqual(money(4500000, "INR"));
    expect(capFor(p, londonProperty({ city: "Leeds" }), "GBP")).toEqual(money(40000, "GBP"));
    expect(capFor(policy({ caps: [] }), property())).toBeNull();
  });

  it("flags the most severe matching advisory, city-specific first", () => {
    const at = "2026-09-01T00:00:00.000Z";
    const p = policy({
      advisories: [
        { countryCode: "AE", city: null, level: "caution", note: "country", updatedAt: at },
        { countryCode: "AE", city: "Dubai", level: "caution", note: "city", updatedAt: at },
        { countryCode: "IN", city: null, level: "high", note: "elsewhere", updatedAt: at },
      ],
    });
    expect(advisoryFor(p, property({ countryCode: "AE", city: "Dubai" }))?.note).toBe("city");
    expect(advisoryFor(p, property({ countryCode: "AE", city: "Abu Dhabi" }))?.note).toBe("country");
    expect(advisoryFor(p, property({ countryCode: "GB", city: "London" }))).toBeNull();
  });
});

// ---------- evaluator v2 ----------

describe("evaluate (v2) — reason strings are the stored record", () => {
  it("within, same currency", () => {
    const verdict = v2({ policy: mumbaiCap(900000) });
    expect(verdict).toEqual({
      state: "in",
      reasonCode: "within_cap",
      reason: "₹8,700/night is within your ₹9,000 Mumbai cap",
      policyVersion: 1,
      capPerNight: money(900000, "INR"),
      overageMinor: null,
      evaluatorVersion: 2,
      overage: null,
      fxPin: null,
      advisory: null,
    });
    expect(Object.keys(verdict)).toEqual([
      "state", "reasonCode", "reason", "policyVersion", "capPerNight", "overageMinor",
      "evaluatorVersion", "overage", "fxPin", "advisory",
    ]);
  });

  it("over, same currency — 'over', not 'blocked'", () => {
    const verdict = v2({ rate: rate({ perNight: money(1059400, "INR") }), policy: mumbaiCap(900000) });
    expect(verdict.state).toBe("over");
    expect(verdict.reasonCode).toBe("over_cap");
    expect(verdict.reason).toBe("₹10,594/night is over your ₹9,000 Mumbai cap by ₹1,594 — ₹6,376 for 4 nights");
    expect(verdict.overage).toEqual(money(159400, "INR"));
    expect(verdict.overageMinor).toBe(159400);
  });

  it("over, same currency, one night", () => {
    const verdict = v2({ rate: rate({ nights: 1, perNight: money(1059400, "INR") }), policy: mumbaiCap(900000) });
    expect(verdict.reason).toBe("₹10,594/night is over your ₹9,000 Mumbai cap by ₹1,594 — ₹1,594 for 1 night");
  });

  it("within, converted at the monthly pin", () => {
    const verdict = v2({ rate: gbpRate(41200), policy: londonCap, pins: [GBP_INR], london: true });
    expect(verdict.state).toBe("in");
    expect(verdict.reason).toBe("£412/night (₹43,775 at the Sep pinned rate) is within your ₹45,000 London cap");
    expect(verdict.fxPin).toEqual(GBP_INR);
    expect(verdict.overage).toBeNull();
  });

  it("over, converted — overage in the cap currency", () => {
    const verdict = v2({ rate: gbpRate(52000), policy: londonCap, pins: [GBP_INR], london: true });
    expect(verdict.state).toBe("over");
    expect(verdict.reason).toBe(
      "£520/night (₹55,250 at the Sep pinned rate) is over your ₹45,000 London cap by ₹10,250 — ₹41,000 for 4 nights",
    );
    expect(verdict.overage).toEqual(money(1025000, "INR"));
    expect(verdict.overageMinor).toBe(1025000);
    expect(verdict.capPerNight).toEqual(money(4500000, "INR"));
  });

  it("over, no pin — never silently in policy", () => {
    const verdict = v2({ rate: gbpRate(52000), policy: londonCap, pins: [], london: true });
    expect(verdict).toEqual({
      state: "over",
      reasonCode: "over_cap",
      reason:
        "£520/night can't be checked against your ₹45,000 London cap — there is no pinned GBP→INR rate for Sep, so it needs approval",
      policyVersion: 1,
      capPerNight: money(4500000, "INR"),
      overageMinor: null,
      evaluatorVersion: 2,
      overage: null,
      fxPin: null,
      advisory: null,
    });
  });

  it("ignores spot rates, so a live rate can never decide a verdict", () => {
    const spot = pin("GBP", "INR", 106_250_000, { source: "spot", pinMonth: null });
    expect(v2({ rate: gbpRate(41200), policy: londonCap, pins: [spot], london: true }).reason).toBe(
      "£412/night can't be checked against your ₹45,000 London cap — there is no pinned GBP→INR rate for Sep, so it needs approval",
    );
  });

  it("names the month of the pin it used", () => {
    const august = pin("GBP", "INR", 106_250_000, { pinMonth: "2026-08" });
    expect(v2({ rate: gbpRate(41200), policy: londonCap, pins: [august], london: true }).reason).toBe(
      "£412/night (₹43,775 at the Aug pinned rate) is within your ₹45,000 London cap",
    );
  });

  it("no cap, and the blocked strings, are unchanged from v1", () => {
    expect(v2({ policy: policy({ caps: [] }) }).reason).toBe("₹8,700/night is within your travel policy — no cap is set for metro");
    const blocked = v2({ policy: policy({ blockedSuppliers: ["src_a"] }) });
    expect(blocked.state).toBe("blocked");
    expect(blocked.reason).toBe("This supplier is not approved by your travel policy");
    expect(blocked.evaluatorVersion).toBe(2);
  });

  it("keeps the check order blocked_country → blocked_supplier → flex_required → cap", () => {
    const wrong = policy({
      blockedCountries: ["IN"],
      blockedSuppliers: ["src_a"],
      requireFlexible: true,
      caps: [{ cityTier: "metro", city: null, perNight: money(100, "INR") }],
    });
    const r = rate({ refundableUntil: null });
    expect(v2({ rate: r, policy: wrong }).reasonCode).toBe("blocked_country");
    expect(v2({ rate: r, policy: { ...wrong, blockedCountries: [] } }).reasonCode).toBe("blocked_supplier");
    expect(v2({ rate: r, policy: { ...wrong, blockedCountries: [], blockedSuppliers: [] } }).reasonCode).toBe("flex_required");
  });

  it("is pure and versioned", () => {
    expect(POLICY_EVALUATOR_VERSION).toBe(2);
    const args = { rate: gbpRate(52000), policy: londonCap, pins: [GBP_INR], london: true };
    expect(JSON.stringify(v2(args))).toBe(JSON.stringify(v2(args)));
    const source = readFileSync(new URL("../../src/core/policy.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Date\.now|new Date|Math\.random|toLocale|Intl\./);
  });
});

// ---------- replay — A12 ----------

describe("replay — A12", () => {
  it("reproduces a stored Slice 1 verdict byte-identically after v2 exists", () => {
    const strict = mumbaiCap(800000);
    const v1 = evaluateV1({ rate: rate(), property: property(), policy: strict });
    // Through storage, exactly as a Slice 1 booking would come back from disk.
    const stored = JSON.parse(JSON.stringify(booking({ verdict: v1 }))) as Booking;
    expect("evaluatorVersion" in stored.verdict).toBe(false);

    expect(JSON.stringify(replay(stored, strict))).toBe(JSON.stringify(v1));
    expect(replay(stored, strict).state).toBe("blocked");
    // And v2 would have said something different — so the dispatch is what keeps A12 true.
    expect(JSON.stringify(v2({ policy: strict }))).not.toBe(JSON.stringify(v1));
  });

  it("replays a converted v2 verdict from its own pin after today's pins change", () => {
    const verdict = v2({ rate: gbpRate(52000), policy: londonCap, pins: [GBP_INR], london: true });
    const stored = JSON.parse(
      JSON.stringify(booking({ offer: { property: londonProperty(), rate: gbpRate(52000) }, verdict })),
    ) as Booking;
    expect(JSON.stringify(replay(stored, londonCap))).toBe(JSON.stringify(verdict));
  });

  it("replays a converted verdict that used an inverse pin", () => {
    const verdict = v2({ rate: gbpRate(41200), policy: londonCap, pins: [pin("INR", "GBP", 9412)], london: true });
    const stored = JSON.parse(
      JSON.stringify(booking({ offer: { property: londonProperty(), rate: gbpRate(41200) }, verdict })),
    ) as Booking;
    expect(JSON.stringify(replay(stored, londonCap))).toBe(JSON.stringify(verdict));
  });

  it("replays a no-pin verdict, taking the month from createdAt in UTC", () => {
    const verdict = v2({ rate: gbpRate(52000), policy: londonCap, pins: [], london: true });
    // 1 Oct 01:00 in Kolkata is 30 Sep in UTC — the month the server pinned under.
    const stored = booking({
      offer: { property: londonProperty(), rate: gbpRate(52000) },
      verdict,
      createdAt: "2026-10-01T01:00:00+05:30",
    });
    expect(JSON.stringify(replay(stored, londonCap))).toBe(JSON.stringify(verdict));
  });

  it("refuses an evaluator version it does not know", () => {
    expect(() => replay(booking({ verdict: { ...v2({}), evaluatorVersion: 9 } }), policy())).toThrow(RangeError);
  });
});
