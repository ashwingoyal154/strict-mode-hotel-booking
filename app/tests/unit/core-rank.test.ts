import { readFileSync } from "node:fs";

import type {
  Commute,
  Offer,
  PolicyVerdict,
  Property,
  Rate,
  SupplyChannel,
} from "../../src/core/types.ts";
import { money } from "../../src/core/money.ts";
import { rankOffers, type RankInput } from "../../src/core/rank.ts";

const IN_POLICY: PolicyVerdict = {
  state: "in",
  reasonCode: "within_cap",
  reason: "₹8,700/night is within your ₹9,000 Mumbai cap",
  policyVersion: 1,
  capPerNight: money(900000, "INR"),
  overageMinor: null,
};

const BLOCKED: PolicyVerdict = {
  state: "blocked",
  reasonCode: "blocked_supplier",
  reason: "This supplier is not approved by your travel policy",
  policyVersion: 1,
  capPerNight: null,
  overageMinor: null,
};

function property(id: string): Property {
  return {
    id,
    name: `Property ${id}`,
    addressLine: "1 Test Road",
    city: "Mumbai",
    cityTier: "metro",
    countryCode: "IN",
    geo: { lat: 19.0654, lng: 72.8686 },
    phone: "+91 22 0000 0000",
    brand: null,
    workReady: true,
    thumbnailUrl: null,
  };
}

function rate(id: string, totalMinor: number, channel: SupplyChannel = "public"): Rate {
  return {
    id,
    propertyId: id,
    checkIn: "2026-06-11",
    checkOut: "2026-06-15",
    nights: 4,
    currency: "INR",
    components: [{ kind: "base", label: "Room", amount: money(totalMinor, "INR") }],
    allInTotal: money(totalMinor, "INR"),
    perNight: money(Math.floor(totalMinor / 4), "INR"),
    breakfastIncluded: false,
    refundableUntil: "2026-06-09T12:30:00.000Z",
    channel,
    supplierRef: `sup-${id}`,
    sourceId: "src_a",
  };
}

function candidate(
  id: string,
  minutes: number,
  totalMinor: number,
  opts?: { channel?: SupplyChannel; verdict?: PolicyVerdict; mode?: Commute["mode"] },
): RankInput {
  const offer: Offer = { property: property(id), rate: rate(id, totalMinor, opts?.channel) };
  return {
    offer,
    commute: { minutes, mode: opts?.mode ?? "walk", distanceMeters: minutes * 80 },
    verdict: opts?.verdict ?? IN_POLICY,
  };
}

const ids = (ranked: readonly { offer: Offer }[]): string[] =>
  ranked.map((r) => r.offer.property.id);

describe("rankOffers — commute is the only ranking signal", () => {
  it("ranks a dearer-but-closer offer above a cheaper-but-further one", () => {
    const near_expensive = candidate("p_near", 6, 4800000);
    const far_cheap = candidate("p_far", 28, 1800000, { mode: "transit" });

    const ranked = rankOffers([far_cheap, near_expensive]);

    expect(ids(ranked)).toEqual(["p_near", "p_far"]);
    expect(ranked[0]?.rank).toBe(1);
    expect(ranked[1]?.rank).toBe(2);
  });

  it("does not let a large price gap overturn a one-minute commute gap", () => {
    const ranked = rankOffers([
      candidate("p_cheap", 8, 500000),
      candidate("p_dear", 7, 9900000),
    ]);
    expect(ids(ranked)).toEqual(["p_dear", "p_cheap"]);
  });

  it("orders a whole page by minutes ascending regardless of price order", () => {
    const ranked = rankOffers([
      candidate("p_c", 21, 1000000, { mode: "transit" }),
      candidate("p_a", 4, 9000000),
      candidate("p_d", 34, 900000, { mode: "drive" }),
      candidate("p_b", 11, 5000000),
    ]);
    expect(ids(ranked)).toEqual(["p_a", "p_b", "p_c", "p_d"]);
    expect(ranked.map((r) => r.commute.minutes)).toEqual([4, 11, 21, 34]);
  });
});

