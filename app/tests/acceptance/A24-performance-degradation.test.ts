/**
 * A24 — "Search p95 under 3s and confirm p95 under 5s at 50 concurrent searches;
 * a source forced to time out degrades the page without erroring it."
 *
 * Measured against the fixture supply, whose slowest source sits at ~1.8s by
 * design, so this exercises the fan-out rather than a trivially fast path.
 */
import { makeHarness, book, dateRange, bindHarness, sleep } from "./harness.ts";

function p95(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1);
  return s[i] ?? 0;
}

describe("A24 — performance and graceful degradation", () => {
  it("keeps search p95 under 3s across 50 concurrent searches", async () => {
    const h = await makeHarness();
    const bound = await bindHarness(h);
    const { checkIn, checkOut } = dateRange(3);

    try {
      const runs = await Promise.all(
        Array.from({ length: 50 }, async () => {
          const t0 = Date.now();
          const started = await fetch(`${bound.baseUrl}/api/search`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: bound.cookie },
            body: JSON.stringify({
              anchorQuery: "Bandra Kurla Complex",
              checkIn,
              checkOut,
              guests: 1,
              rooms: 1,
            }),
          });
          if (started.status !== 202) return { ms: Number.POSITIVE_INFINITY, ok: false };
          const { searchId } = (await started.json()) as { searchId: string };

          // Poll the settled snapshot the way the client's stream would settle.
          const deadline = Date.now() + 10000;
          let settled = false;
          while (Date.now() < deadline) {
            const snap = await fetch(`${bound.baseUrl}/api/search/${searchId}`, {
              headers: { cookie: bound.cookie },
            });
            if (snap.ok) {
              const body = (await snap.json()) as { sources?: Array<{ status?: string }> };
              const srcs = body.sources ?? [];
              if (
                srcs.length > 0 &&
                srcs.every((x) => x.status === "answered" || x.status === "failed")
              ) {
                settled = true;
                break;
              }
            }
            await sleep(100);
          }
          return { ms: Date.now() - t0, ok: settled };
        }),
      );

      const failed = runs.filter((r) => !r.ok).length;
      expect(failed).toBe(0);
      const measured = p95(runs.map((r) => r.ms));
      console.log(`A24 search p95: ${measured}ms across ${runs.length} concurrent searches`);
      expect(measured).toBeLessThan(3000);
    } finally {
      await bound.close();
    }
  }, 180000);

  it("keeps confirm p95 under 5s", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const candidates = s.inPolicy.slice(0, 12);
    expect(candidates.length).toBeGreaterThan(0);

    const times: number[] = [];
    for (const offer of candidates) {
      const t0 = Date.now();
      const res = await book(h, s.searchId, offer);
      expect([201, 409, 410]).toContain(res.status);
      times.push(Date.now() - t0);
    }
    const measured = p95(times);
    // eslint-disable-next-line no-console
    console.log(`A24 confirm p95: ${measured}ms across ${times.length} confirms`);
    expect(measured).toBeLessThan(5000);
  }, 120000);

  it("degrades rather than errors when a source times out", async () => {
    const probe = await makeHarness();
    await probe.login();
    const baseline = await probe.search();
    const sourceIds = (baseline.sources as Array<{ id?: string; sourceId?: string }>).map(
      (s) => s.id ?? s.sourceId ?? "",
    );
    expect(sourceIds.filter(Boolean).length).toBeGreaterThan(1);

    const victim = sourceIds.filter(Boolean)[0] as string;
    const h = await makeHarness({ chaos: { enabled: true, timeoutSourceIds: [victim] } });
    await h.login();
    const s = await h.search();

    // The page still works: results exist, and the dead source is reported as failed.
    expect(s.results.length).toBeGreaterThan(0);
    const statuses = (s.sources as Array<{ id?: string; status?: string }>);
    const failed = statuses.filter((x) => x.status === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);

    // And a booking still completes from what did arrive.
    const offer = s.inPolicy[0];
    if (offer) {
      const res = await book(h, s.searchId, offer);
      expect([201, 409, 410]).toContain(res.status);
    }
  }, 90000);
});
