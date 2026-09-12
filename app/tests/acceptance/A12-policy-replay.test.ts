/**
 * A12 (brought forward from Slice 2 because it is nearly free once policy is a
 * pure function) — "Re-running policy evaluation against a stored booking
 * reproduces the verdict and reason string byte-identical."
 *
 * This is what makes an audit years later possible, and it is the reason policy
 * evaluation takes no clock and no randomness.
 */
import { makeHarness, book } from "./harness.ts";
import { replay } from "../../src/core/policy.ts";
import { money } from "../../src/core/money.ts";
import type { Booking, Policy } from "../../src/core/types.ts";

describe("A12 — a stored verdict is reproducible", () => {
  it("replays byte-identically from the frozen booking snapshot", async () => {
    const h = await makeHarness();
    await h.login();
    const policy = await h.getPolicy();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;

    const created = await book(h, s.searchId, offer);
    expect(created.status).toBe(201);
    const booking = created.body.booking as Booking;

    const again = replay(booking, policy as Policy);
    expect(JSON.stringify(again)).toBe(JSON.stringify(booking.verdict));
    expect(again.reason).toBe(booking.verdict.reason);
    expect(again.policyVersion).toBe(booking.verdict.policyVersion);
  }, 60000);

  it("keeps the old verdict readable after the policy is changed", async () => {
    const h = await makeHarness();
    await h.login();
    const before = await h.getPolicy();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;
    const created = await book(h, s.searchId, offer);
    const booking = created.body.booking as Booking;

    // Tighten the policy after the fact.
    await h.setPolicy({
      caps: [{ cityTier: "metro", city: null, perNight: money(100000, "INR") }],
    });
    const after = await h.getPolicy();
    expect(after.version).toBeGreaterThan(before.version);

    // The stored verdict is untouched, and replaying against the ORIGINAL version
    // still reproduces it.
    const stored = await h.agent.get(`/api/bookings/${booking.id}`);
    expect(stored.body.booking.verdict.reason).toBe(booking.verdict.reason);
    expect(replay(booking, before as Policy).reason).toBe(booking.verdict.reason);
  }, 60000);
});
