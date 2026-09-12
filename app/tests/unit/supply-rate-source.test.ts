import { createFixtureRateSources } from "../../src/supply/FixtureRateSource.ts";
import { SupplierPriceDriftError, SupplierSoldOutError } from "../../src/supply/RateSource.ts";
import { resolveAnchor } from "../../src/supply/fixtures/anchors.ts";
import { defaultChaos } from "../../src/supply/fixtures/adversarial.ts";
import type { SearchQuery } from "../../src/core/types.ts";

function bkcQuery(): SearchQuery {
  const anchor = resolveAnchor("BKC")!;
  return { anchor, checkIn: "2026-11-10", checkOut: "2026-11-14", guests: 1, rooms: 1 };
}

describe("createFixtureRateSources", () => {
  it("returns exactly four sources with distinct ids and display names", () => {
    const sources = createFixtureRateSources();
    expect(sources).toHaveLength(4);
    const ids = new Set(sources.map((s) => s.id));
    const names = new Set(sources.map((s) => s.displayName));
    expect(ids.size).toBe(4);
    expect(names.size).toBe(4);
  });

  it("has genuinely different latencies (~120/400/900/1800ms)", async () => {
    const sources = createFixtureRateSources();
    const query = bkcQuery();
    const timings: number[] = [];
    for (const source of sources) {
      const started = Date.now();
      await source.searchAvailability(query, new AbortController().signal);
      timings.push(Date.now() - started);
    }
    timings.sort((a, b) => a - b);
    // Distinct bands, generous tolerance for CI jitter.
    expect(timings[0]).toBeLessThan(300);
    expect(timings[3]).toBeGreaterThan(1200);
    expect(timings[3]! - timings[0]!).toBeGreaterThan(800);
  });

  it("has overlapping-but-different property subsets across sources", async () => {
    const sources = createFixtureRateSources();
    const query = bkcQuery();
    const idSets = await Promise.all(
      sources.map(async (s) => {
        const offers = await s.searchAvailability(query, new AbortController().signal);
        return new Set(offers.map((o) => o.property.id));
      }),
    );
    // Not identical...
    expect(idSets[0]).not.toEqual(idSets[1]);
    // ...but overlapping.
    const [a, b] = idSets as [Set<string>, Set<string>];
    const intersection = [...a].filter((id) => b.has(id));
    expect(intersection.length).toBeGreaterThan(0);
  });

  it("rejects promptly when the AbortSignal fires mid-search", async () => {
    const sources = createFixtureRateSources();
    const slow = sources.find((s) => s.displayName === "Delta Bedbank")!;
    const controller = new AbortController();
    const query = bkcQuery();

    const promise = slow.searchAvailability(query, controller.signal);
    setTimeout(() => controller.abort(), 30);

    const started = Date.now();
    await expect(promise).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("honours chaos.timeoutSourceIds by never answering before abort", async () => {
    const chaos = { ...defaultChaos(), timeoutSourceIds: ["fx-alpha"] };
    const sources = createFixtureRateSources({ chaos });
    const alpha = sources.find((s) => s.id === "fx-alpha")!;
    const controller = new AbortController();
    const query = bkcQuery();

    const promise = alpha.searchAvailability(query, controller.signal);
    setTimeout(() => controller.abort(), 50);

    const started = Date.now();
    await expect(promise).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("priceCheck returns null for the always-sold-out canary offer", async () => {
    const sources = createFixtureRateSources();
    const source = sources[0]!;
    const query = bkcQuery();
    const offers = await source.searchAvailability(query, new AbortController().signal);
    const soldOut = offers.find((o) => o.property.id === "prop-bkc-canary-soldout");
    expect(soldOut).toBeDefined();
    const result = await source.priceCheck(soldOut!.rate.id, query);
    expect(result).toBeNull();
  });

  it("priceCheck returns a different total for the always-drift canary offer", async () => {
    const sources = createFixtureRateSources();
    const source = sources[0]!;
    const query = bkcQuery();
    const offers = await source.searchAvailability(query, new AbortController().signal);
    const drifter = offers.find((o) => o.property.id === "prop-bkc-canary-drift");
    expect(drifter).toBeDefined();
    const result = await source.priceCheck(drifter!.rate.id, query);
    expect(result).not.toBeNull();
    expect(result!.rate.allInTotal.minor).not.toBe(drifter!.rate.allInTotal.minor);
    expect(result!.rate.id).toBe(drifter!.rate.id);
  });

  it("book() throws SupplierSoldOutError for the sold-out canary", async () => {
    const sources = createFixtureRateSources();
    const source = sources[0]!;
    const query = bkcQuery();
    const offers = await source.searchAvailability(query, new AbortController().signal);
    const soldOut = offers.find((o) => o.property.id === "prop-bkc-canary-soldout")!;

    await expect(
      source.book({
        offerId: soldOut.rate.id,
        query,
        travellerName: "Asha Rao",
        travellerEmail: "asha@acme.test",
        authorisedTotal: soldOut.rate.allInTotal,
        cardTokenRef: "tok_test",
        correlationId: "corr-1",
      }),
    ).rejects.toBeInstanceOf(SupplierSoldOutError);
  });

  it("book() throws SupplierPriceDriftError for the drift canary", async () => {
    const sources = createFixtureRateSources();
    const source = sources[0]!;
    const query = bkcQuery();
    const offers = await source.searchAvailability(query, new AbortController().signal);
    const drifter = offers.find((o) => o.property.id === "prop-bkc-canary-drift")!;

    await expect(
      source.book({
        offerId: drifter.rate.id,
        query,
        travellerName: "Asha Rao",
        travellerEmail: "asha@acme.test",
        authorisedTotal: drifter.rate.allInTotal,
        cardTokenRef: "tok_test",
        correlationId: "corr-2",
      }),
    ).rejects.toBeInstanceOf(SupplierPriceDriftError);
  });

  it("book() succeeds for an ordinary offer", async () => {
    const sources = createFixtureRateSources();
    const source = sources[0]!;
    const query = bkcQuery();
    const offers = await source.searchAvailability(query, new AbortController().signal);
    const ordinary = offers.find(
      (o) => o.property.id !== "prop-bkc-canary-drift" && o.property.id !== "prop-bkc-canary-soldout",
    )!;

    const booking = await source.book({
      offerId: ordinary.rate.id,
      query,
      travellerName: "Asha Rao",
      travellerEmail: "asha@acme.test",
      authorisedTotal: ordinary.rate.allInTotal,
      cardTokenRef: "tok_test",
      correlationId: "corr-3",
    });
    expect(booking.confirmedTotal).toEqual(ordinary.rate.allInTotal);
    expect(booking.supplierBookingRef.length).toBeGreaterThan(0);
  });
});
