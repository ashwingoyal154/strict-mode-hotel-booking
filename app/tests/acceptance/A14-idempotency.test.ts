/**
 * A14 — "A double-submitted confirmation yields exactly one booking."
 * Bookings are money. A duplicate is a real charge on a real company.
 */
import { makeHarness, book, idemKey } from "./harness.ts";

describe("A14 — idempotency", () => {
  it("returns the same booking and creates no second one on a repeated key", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;

    const key = idemKey("double");
    const first = await book(h, s.searchId, offer, { key });
    expect(first.status).toBe(201);

    const second = await book(h, s.searchId, offer, { key });
    expect(second.status).toBe(200);
    expect(second.body.booking.id).toBe(first.body.booking.id);

    const mine = await h.agent.get("/api/bookings");
    expect(mine.body.bookings.length).toBe(1);
  }, 60000);

  it("creates exactly one booking under concurrent submits of the same key", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;

    const key = idemKey("race");
    const results = await Promise.all([
      book(h, s.searchId, offer, { key }),
      book(h, s.searchId, offer, { key }),
      book(h, s.searchId, offer, { key }),
    ]);

    const created = results.filter((r) => r.status === 201);
    expect(created.length).toBeLessThanOrEqual(1);
    const ok = results.filter((r) => r.status === 201 || r.status === 200);
    expect(ok.length).toBe(3);

    const mine = await h.agent.get("/api/bookings");
    expect(mine.body.bookings.length).toBe(1);
  }, 60000);

  it("requires an idempotency key", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;

    const res = await h.agent.post("/api/bookings").send({
      searchId: s.searchId,
      offerId: offer.offer.rate.id,
      costCentre: "ENG-OPS",
      acceptedTotal: offer.offer.rate.allInTotal,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("idempotency_key_required");
  }, 60000);
});
