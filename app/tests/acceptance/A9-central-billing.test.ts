/**
 * A9 (slice-1 scope: sandbox) — "Every confirmed booking produces a
 * central-billing charge with no traveller out-of-pocket, drawn on the correct
 * legal entity."
 */
import { makeHarness, book } from "./harness.ts";

describe("A9 — central billing, nothing out of pocket", () => {
  it("issues a single-use card scoped to the exact total plus the policy buffer", async () => {
    const h = await makeHarness();
    await h.login();
    const policy = await h.getPolicy();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;

    const res = await book(h, s.searchId, offer);
    expect(res.status).toBe(201);
    const b = res.body.booking;

    expect(b.card).not.toBeNull();
    expect(b.card.tokenRef).toBeTruthy();
    expect(b.card.last4).toMatch(/^\d{4}$/);
    expect(b.card.authorisedTotal.minor).toBe(offer.offer.rate.allInTotal.minor);
    expect(b.card.incidentalsBufferMinor).toBe(policy.incidentalsBufferMinor);
  }, 60000);

  it("asks the traveller for no payment input at any point", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;

    // The booking request body carries no payment field whatsoever, and succeeds.
    const res = await book(h, s.searchId, offer);
    expect(res.status).toBe(201);
  }, 60000);

  it("attributes the booking to the traveller's legal entity", async () => {
    const h = await makeHarness();
    await h.login();
    const me = await h.agent.get("/api/me");
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;
    const res = await book(h, s.searchId, offer);
    expect(res.body.booking.entityId).toBe(me.body.traveller.entityId);
  }, 60000);

  it("surfaces a declined card plainly instead of booking", async () => {
    const h = await makeHarness({ alwaysDeclineRefs: ["*"] });
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;
    const res = await book(h, s.searchId, offer);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("card_declined");
    const mine = await h.agent.get("/api/bookings");
    expect(mine.body.bookings.length).toBe(0);
  }, 60000);
});
