import { readFileSync } from "node:fs";

import type { Offer, PolicyVerdict, SupplyChannel } from "../../src/core/types.ts";
import { money } from "../../src/core/money.ts";
import { dedupeByProperty, rankOffers, type RankInput } from "../../src/core/rank.ts";
import { property, rate } from "./core-builders.ts";

const IN: PolicyVerdict = {
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
};
const OVER: PolicyVerdict = {
  ...IN,
  state: "over",
  reasonCode: "over_cap",
  reason: "₹10,594/night is over your ₹9,000 Mumbai cap by ₹1,594 — ₹6,376 for 4 nights",
  overageMinor: 159400,
  overage: money(159400, "INR"),
};
const BLOCKED: PolicyVerdict = {
  ...IN,
  state: "blocked",
  reasonCode: "blocked_supplier",
  reason: "This supplier is not approved by your travel policy",
  capPerNight: null,
};

function candidate(
  propertyId: string,
  minutes: number,
  displayMinor: number,
  opts: {
    channel?: SupplyChannel;
    verdict?: PolicyVerdict;
    rateId?: string;
    totalMinor?: number;
    displayCurrency?: string;
  } = {},
): RankInput {
  const total = money(opts.totalMinor ?? displayMinor, "INR");
  const offer: Offer = {
    property: property({ id: propertyId, name: `Property ${propertyId}` }),
    rate: rate({
      id: opts.rateId ?? `r_${propertyId}`,
      propertyId,
      channel: opts.channel ?? "public",
      allInTotal: total,
      components: [{ kind: "base", label: "Room", amount: total }],
    }),
  };
  return {
    offer,
    commute: { minutes, mode: "walk", distanceMeters: minutes * 80 },
    verdict: opts.verdict ?? IN,
    display: { from: total, to: money(displayMinor, opts.displayCurrency ?? "INR"), fx: null },
  };
}

const ids = (ranked: readonly { offer: Offer }[]): string[] => ranked.map((r) => r.offer.property.id);

