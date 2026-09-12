/**
 * Failure modes and the cancellation window, driven by a fully controlled
 * `RateSource` and `CardIssuer` rather than by fixture chaos — every status code
 * in API_CONTRACT.md gets a deterministic test, and the cancellation window is
 * exercised by moving the injected `now`, never by waiting.
 */

import request from "supertest";

import { createApp, type AppDeps } from "../../src/server/index.ts";
import { createMemoryStore } from "../../src/store/FileStore.ts";
import { createLocalRouteSource } from "../../src/routing/LocalRouteSource.ts";
import { FIXTURE_ANCHORS } from "../../src/supply/fixtures/anchors.ts";
import {
  SupplierPriceDriftError,
  SupplierSoldOutError,
  type RateSource,
} from "../../src/supply/RateSource.ts";
import { CardDeclinedError, type CardIssuer } from "../../src/payments/CardIssuer.ts";
import type { IssuedCard, Money, Offer, Property, Rate } from "../../src/core/types.ts";

const ANCHOR = FIXTURE_ANCHORS[0]!;
const QUERY = { anchorQuery: ANCHOR.label, checkIn: "2026-06-11", checkOut: "2026-06-15" };
const DEADLINE = "2026-06-09T18:00:00.000Z";
const TOTAL: Money = { minor: 3_480_000, currency: "INR" };

const PROPERTY: Property = {
  id: "prop_test_1",
  name: "The Quiet Desk",
  addressLine: "12 Test Lane",
  city: "Mumbai",
  cityTier: "metro",
  countryCode: "IN",
  geo: { lat: ANCHOR.geo.lat + 0.004, lng: ANCHOR.geo.lng + 0.004 },
  phone: "+91 22 0000 0000",
  brand: null,
  workReady: true,
  thumbnailUrl: null,
};

function rate(id: string): Rate {
  return {
    id,
    propertyId: PROPERTY.id,
    checkIn: QUERY.checkIn,
    checkOut: QUERY.checkOut,
    nights: 4,
    currency: "INR",
    components: [
      { kind: "base", label: "Room", amount: { minor: 3_000_000, currency: "INR" } },
      { kind: "tax", label: "GST 12%", amount: { minor: 360_000, currency: "INR" } },
      { kind: "fee", label: "Service fee", amount: { minor: 120_000, currency: "INR" } },
    ],
    allInTotal: TOTAL,
    perNight: { minor: 870_000, currency: "INR" },
    breakfastIncluded: true,
    refundableUntil: DEADLINE,
    channel: "fixture",
    supplierRef: "SUP-1",
    sourceId: "test-source",
  };
}

const OFFER_ID = "rate_test_1";

type Mode = "ok" | "sold_out_on_check" | "sold_out_on_book" | "drift_on_book" | "throw_on_book";

interface Recorder {
  books: number;
  cancels: string[];
  voids: string[];
  issues: number;
}

function testSource(mode: Mode, rec: Recorder): RateSource {
  const offer: Offer = { property: PROPERTY, rate: rate(OFFER_ID) };
  return {
    id: "test-source",
    displayName: "Test Source",
    async searchAvailability() {
      return [offer];
    },
    async priceCheck(offerId) {
      if (offerId !== OFFER_ID) return null;
      return mode === "sold_out_on_check" ? null : offer;
    },
    async book() {
      rec.books += 1;
      if (mode === "sold_out_on_book") throw new SupplierSoldOutError();
      if (mode === "drift_on_book") {
        throw new SupplierPriceDriftError({ minor: 3_600_000, currency: "INR" }, TOTAL);
      }
      if (mode === "throw_on_book") throw new Error("supplier exploded");
      return {
        supplierBookingRef: "SUP-BOOK-1",
        confirmedTotal: TOTAL,
        cancellationDeadline: DEADLINE,
        checkInTime: "14:00",
      };
    },
    async cancel(ref) {
      rec.cancels.push(ref);
    },
  };
}

function testIssuer(rec: Recorder, declineCode?: string): CardIssuer {
  return {
    id: "test-issuer",
    async issue(req) {
      rec.issues += 1;
      if (declineCode !== undefined) throw new CardDeclinedError(declineCode);
      const card: IssuedCard = {
        tokenRef: "tok_test_1",
        last4: "4242",
        brand: "visa",
        expMonth: 12,
        expYear: 2027,
        authorisedTotal: req.exactTotal,
        incidentalsBufferMinor: req.incidentalsBufferMinor,
      };
      return card;
    },
    async void(tokenRef) {
      rec.voids.push(tokenRef);
    },
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  rec: Recorder;
  setNow(d: Date): void;
}

function harness(opts?: { mode?: Mode; declineCode?: string; now?: Date }): Harness {
  const rec: Recorder = { books: 0, cancels: [], voids: [], issues: 0 };
  let now = opts?.now ?? new Date("2026-06-01T09:00:00.000Z");
  const deps: AppDeps = {
    store: createMemoryStore(),
    sources: [testSource(opts?.mode ?? "ok", rec)],
    routes: createLocalRouteSource(),
    issuer: testIssuer(rec, opts?.declineCode),
    now: () => now,
  };
  return {
    app: createApp(deps),
    rec,
    setNow(d) {
      now = d;
    },
  };
}

async function book(
  app: ReturnType<typeof createApp>,
  key: string,
  email = "ada@acme.test",
): Promise<{ agent: ReturnType<typeof request.agent>; res: request.Response }> {
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email }).expect(200);
  const started = await agent.post("/api/search").send(QUERY).expect(202);
  await agent.get(`/api/search/${started.body.searchId}`).expect(200);
  const res = await agent
    .post("/api/bookings")
    .set("Idempotency-Key", key)
    .send({ searchId: started.body.searchId, offerId: OFFER_ID, acceptedTotal: TOTAL });
  return { agent, res };
}

