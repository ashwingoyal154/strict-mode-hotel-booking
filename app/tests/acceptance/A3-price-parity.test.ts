/**
 * A3 — "The total on the first results screen equals the total on the
 * confirmation to the cent, across 100 consecutive bookings including fixture
 * price-drift cases. Drift surfaces as an explicit re-confirm, never a silent
 * adjustment."
 *
 * This is the most important test in Slice 1. The product's core promise is one
 * number that does not move.
 */
import { makeHarness, book, idemKey } from "./harness.ts";

describe("A3 — price parity to the cent", () => {
  it("books 100 consecutive offers with the confirmed total equal to the displayed total", async () => {
    const h = await makeHarness();
    await h.login();

    let checked = 0;
    let searches = 0;
    // Slice 2 dedupes to one row per hotel and ranks over-cap rates separately, so
    // each search yields fewer in-policy offers; allow enough searches to reach 100.
    while (checked < 100 && searches < 30) {
      searches++;
      const s = await h.search(undefined, 2 + (searches % 5));
      expect(s.inPolicy.length).toBeGreaterThan(0);

      for (const offer of s.inPolicy) {
        if (checked >= 100) break;
        const displayed = offer.offer.rate.allInTotal;
        const res = await book(h, s.searchId, offer);

        if (res.status === 201) {
          const confirmed = res.body.booking.offer.rate.allInTotal;
          expect(confirmed.currency).toBe(displayed.currency);
          // to the cent. not "close to".
          expect(confirmed.minor).toBe(displayed.minor);
          checked++;
        } else if (res.status === 409) {
          // drift is permitted — but only as an explicit, surfaced re-confirm
          expect(res.body.error.code).toBe("price_drift");
          expect(res.body.error.detail.acceptedTotal.minor).toBe(displayed.minor);
          expect(res.body.error.detail.currentTotal.minor).not.toBe(displayed.minor);
          checked++;
        } else if (res.status === 410) {
          checked++; // sold out is a legitimate outcome, not a price change
        } else {
          throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(100);
  }, 420000);

  it("never absorbs a price change silently — a drifting rate is rejected, not booked at the new price", async () => {
    const h0 = await makeHarness();
    await h0.login();
    const probe = await h0.search();
    const target = probe.inPolicy[0];
    expect(target).toBeDefined();
    if (!target) return;

    // Force this exact offer to drift.
    const h = await makeHarness({ chaos: { enabled: true, driftOfferIds: [target.offer.rate.id] } });
    await h.login();
    const s = await h.search();
    const offer = s.results.find((r) => r.offer.rate.id === target.offer.rate.id);
    expect(offer).toBeDefined();
    if (!offer) return;

    const res = await book(h, s.searchId, offer);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("price_drift");
    expect(res.body.error.detail.deltaMinor).not.toBe(0);

    // And no booking was created.
    const mine = await h.agent.get("/api/bookings");
    expect(mine.body.bookings.length).toBe(0);
  }, 60000);

  it("re-confirming at the new price is an explicit second act", async () => {
    const h0 = await makeHarness();
    await h0.login();
    const probe = await h0.search();
    const target = probe.inPolicy[0];
    if (!target) return;

    const h = await makeHarness({ chaos: { enabled: true, driftOfferIds: [target.offer.rate.id] } });
    await h.login();
    const s = await h.search();
    const offer = s.results.find((r) => r.offer.rate.id === target.offer.rate.id);
    if (!offer) return;

    const first = await book(h, s.searchId, offer);
    expect(first.status).toBe(409);
    const newTotal = first.body.error.detail.currentTotal;

    const second = await book(h, s.searchId, offer, {
      acceptedTotal: newTotal,
      key: idemKey("reconfirm"),
    });
    expect([201, 409, 410]).toContain(second.status);
    if (second.status === 201) {
      expect(second.body.booking.offer.rate.allInTotal.minor).toBe(newTotal.minor);
    }
  }, 60000);

  it("every rate's components sum exactly to its all-in total", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    expect(s.results.length).toBeGreaterThan(0);
    for (const r of s.results) {
      const sum = r.offer.rate.components.reduce((acc, c) => acc + c.amount.minor, 0);
      expect(sum).toBe(r.offer.rate.allInTotal.minor);
    }
  }, 60000);
});
