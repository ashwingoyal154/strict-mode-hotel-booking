/**
 * A6 — "A blocked rate cannot be booked through the UI OR by posting it directly
 * to /bookings."
 *
 * The UI hiding a thing is not enforcement. This test bypasses the UI entirely.
 */
import { makeHarness, book } from "./harness.ts";
import { money } from "../../src/core/money.ts";

describe("A6 — policy is enforced at the API, not in the UI", () => {
  it("refuses a direct POST of an over-cap rate that carries no justification (Slice 2: 422)", async () => {
    const h = await makeHarness();
    await h.login();

    // Squeeze the cap so most inventory falls outside it.
    await h.setPolicy({
      caps: [
        { cityTier: "metro", city: null, perNight: money(400000, "INR") },
        { cityTier: "metro", city: "Mumbai", perNight: money(400000, "INR") },
        { cityTier: "tier1", city: null, perNight: money(400000, "INR") },
        { cityTier: "tier2", city: null, perNight: money(400000, "INR") },
      ],
    });

    const s = await h.search();
    expect(s.overCap.length).toBeGreaterThan(0);
    const over = s.overCap[0];
    if (!over) return;

    expect(over.verdict.state).toBe("over");
    expect(over.verdict.reasonCode).toBe("over_cap");

    const res = await book(h, s.searchId, over);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("justification_required");
    expect(res.body.error.detail.verdict.reasonCode).toBe("over_cap");
    expect(Array.isArray(res.body.error.detail.reasons)).toBe(true);

    const mine = await h.agent.get("/api/bookings");
    expect(mine.body.bookings.length).toBe(0);
  }, 60000);

  it("still refuses a blocked rate with 403 even when a justification is supplied", async () => {
    const h = await makeHarness();
    await h.login();
    await h.setPolicy({ blockedCountries: ["IN"] });
    const s = await h.search();
    const blocked = s.blocked[0];
    expect(blocked).toBeDefined();
    if (!blocked) return;
    expect(blocked.verdict.reasonCode).toBe("blocked_country");
    const res = await book(h, s.searchId, blocked, {
      justification: { code: "client_site", text: "Trying to talk my way past a blocked country." },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("blocked_by_policy");
  }, 60000);

  it("rejects a non-refundable rate when the policy requires flexibility", async () => {
    const h = await makeHarness();
    await h.login();
    await h.setPolicy({ requireFlexible: true });

    const s = await h.search();
    const nonRefundable = s.results.find((r) => r.offer.rate.refundableUntil === null);
    expect(nonRefundable).toBeDefined();
    if (!nonRefundable) return;

    expect(nonRefundable.verdict.state).toBe("blocked");
    expect(nonRefundable.verdict.reasonCode).toBe("flex_required");

    const res = await book(h, s.searchId, nonRefundable);
    expect(res.status).toBe(403);
  }, 60000);

  it("states the arithmetic in the blocked reason rather than a bare label", async () => {
    const h = await makeHarness();
    await h.login();
    await h.setPolicy({
      caps: [
        { cityTier: "metro", city: null, perNight: money(500000, "INR") },
        { cityTier: "metro", city: "Mumbai", perNight: money(500000, "INR") },
      ],
    });
    const s = await h.search();
    const blocked = s.overCap.find((r) => r.verdict.reasonCode === "over_cap");
    expect(blocked).toBeDefined();
    if (!blocked) return;
    // Must name both the rate and the cap, and must not be a bare adjective.
    expect(blocked.verdict.reason).toMatch(/₹/);
    expect(blocked.verdict.reason).toMatch(/cap/i);
    expect(blocked.verdict.reason.length).toBeGreaterThan(20);
    expect(blocked.verdict.capPerNight).not.toBeNull();
    expect(blocked.verdict.overageMinor).toBeGreaterThan(0);
  }, 60000);
});