describe("booking failure modes", () => {
  it("410 sold_out when the rate is gone at price check", async () => {
    const h = harness({ mode: "sold_out_on_check" });
    const { res } = await book(h.app, "sold-out-check-000000001");
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("sold_out");
    // No card is issued for a rate that no longer exists.
    expect(h.rec.issues).toBe(0);
  });

  it("410 sold_out when the source sells out during book, and the card is voided", async () => {
    const h = harness({ mode: "sold_out_on_book" });
    const { res } = await book(h.app, "sold-out-book-0000000001");
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("sold_out");
    expect(h.rec.issues).toBe(1);
    expect(h.rec.voids).toEqual(["tok_test_1"]);
  });

  it("409 price_drift when the source moves the price during book", async () => {
    const h = harness({ mode: "drift_on_book" });
    const { res, agent } = await book(h.app, "drift-on-book-0000000001");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("price_drift");
    expect(res.body.error.detail.currentTotal).toEqual({ minor: 3_600_000, currency: "INR" });
    expect(res.body.error.detail.deltaMinor).toBe(120_000);
    expect(h.rec.voids).toEqual(["tok_test_1"]);
    expect((await agent.get("/api/bookings").expect(200)).body.bookings).toHaveLength(0);
  });

  it("402 card_declined with the decline code, and no supplier call", async () => {
    const h = harness({ declineCode: "insufficient_funds" });
    const { res } = await book(h.app, "declined-key-000000000001");
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("card_declined");
    expect(res.body.error.detail.declineCode).toBe("insufficient_funds");
    // The card is the gate: a declined card never reaches the supplier.
    expect(h.rec.books).toBe(0);
  });

  it("503 source_unavailable when the source throws during book", async () => {
    const h = harness({ mode: "throw_on_book" });
    const { res } = await book(h.app, "source-down-key-000000001");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("source_unavailable");
    expect(h.rec.voids).toEqual(["tok_test_1"]);
  });
});

describe("cancellation window (A7)", () => {
  it("cancels inside the free window, voids the card and reaches the source", async () => {
    const h = harness();
    const { agent, res } = await book(h.app, "cancel-inside-key-00000001");
    expect(res.status).toBe(201);
    expect(res.body.booking.cancellationDeadline).toBe(DEADLINE);

    const cancelled = await agent
      .post(`/api/bookings/${res.body.booking.id}/cancel`)
      .expect(200);
    expect(cancelled.body.booking.state).toBe("cancelled");
    expect(cancelled.body.booking.cancelledAt).toBe("2026-06-01T09:00:00.000Z");
    expect(h.rec.cancels).toEqual(["SUP-BOOK-1"]);
    expect(h.rec.voids).toEqual(["tok_test_1"]);

    // Idempotent: a second tap is not an error and does not re-cancel.
    const again = await agent.post(`/api/bookings/${res.body.booking.id}/cancel`).expect(200);
    expect(again.body.booking.state).toBe("cancelled");
    expect(h.rec.cancels).toEqual(["SUP-BOOK-1"]);
  });

  it("409 outside_free_window once now() is past the deadline", async () => {
    const h = harness();
    const { agent, res } = await book(h.app, "cancel-outside-key-0000001");
    expect(res.status).toBe(201);

    // The traveller comes back nine days later. Auth and the cancellation window
    // share one injected clock, so the old session has legitimately expired —
    // sign in again, exactly as a returning traveller would.
    h.setNow(new Date("2026-06-10T09:00:00.000Z"));
    await agent.post("/api/auth/login").send({ email: "ada@acme.test" }).expect(200);

    const denied = await agent
      .post(`/api/bookings/${res.body.booking.id}/cancel`)
      .expect(409);
    expect(denied.body.error.code).toBe("outside_free_window");
    expect(denied.body.error.detail.cancellationDeadline).toBe(DEADLINE);
    expect(h.rec.cancels).toEqual([]);

    const still = await agent.get(`/api/bookings/${res.body.booking.id}`).expect(200);
    expect(still.body.booking.state).toBe("confirmed");
  });

  it("403s cancelling someone else's trip and 404s an unknown one", async () => {
    const h = harness();
    const { res } = await book(h.app, "cancel-owner-key-000000001");
    const other = request.agent(h.app);
    await other.post("/api/auth/login").send({ email: "bob@acme.test" }).expect(200);
    const denied = await other.post(`/api/bookings/${res.body.booking.id}/cancel`).expect(403);
    expect(denied.body.error.code).toBe("forbidden");
    await other.post("/api/bookings/bkg_nope/cancel").expect(404);
  });
});