describe("rankOffers v2 — commute first, over-cap numbered alongside in-policy", () => {
  it("ranks a closer over-cap hotel above a further in-policy one", () => {
    const ranked = rankOffers([candidate("p_in_far", 20, 3000000), candidate("p_over_near", 6, 4800000, { verdict: OVER })]);
    expect(ids(ranked)).toEqual(["p_over_near", "p_in_far"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
    expect(ranked[0]?.rankReason).toBe("closest to your meeting");
    expect(ranked[1]?.rankReason).toBe("+14 min vs closest");
  });

  it("lets in-policy win only as a tiebreak at equal commute, even when dearer", () => {
    const ranked = rankOffers([
      candidate("p_over", 9, 3000000, { verdict: OVER }),
      candidate("p_in", 9, 5000000),
    ]);
    expect(ids(ranked)).toEqual(["p_in", "p_over"]);
    expect(ranked[1]?.rankReason).toBe("as close as the closest");
  });

  it("puts in-before-over ahead of the negotiated tiebreak", () => {
    const ranked = rankOffers([
      candidate("p_over_negotiated", 9, 3000000, { verdict: OVER, channel: "negotiated" }),
      candidate("p_in_public", 9, 3000000),
    ]);
    expect(ids(ranked)).toEqual(["p_in_public", "p_over_negotiated"]);
  });

  it("prefers negotiated at equal commute and state", () => {
    const ranked = rankOffers([
      candidate("p_public", 9, 3000000),
      candidate("p_negotiated", 9, 4000000, { channel: "negotiated" }),
    ]);
    expect(ids(ranked)).toEqual(["p_negotiated", "p_public"]);
  });

  it("orders by the displayed total, not the supplier total", () => {
    const ranked = rankOffers([
      candidate("p_a", 9, 5000000, { totalMinor: 100 }),
      candidate("p_b", 9, 4000000, { totalMinor: 900 }),
    ]);
    expect(ids(ranked)).toEqual(["p_b", "p_a"]);
  });

  it("falls back to property id for determinism", () => {
    const a = candidate("p_aaa", 9, 3000000);
    const b = candidate("p_bbb", 9, 3000000);
    expect(ids(rankOffers([b, a]))).toEqual(["p_aaa", "p_bbb"]);
  });

  it("puts blocked offers last with rank 0 and no reason, in commute order", () => {
    const ranked = rankOffers([
      candidate("p_blocked_far", 25, 3000000, { verdict: BLOCKED }),
      candidate("p_blocked_near", 2, 3000000, { verdict: BLOCKED }),
      candidate("p_over", 30, 3000000, { verdict: OVER }),
    ]);
    expect(ids(ranked)).toEqual(["p_over", "p_blocked_near", "p_blocked_far"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 0, 0]);
    expect(ranked[1]?.rankReason).toBe("");
  });

  it("carries the display conversion through", () => {
    const input = candidate("p_a", 7, 3000000);
    const [ranked] = rankOffers([input]);
    expect(ranked?.display).toBe(input.display);
    expect(ranked?.offer).toBe(input.offer);
    expect(ranked?.verdict).toBe(input.verdict);
  });

  it("orders a mixed-currency page deterministically instead of throwing", () => {
    const inputs = [candidate("p_gbp", 9, 41200, { displayCurrency: "GBP" }), candidate("p_inr", 9, 3000000)];
    expect(ids(rankOffers(inputs))).toEqual(ids(rankOffers([...inputs].reverse())));
  });

  it("is order-independent", () => {
    const inputs = [
      candidate("p_a", 4, 9000000, { verdict: OVER }),
      candidate("p_b", 11, 5000000),
      candidate("p_c", 11, 4000000, { verdict: OVER }),
      candidate("p_d", 34, 900000, { verdict: BLOCKED }),
    ];
    expect(rankOffers([...inputs].reverse())).toEqual(rankOffers(inputs));
  });

  it("handles an empty page", () => {
    expect(rankOffers([])).toEqual([]);
  });
});

describe("dedupeByProperty v2", () => {
  it("prefers in over a cheaper over, and over over a cheaper blocked", () => {
    const kept = dedupeByProperty([
      candidate("p_a", 7, 1000000, { rateId: "r_blocked", verdict: BLOCKED }),
      candidate("p_a", 7, 2000000, { rateId: "r_over", verdict: OVER }),
      candidate("p_a", 7, 4000000, { rateId: "r_in" }),
    ]);
    expect(kept.map((k) => k.offer.rate.id)).toEqual(["r_in"]);

    const noIn = dedupeByProperty([
      candidate("p_a", 7, 1000000, { rateId: "r_blocked", verdict: BLOCKED }),
      candidate("p_a", 7, 2000000, { rateId: "r_over", verdict: OVER }),
    ]);
    expect(noIn.map((k) => k.offer.rate.id)).toEqual(["r_over"]);
  });

  it("then prefers negotiated, then the lower displayed total, then rate id", () => {
    expect(
      dedupeByProperty([
        candidate("p_a", 7, 3000000, { rateId: "r_public" }),
        candidate("p_a", 7, 3200000, { rateId: "r_negotiated", channel: "negotiated" }),
      ])[0]?.offer.rate.id,
    ).toBe("r_negotiated");
    expect(
      dedupeByProperty([
        candidate("p_a", 7, 3200000, { rateId: "r_dear", totalMinor: 1 }),
        candidate("p_a", 7, 3000000, { rateId: "r_cheap", totalMinor: 9 }),
      ])[0]?.offer.rate.id,
    ).toBe("r_cheap");
    expect(
      dedupeByProperty([
        candidate("p_a", 7, 3000000, { rateId: "r_zeta" }),
        candidate("p_a", 7, 3000000, { rateId: "r_alpha" }),
      ])[0]?.offer.rate.id,
    ).toBe("r_alpha");
  });

  it("does not depend on the order sources answered in", () => {
    const a = candidate("p_a", 7, 4000000, { rateId: "r_alpha" });
    const b = candidate("p_a", 7, 3000000, { rateId: "r_beta", verdict: OVER });
    const c = candidate("p_b", 9, 3500000, { rateId: "r_gamma" });
    const one = rankOffers([a, b, c]).map((r) => r.offer.rate.id);
    expect(rankOffers([c, b, a]).map((r) => r.offer.rate.id)).toEqual(one);
    expect(rankOffers([b, c, a]).map((r) => r.offer.rate.id)).toEqual(one);
  });
});

describe("rank.ts source — §3.4 enforced as a test, not a principle", () => {
  const source = readFileSync(new URL("../../src/core/rank.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("reads commute minutes before it reads any price", () => {
    const firstCommute = code.indexOf("commute.minutes");
    const firstPrice = code.search(/display\.to|\.minor|allInTotal/);
    expect(firstCommute).toBeGreaterThan(-1);
    expect(firstPrice).toBeGreaterThan(-1);
    expect(firstCommute).toBeLessThan(firstPrice);
  });

  it("compares policy state before price as well", () => {
    expect(code.indexOf("stateOrder(a.verdict)")).toBeLessThan(code.indexOf("compareDisplayed(a, b)"));
  });

  it("has no concept of commission at all", () => {
    expect(/commission|margin|markup|payout|revenue/i.test(code)).toBe(false);
  });
});
