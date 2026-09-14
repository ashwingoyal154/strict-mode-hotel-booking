/**
 * A2 — "Default order is commute time to the anchor."
 *
 * The ±3-minute maps comparison in the spec is a field check against a live
 * routing provider; Slice 1 runs a deterministic local RouteSource, so what is
 * machine-checkable here is the property that actually carries the product:
 * results are ordered by commute time and by nothing else.
 */
import { makeHarness } from "./harness.ts";

describe("A2 — commute-time ranking", () => {
  it("orders in-policy results by ascending commute minutes", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    expect(s.inPolicy.length).toBeGreaterThan(2);

    const minutes = s.inPolicy.map((r) => r.commute.minutes);
    const sorted = [...minutes].sort((a, b) => a - b);
    expect(minutes).toEqual(sorted);
  }, 60000);

  it("does not order by price — a cheaper result appears below a closer one", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();

    // Find any adjacent pair where the later one is cheaper. If ranking were
    // price-led this could not happen; it must happen at least once here.
    let foundCheaperBelow = false;
    for (let i = 1; i < s.inPolicy.length; i++) {
      const prev = s.inPolicy[i - 1];
      const cur = s.inPolicy[i];
      if (!prev || !cur) continue;
      if (cur.offer.rate.allInTotal.minor < prev.offer.rate.allInTotal.minor) {
        foundCheaperBelow = true;
        expect(cur.commute.minutes).toBeGreaterThanOrEqual(prev.commute.minutes);
      }
    }
    expect(foundCheaperBelow).toBe(true);
  }, 60000);

  it("numbers ranks from 1 and explains rank 1 in words", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const numbered = s.results.filter((r) => r.verdict.state !== "blocked");
    const top = numbered[0];
    expect(top?.rank).toBe(1);
    expect(top?.rankReason).toBe("closest to your meeting");
    // Slice 2: in-policy and over-cap offers share one commute-ordered numbering.
    numbered.forEach((r, i) => expect(r.rank).toBe(i + 1));
    s.blocked.forEach((r) => expect(r.rank).toBe(0));
  }, 60000);

  it("gives every result a commute with a mode and a non-zero duration", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    for (const r of s.results) {
      expect(["walk", "transit", "drive"]).toContain(r.commute.mode);
      expect(r.commute.minutes).toBeGreaterThan(0);
      expect(r.commute.distanceMeters).toBeGreaterThan(0);
    }
  }, 60000);

  it("is deterministic — the same search twice yields the same order", async () => {
    const h = await makeHarness();
    await h.login();
    const a = await h.search();
    const b = await h.search();
    expect(a.inPolicy.map((r) => r.offer.rate.id)).toEqual(b.inPolicy.map((r) => r.offer.rate.id));
  }, 90000);
});
