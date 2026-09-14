/**
 * A12 — "Re-running policy evaluation against a stored booking reproduces the
 * verdict and reason string byte-identical, including the pinned-FX conversion
 * path."
 *
 * Slice 2 makes this harder in exactly the two ways the spec predicted: the
 * evaluator changed (over-cap is 'over', not 'blocked'), and verdicts now depend
 * on an FX rate that changes every month.
 */
import { makeHarness, book, withApprovalCast, JUSTIFICATION } from "./harness.ts";
import { replay, evaluateV1 } from "../../src/core/policy.ts";
import { money } from "../../src/core/money.ts";
import type { Booking, Policy } from "../../src/core/types.ts";

describe("A12 — a stored verdict is reproducible", () => {
  it("replays a same-currency verdict byte-identically", async () => {
    const h = await makeHarness();
    await h.login();
    const policy = await h.getPolicy();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;
    const created = await book(h, s.searchId, offer);
    expect(created.status).toBe(201);
    const booking = created.body.booking as Booking;

    expect(booking.verdict.evaluatorVersion).toBe(2);
    expect(JSON.stringify(replay(booking, policy))).toBe(JSON.stringify(booking.verdict));
  }, 60000);

  it("replays a converted verdict byte-identically after the monthly pins change", async () => {
    const h = await makeHarness();
    await h.login();
    const policy = await h.getPolicy();
    const s = await h.search("Canary Wharf", 3);
    const offer = s.inPolicy[0];
    expect(offer).toBeDefined();
    if (!offer) return;

    const created = await book(h, s.searchId, offer);
    expect(created.status).toBe(201);
    const booking = created.body.booking as Booking;
    expect(booking.verdict.fxPin?.source).toBe("pinned_monthly");
    expect(booking.verdict.reason).toMatch(/pinned rate/);

    // Change this month's GBP pin. The stored verdict must not move.
    const pins = await h.agent.get("/api/admin/fx-pins");
    const month = pins.body.month as string;
    const rates = (pins.body.rates as Array<{ base: string; quote: string; rateMicros: number }>).map((r) =>
      r.base === "GBP" ? { ...r, rateMicros: r.rateMicros * 2 } : r,
    );
    const put = await h.agent.put("/api/admin/fx-pins").send({ month, rates });
    expect(put.status).toBe(200);

    const stored = (await h.agent.get(`/api/bookings/${booking.id}`)).body.booking as Booking;
    expect(stored.verdict.reason).toBe(booking.verdict.reason);
    expect(JSON.stringify(replay(stored, policy))).toBe(JSON.stringify(booking.verdict));
  }, 60000);

  it("replays a pending over-cap verdict, and keeps it after the policy is tightened", async () => {
    const h = await makeHarness();
    const { asha } = await withApprovalCast(h);
    const before = await h.getPolicy();
    const s = await h.search(undefined, 4, asha);
    const over = s.overCap[0];
    if (!over) return;
    const res = await book(h, s.searchId, over, { who: asha, justification: JUSTIFICATION });
    expect(res.status).toBe(202);
    const booking = res.body.booking as Booking;

    await h.setPolicy({
      caps: [
        { cityTier: "metro", city: null, perNight: money(100000, "INR") },
        { cityTier: "metro", city: "Mumbai", perNight: money(100000, "INR") },
      ],
    });
    const after = await h.getPolicy();
    expect(after.version).toBeGreaterThan(before.version);

    const stored = (await h.agent.get(`/api/bookings/${booking.id}`)).body.booking as Booking;
    expect(stored.verdict.reason).toBe(booking.verdict.reason);
    // Replay against the version the booking was evaluated under, not today's.
    expect(JSON.stringify(replay(stored, before))).toBe(JSON.stringify(booking.verdict));
  }, 60000);

  it("still replays a Slice 1 (evaluator v1) verdict byte-identically", async () => {
    const h = await makeHarness();
    await h.login();
    const policy = await h.getPolicy();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;
    const created = await book(h, s.searchId, offer);
    const booking = created.body.booking as Booking;

    // Rewrite the stored verdict as Slice 1 would have produced it.
    const v1 = evaluateV1({ rate: booking.offer.rate, property: booking.offer.property, policy });
    expect("evaluatorVersion" in v1).toBe(false);
    const legacy: Booking = { ...booking, verdict: v1 };
    expect(JSON.stringify(replay(legacy, policy))).toBe(JSON.stringify(v1));
  }, 60000);
});
