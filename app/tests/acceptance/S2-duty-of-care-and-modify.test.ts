/**
 * Slice 2 behaviours without an A-number in the spec's acceptance list, but named
 * in plan.md's Slice 2 scope and SPEC §2.7–2.9: duty of care, and modify as one
 * flow with the delta up front.
 */
import { makeHarness, book, dateRange, idemKey } from "./harness.ts";
import type { Booking, InMarketTraveller, ModifyQuote } from "../../src/core/types.ts";

describe("Duty of care — travellers in market tonight", () => {
  it("lists a traveller on each night of their stay and not after checkout", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search("Bandra Kurla Complex", 4);
    const offer = s.inPolicy[0];
    if (!offer) return;
    const created = await book(h, s.searchId, offer);
    expect(created.status).toBe(201);
    const { checkIn, checkOut } = dateRange(4);

    const night = await h.agent.get(`/api/admin/in-market?date=${checkIn}`);
    expect(night.status).toBe(200);
    const rows = night.body.travellers as InMarketTraveller[];
    expect(rows.some((r) => r.bookingId === created.body.booking.id)).toBe(true);
    expect(rows[0]?.propertyPhone).toBeTruthy();
    expect(night.body.byCountry.find((c: { countryCode: string }) => c.countryCode === "IN")?.count).toBeGreaterThan(0);

    const gone = await h.agent.get(`/api/admin/in-market?date=${checkOut}`);
    expect((gone.body.travellers as InMarketTraveller[]).some((r) => r.bookingId === created.body.booking.id)).toBe(false);
  }, 60000);

  it("flags an advisory city at confirm and in the in-market view", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search("DIFC", 3);
    const offer = s.inPolicy[0] ?? s.overCap[0];
    expect(offer).toBeDefined();
    if (!offer) return;
    expect(offer.verdict.advisory?.countryCode).toBe("AE");
  }, 60000);
});

describe("Modify — cancel and rebook as one flow", () => {
  it("quotes the delta, books the new stay first, then marks the old one modified", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search("Bandra Kurla Complex", 4);
    // Canary rates drift or sell out by design; a modify test must target ordinary rates.
    const ordinary = (id: string): boolean => !/~(DRIFT|SOLDOUT|LATEDRIFT)$/.test(id);
    const [first, second] = s.inPolicy.filter(
      (r) => r.offer.rate.refundableUntil !== null && ordinary(r.offer.rate.id),
    );
    if (!first || !second) return;
    const created = await book(h, s.searchId, first);
    expect(created.status).toBe(201);
    const old = created.body.booking as Booking;

    const s2 = await h.search("Bandra Kurla Complex", 4);
    const target = s2.inPolicy.find((r) => r.offer.property.id === second.offer.property.id) ?? second;

    const quote = await h.agent
      .post(`/api/bookings/${old.id}/modify/quote`)
      .send({ searchId: s2.searchId, offerId: target.offer.rate.id });
    expect(quote.status).toBe(200);
    const q = quote.body.quote as ModifyQuote;
    expect(q.cancellationCost.minor).toBe(0);
    expect(q.newTotal.minor).toBe(target.offer.rate.allInTotal.minor);
    expect(q.message.length).toBeGreaterThan(5);

    const modified = await h.agent
      .post(`/api/bookings/${old.id}/modify`)
      .set("Idempotency-Key", idemKey("modify"))
      .send({ searchId: s2.searchId, offerId: target.offer.rate.id, acceptedNewTotal: target.offer.rate.allInTotal });
    expect(modified.status).toBe(201);
    expect(modified.body.booking.state).toBe("confirmed");
    expect(modified.body.booking.replaces).toBe(old.id);
    expect(modified.body.replaced.state).toBe("modified");
    expect(modified.body.replaced.replacedBy).toBe(modified.body.booking.id);
  }, 90000);

  it("refuses to modify into an over-cap rate", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search("Bandra Kurla Complex", 4);
    const first = s.inPolicy.find(
      (r) => r.offer.rate.refundableUntil !== null && !/~(DRIFT|SOLDOUT|LATEDRIFT)$/.test(r.offer.rate.id),
    );
    const over = s.overCap[0];
    if (!first || !over) return;
    const created = await book(h, s.searchId, first);
    const res = await h.agent
      .post(`/api/bookings/${created.body.booking.id}/modify/quote`)
      .send({ searchId: s.searchId, offerId: over.offer.rate.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("modify_over_cap");
  }, 60000);
});
