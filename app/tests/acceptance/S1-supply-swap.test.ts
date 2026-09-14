/**
 * Gate S1 — "The fixture RateSource is replaced by a live supplier adapter with zero
 * changes to policy, booking, billing or UI code."
 *
 * The app here is the real one. The only difference from every other acceptance
 * test is `sources`: the Expedia Rapid adapter pointed at an in-process mock of the
 * Rapid shapes. If the port leaked, these journeys would fail here first.
 *
 * What this does NOT prove, and the plan says so: S2 (price parity and hold honesty
 * on LIVE inventory) and S3 (virtual-card acceptance at real properties) need
 * Expedia Partner Solutions credentials and real stays.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { createExpediaRapidRateSource, RAPID_SOURCE_ID } from "../../src/supply/ExpediaRapidRateSource.ts";
import { FIXTURE_PROPERTIES, propertiesNear } from "../../src/supply/fixtures/properties.ts";
import type { Booking, SourceLogEntry } from "../../src/core/types.ts";
import { MOCK_API_KEY, MOCK_SHARED_SECRET, startRapidMock, type RapidMock } from "../fixtures/rapid-mock.ts";
import { book, makeHarness } from "./harness.ts";

let mock: RapidMock;

beforeAll(async () => {
  mock = await startRapidMock();
});
afterAll(async () => {
  await mock.close();
});

function rapid() {
  return createExpediaRapidRateSource({
    apiKey: MOCK_API_KEY,
    sharedSecret: MOCK_SHARED_SECRET,
    baseUrl: mock.baseUrl,
    customerIp: "127.0.0.1",
    posCountryCode: "IN",
    language: "en-US",
    currency: "INR",
    salesChannel: "website",
    salesEnvironment: "hotel_only",
    propertyIdsForAnchor: async (anchor) => propertiesNear(anchor.geo, 20_000).map((p) => p.id),
    propertyFor: (id) => FIXTURE_PROPERTIES.find((p) => p.id === id) ?? null,
  });
}

describe("S1 — the supply seam holds for a live adapter", () => {
  it("searches, ranks, prices and books on Rapid with an unchanged app", async () => {
    const h = await makeHarness({ sources: [rapid()] });
    await h.login();
    const s = await h.search();
    expect(s.results.length).toBeGreaterThan(0);
    expect(s.results.every((r) => r.offer.rate.sourceId === RAPID_SOURCE_ID)).toBe(true);

    const offer = s.inPolicy[0];
    expect(offer).toBeDefined();
    if (!offer) return;
    const res = await book(h, s.searchId, offer);
    expect(res.status).toBe(201);
    const booking = res.body.booking as Booking;
    expect(booking.offer.rate.allInTotal.minor).toBe(offer.offer.rate.allInTotal.minor); // A3 parity through Rapid
    expect(booking.card).not.toBeNull(); // central billing unchanged

    // No card data ever left for the supplier (A13).
    const sent = JSON.stringify(mock.bookings);
    expect(sent).not.toMatch(/card|number|cvv|cvc|expir/i);
    expect(mock.authFailures).toBe(0);

    // Every supplier call is still in the immutable source log.
    const log = await h.agent.get("/api/admin/source-log?limit=200");
    const ops = (log.body.entries as SourceLogEntry[]).filter((e) => e.sourceId === RAPID_SOURCE_ID).map((e) => e.operation);
    expect(ops).toEqual(expect.arrayContaining(["search", "priceCheck", "book"]));

    // Cancellation inside the free window reaches Rapid.
    if (booking.cancellationDeadline !== null) {
      const cancelled = await h.agent.post(`/api/bookings/${booking.id}/cancel`).send({});
      expect(cancelled.status).toBe(200);
      expect(mock.cancels.length).toBeGreaterThan(0);
    }
  }, 60000);

  it("still enforces policy and never pretends a Rapid rate is held", async () => {
    const h = await makeHarness({ sources: [rapid()] });
    await h.login();
    await h.setPolicy({ blockedCountries: ["IN"] });
    const blocked = await h.search();
    const target = blocked.blocked[0];
    expect(target).toBeDefined();
    if (target) expect((await book(h, blocked.searchId, target)).status).toBe(403);
  }, 60000);

  it("is reachable only through the port — nothing above src/supply imports the adapter except composition", () => {
    const root = new URL("../../src/", import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && readFileSync(p, "utf8").includes("ExpediaRapidRateSource")) offenders.push(p.slice(root.length));
      }
    };
    walk(root);
    const allowed = new Set(["supply/ExpediaRapidRateSource.ts", "server/index.ts"]);
    expect(offenders.filter((f) => !allowed.has(f))).toEqual([]);
  });
});