describe("rankOffers — negotiated channel is a tiebreak, never a lever", () => {
  it("wins at equal commute time", () => {
    const ranked = rankOffers([
      candidate("p_public", 9, 3000000, { channel: "public" }),
      candidate("p_negotiated", 9, 4000000, { channel: "negotiated" }),
    ]);
    // Dearer, but negotiated, and the commute is identical — so it leads.
    expect(ids(ranked)).toEqual(["p_negotiated", "p_public"]);
  });

  it("loses whenever the commute differs, even by one minute and at a lower price", () => {
    const ranked = rankOffers([
      candidate("p_negotiated", 10, 2000000, { channel: "negotiated" }),
      candidate("p_public", 9, 5000000, { channel: "public" }),
    ]);
    expect(ids(ranked)).toEqual(["p_public", "p_negotiated"]);
  });

  it("cannot promote a bedbank or fixture channel at equal commute", () => {
    const ranked = rankOffers([
      candidate("p_bedbank", 9, 2000000, { channel: "bedbank" }),
      candidate("p_fixture", 9, 2000000, { channel: "fixture" }),
    ]);
    // No channel preference beyond "negotiated": falls through to price, then id.
    expect(ids(ranked)).toEqual(["p_bedbank", "p_fixture"]);
  });
});

describe("rankOffers — tiebreaks below commute and channel", () => {
  it("prefers the lower all-in total at equal commute and channel", () => {
    const ranked = rankOffers([
      candidate("p_dear", 9, 4000000),
      candidate("p_cheap", 9, 3000000),
    ]);
    expect(ids(ranked)).toEqual(["p_cheap", "p_dear"]);
  });

  it("falls back to property id so the same search ranks identically twice", () => {
    const a = candidate("p_aaa", 9, 3000000);
    const b = candidate("p_bbb", 9, 3000000);
    expect(ids(rankOffers([b, a]))).toEqual(["p_aaa", "p_bbb"]);
    expect(ids(rankOffers([a, b]))).toEqual(["p_aaa", "p_bbb"]);
  });

  it("is order-independent: a shuffled input yields the same ranking", () => {
    const inputs = [
      candidate("p_a", 4, 9000000),
      candidate("p_b", 11, 5000000),
      candidate("p_c", 11, 4000000),
      candidate("p_d", 34, 900000, { mode: "drive" }),
    ];
    const forwards = rankOffers(inputs);
    const backwards = rankOffers([...inputs].reverse());
    expect(ids(backwards)).toEqual(ids(forwards));
    expect(backwards.map((r) => r.rankReason)).toEqual(forwards.map((r) => r.rankReason));
  });
});

describe("rankOffers — rank numbers and reasons", () => {
  it("numbers only bookable offers and explains the gap in minutes", () => {
    const ranked = rankOffers([
      candidate("p_a", 7, 3000000),
      candidate("p_b", 19, 2000000, { mode: "transit" }),
      candidate("p_c", 26, 2000000, { mode: "transit" }),
    ]);
    expect(ranked.map((r) => r.rankReason)).toEqual([
      "closest to your meeting",
      "+12 min vs closest",
      "+19 min vs closest",
    ]);
  });

  it("says a tied offer is as close as the closest, rather than '+0 min'", () => {
    const ranked = rankOffers([candidate("p_a", 9, 3000000), candidate("p_b", 9, 4000000)]);
    expect(ranked[1]?.rankReason).toBe("as close as the closest");
  });

  it("puts blocked offers last, unranked and unexplained", () => {
    const ranked = rankOffers([
      candidate("p_blocked_near", 2, 3000000, { verdict: BLOCKED }),
      candidate("p_in_far", 30, 3000000, { mode: "drive" }),
    ]);
    expect(ids(ranked)).toEqual(["p_in_far", "p_blocked_near"]);
    expect(ranked[0]?.rank).toBe(1);
    expect(ranked[1]?.rank).toBe(0);
    expect(ranked[1]?.rankReason).toBe("");
  });

  it("still returns blocked offers in commute order, for the disclosure list", () => {
    const ranked = rankOffers([
      candidate("p_far_blocked", 25, 3000000, { verdict: BLOCKED, mode: "transit" }),
      candidate("p_near_blocked", 5, 3000000, { verdict: BLOCKED }),
    ]);
    expect(ids(ranked)).toEqual(["p_near_blocked", "p_far_blocked"]);
    expect(ranked.every((r) => r.rank === 0)).toBe(true);
  });

  it("handles an all-blocked page and an empty page", () => {
    expect(rankOffers([])).toEqual([]);
    const ranked = rankOffers([candidate("p_x", 5, 3000000, { verdict: BLOCKED })]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.rank).toBe(0);
  });

  it("preserves the offer, commute and verdict it was given", () => {
    const input = candidate("p_a", 7, 3000000);
    const ranked = rankOffers([input]);
    expect(ranked[0]?.offer).toBe(input.offer);
    expect(ranked[0]?.commute).toBe(input.commute);
    expect(ranked[0]?.verdict).toBe(input.verdict);
  });

  it("does not mutate its input", () => {
    const inputs = [candidate("p_b", 20, 3000000, { mode: "transit" }), candidate("p_a", 5, 3000000)];
    const snapshot = inputs.map((i) => i.offer.property.id);
    rankOffers(inputs);
    expect(inputs.map((i) => i.offer.property.id)).toEqual(snapshot);
  });
});

