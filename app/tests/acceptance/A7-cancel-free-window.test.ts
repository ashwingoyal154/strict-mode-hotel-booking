/**
 * A7 — "Cancelling inside the free window costs zero, takes one tap, and reaches
 * the source within 60 seconds."
 */
import { makeHarness, book } from "./harness.ts";

describe("A7 — cancellation inside the free window", () => {
  it("cancels in a single call and reflects it on the booking", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy.find((r) => r.offer.rate.refundableUntil !== null);
    expect(offer).toBeDefined();
    if (!offer) return;

    const created = await book(h, s.searchId, offer);
    expect(created.status).toBe(201);
    const id = created.body.booking.id as string;
    expect(created.body.booking.cancellationDeadline).not.toBeNull();

    const res = await h.agent.post(`/api/bookings/${id}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(res.body.booking.state).toBe("cancelled");
    expect(res.body.booking.cancelledAt).not.toBeNull();
  }, 60000);

  it("refuses to cancel after the deadline, and says when the deadline was", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy.find((r) => r.offer.rate.refundableUntil !== null);
    if (!offer) return;

    const created = await book(h, s.searchId, offer);
    expect(created.status).toBe(201);
    const id = created.body.booking.id as string;
    const deadline = new Date(created.body.booking.cancellationDeadline as string);

    // Step the clock past the free window.
    h.setNow(new Date(deadline.getTime() + 60 * 60 * 1000));

    const res = await h.agent.post(`/api/bookings/${id}/cancel`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("outside_free_window");
    expect(res.body.error.detail.cancellationDeadline).toBeTruthy();

    const after = await h.agent.get(`/api/bookings/${id}`);
    expect(after.body.booking.state).toBe("confirmed");
  }, 60000);

  it("records the cancellation with the supplier in the append-only source log", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy.find((r) => r.offer.rate.refundableUntil !== null);
    if (!offer) return;
    const created = await book(h, s.searchId, offer);
    await h.agent.post(`/api/bookings/${created.body.booking.id}/cancel`).send({});

    const log = await h.agent.get("/api/admin/source-log?limit=200");
    expect(log.status).toBe(200);
    const ops = (log.body.entries as Array<{ operation: string }>).map((e) => e.operation);
    expect(ops).toContain("cancel");
  }, 60000);
});
