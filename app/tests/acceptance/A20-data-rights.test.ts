/**
 * A20 — "A traveller data export and a full erasure both complete from the admin
 * UI." Spec §3.2: bookings are retained for 7 years for tax, so erasure strips the
 * person out of them rather than deleting the money record.
 */
import { makeHarness, book, withApprovalCast } from "./harness.ts";
import type { Booking, DataExport, ErasureReceipt, Traveller } from "../../src/core/types.ts";

describe("A20 — export and erasure", () => {
  it("exports everything held about a traveller", async () => {
    const h = await makeHarness();
    const { asha } = await withApprovalCast(h);
    const s = await h.search(undefined, 4, asha);
    const offer = s.inPolicy[0];
    if (!offer) return;
    const created = await book(h, s.searchId, offer, { who: asha });
    expect(created.status).toBe(201);

    const me = (await asha.get("/api/me")).body.traveller as Traveller;
    const exp = await h.agent.get(`/api/admin/travellers/${me.id}/export`);
    expect(exp.status).toBe(200);
    const data = exp.body as DataExport;
    expect(data.traveller.email).toBe("asha@acme.test");
    expect(data.bookings.length).toBe(1);
    expect(data.searches.length).toBeGreaterThan(0);
    expect(data.sourceLog.length).toBeGreaterThan(0);

    const self = await asha.get("/api/me/export");
    expect(self.status).toBe(200);
    expect((self.body as DataExport).traveller.id).toBe(me.id);
  }, 60000);

  it("erases the person while keeping the tax record, and requires typed confirmation", async () => {
    const h = await makeHarness();
    const { asha } = await withApprovalCast(h);
    const s = await h.search(undefined, 4, asha);
    const offer = s.inPolicy[0];
    if (!offer) return;
    const created = await book(h, s.searchId, offer, { who: asha });
    const bookingId = (created.body.booking as Booking).id;
    const me = (await asha.get("/api/me")).body.traveller as Traveller;

    const wrong = await h.agent.post(`/api/admin/travellers/${me.id}/erase`).send({ confirmEmail: "nope@acme.test" });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe("confirmation_mismatch");

    const erased = await h.agent.post(`/api/admin/travellers/${me.id}/erase`).send({ confirmEmail: "asha@acme.test" });
    expect(erased.status).toBe(200);
    const receipt = erased.body as ErasureReceipt;
    expect(receipt.pseudonym).toMatch(/^erased-/);
    expect(receipt.retained.bookings).toBe(1);
    expect(receipt.deleted.searches).toBeGreaterThan(0);

    const after = await h.agent.get(`/api/admin/travellers/${me.id}/export`);
    const text = JSON.stringify(after.body);
    expect(text).not.toContain("asha@acme.test");
    expect(text).not.toContain("Asha Rao");
    // Location is personal data (90-day retention); the anchor the traveller typed must be gone.
    expect(text).not.toContain("Bandra Kurla Complex, Mumbai");

    // The money record survives, stripped of the person.
    const kept = (after.body as DataExport).bookings.find((b) => b.id === bookingId);
    expect(kept?.amounts.supplier.minor).toBe(offer.offer.rate.allInTotal.minor);
    expect(kept?.anchor.label).toBe("(erased)");

    const twice = await h.agent.post(`/api/admin/travellers/${me.id}/erase`).send({ confirmEmail: receipt.pseudonym });
    expect(twice.status).toBe(409);
  }, 60000);
});
