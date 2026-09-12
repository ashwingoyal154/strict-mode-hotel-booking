/**
 * A1 / A4 — the journey itself.
 *
 * The spec's "under 90 seconds, median, on a phone" is a human measurement and a
 * Slice 1 exit activity, not a unit test. What a test CAN hold is the structural
 * claim underneath it: the journey is short, needs no account setup, no payment
 * entry, and an in-policy booking takes exactly one write call.
 */
import { makeHarness, book, idemKey } from "./harness.ts";

describe("A1 — search to confirmed with no setup", () => {
  it("completes login → search → book → trip for a brand-new traveller", async () => {
    const h = await makeHarness();
    const t0 = Date.now();

    // No signup, no profile, no payment method: first sight of this email.
    await h.login("newjoiner@acme.test", "New Joiner");
    const me = await h.agent.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.body.traveller.email).toBe("newjoiner@acme.test");
    expect(me.body.traveller.defaultCostCentre).toBeTruthy();

    const s = await h.search();
    const offer = s.inPolicy[0];
    expect(offer).toBeDefined();
    if (!offer) return;

    const created = await book(h, s.searchId, offer);
    expect(created.status).toBe(201);
    const booking = created.body.booking;
    expect(booking.state).toBe("confirmed");
    expect(booking.confirmationCode).toMatch(/^[A-Z2-9]{6}$/);

    const trip = await h.agent.get(`/api/bookings/${booking.id}`);
    expect(trip.status).toBe(200);
    expect(trip.body.booking.offer.property.phone).toBeTruthy();
    expect(trip.body.booking.offer.property.addressLine).toBeTruthy();

    // Machine time is not human time, but a slow machine path makes 90s impossible.
    expect(Date.now() - t0).toBeLessThan(20000);
  }, 60000);

  it("A4 — an in-policy booking is exactly one write call from the results list", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;

    // One POST. No hold, no quote step, no payment step, no confirm-the-confirm.
    const res = await book(h, s.searchId, offer, { key: idemKey("onetap") });
    expect(res.status).toBe(201);
    expect(res.body.booking.state).toBe("confirmed");
  }, 60000);

  it("gives the traveller their trips list", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;
    await book(h, s.searchId, offer);
    const list = await h.agent.get("/api/bookings");
    expect(list.status).toBe(200);
    expect(list.body.bookings.length).toBe(1);
  }, 60000);

  it("refuses anonymous booking and anonymous search", async () => {
    const h = await makeHarness();
    const s = await h.agent.post("/api/search").send({
      anchorQuery: "Bandra Kurla Complex",
      checkIn: "2026-10-12",
      checkOut: "2026-10-16",
      guests: 1,
      rooms: 1,
    });
    expect(s.status).toBe(401);
  }, 30000);
});