describe("rank.ts source — §3.4 enforced as a test, not a principle", () => {
  const source = readFileSync(new URL("../../src/core/rank.ts", import.meta.url), "utf8");
  // Comments discuss commission in order to forbid it; the executable code must not mention it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("reads commute minutes before it reads any price", () => {
    const firstCommute = code.indexOf("commute.minutes");
    const firstTotal = code.indexOf("allInTotal");
    expect(firstCommute).toBeGreaterThan(-1);
    expect(firstTotal).toBeGreaterThan(-1);
    expect(firstCommute).toBeLessThan(firstTotal);
  });

  it("has no concept of commission at all", () => {
    expect(/commission|margin|markup|payout/i.test(code)).toBe(false);
  });
});

/**
 * Added after seeing the live API return the same hotel four times — once per
 * source. The commute-ranked list is the product; one building occupying four
 * rows destroys it.
 */
describe("dedupeByProperty — one row per hotel", () => {
  function ratedOffer(
    propertyId: string,
    rateId: string,
    minutes: number,
    totalMinor: number,
    opts: { channel?: "public" | "negotiated" | "bedbank"; blocked?: boolean } = {},
  ) {
    const base = candidate(propertyId, minutes, totalMinor);
    return {
      ...base,
      offer: {
        ...base.offer,
        rate: {
          ...base.offer.rate,
          id: rateId,
          channel: opts.channel ?? "public",
        },
      },
      verdict: opts.blocked
        ? { ...base.verdict, state: "blocked" as const, reasonCode: "over_cap" as const }
        : base.verdict,
    };
  }

  it("collapses four sources' rates for one hotel into a single row", () => {
    const ranked = rankOffers([
      ratedOffer("p_a", "r_alpha", 7, 4000000),
      ratedOffer("p_a", "r_beta", 7, 3000000),
      ratedOffer("p_a", "r_gamma", 7, 3500000),
      ratedOffer("p_a", "r_delta", 7, 5000000),
    ]);
    expect(ranked.length).toBe(1);
    expect(ranked[0]?.offer.rate.id).toBe("r_beta"); // the cheapest
  });

  it("prefers a bookable rate over a cheaper blocked one for the same hotel", () => {
    const ranked = rankOffers([
      ratedOffer("p_a", "r_cheap_blocked", 7, 1000000, { blocked: true }),
      ratedOffer("p_a", "r_dearer_ok", 7, 4000000),
    ]);
    expect(ranked.length).toBe(1);
    expect(ranked[0]?.offer.rate.id).toBe("r_dearer_ok");
    expect(ranked[0]?.verdict.state).toBe("in");
  });

  it("prefers a negotiated rate over a cheaper public one for the same hotel", () => {
    const ranked = rankOffers([
      ratedOffer("p_a", "r_public", 7, 3000000, { channel: "public" }),
      ratedOffer("p_a", "r_negotiated", 7, 3200000, { channel: "negotiated" }),
    ]);
    expect(ranked[0]?.offer.rate.id).toBe("r_negotiated");
  });

  it("keeps distinct hotels distinct", () => {
    const ranked = rankOffers([
      ratedOffer("p_a", "r_a", 7, 3000000),
      ratedOffer("p_b", "r_b", 9, 3000000),
      ratedOffer("p_c", "r_c", 4, 3000000),
    ]);
    expect(ranked.length).toBe(3);
    expect(ranked.map((r) => r.offer.property.id)).toEqual(["p_c", "p_a", "p_b"]);
  });

  it("does not depend on the order sources answered in", () => {
    const a = ratedOffer("p_a", "r_alpha", 7, 4000000);
    const b = ratedOffer("p_a", "r_beta", 7, 3000000);
    const c = ratedOffer("p_b", "r_gamma", 9, 3500000);
    const one = rankOffers([a, b, c]).map((r) => r.offer.rate.id);
    const two = rankOffers([c, b, a]).map((r) => r.offer.rate.id);
    const three = rankOffers([b, c, a]).map((r) => r.offer.rate.id);
    expect(two).toEqual(one);
    expect(three).toEqual(one);
  });
});
