import { describe, expect, it } from "vitest";
import type { AppDeps } from "../../src/server/index.ts";
import { DEMO_PAST_BOOKING_ID, seedBase, seedDemo } from "../../src/server/seed.ts";
import { createMemoryStore } from "../../src/store/FileStore.ts";
import { createFixtureRateSources } from "../../src/supply/FixtureRateSource.ts";
import { createLocalRouteSource } from "../../src/routing/LocalRouteSource.ts";
import { createSandboxCardIssuer } from "../../src/payments/SandboxCardIssuer.ts";
import { createRuleIntentParser } from "../../src/intent/RuleIntentParser.ts";
import { FIXTURE_ANCHORS, resolveAnchor } from "../../src/supply/fixtures/anchors.ts";

function demoDeps(now: Date): AppDeps {
  const clock = (): Date => now;
  return {
    store: createMemoryStore(),
    sources: createFixtureRateSources({ now: clock }),
    routes: createLocalRouteSource(),
    issuer: createSandboxCardIssuer({}),
    notifiers: [],
    intentParser: createRuleIntentParser(),
    resolveAnchor,
    knownAnchors: FIXTURE_ANCHORS,
    now: clock,
    publicBaseUrl: "http://localhost:8787",
    demo: true,
  };
}

describe("demo seed", () => {
  const now = new Date(Date.UTC(2026, 8, 20, 9, 0, 0));

  it("seeds a settled past stay with its GST invoice", async () => {
    const deps = demoDeps(now);
    await seedDemo(deps);
    const stay = await deps.store.getBooking(DEMO_PAST_BOOKING_ID);
    expect(stay?.state).toBe("settled");
    const invoice = await deps.store.getInvoiceForBooking(DEMO_PAST_BOOKING_ID);
    expect(invoice).not.toBeNull();
    expect(stay?.invoiceId).toBe(invoice?.id);
  });

  // Production: an instance died after writing the stay but before issuing its
  // invoice, and every later cold start skipped the step because the stay existed.
  it("issues the invoice for a demo stay an earlier instance left without one", async () => {
    const seeded = demoDeps(now);
    await seedDemo(seeded);
    const stay = await seeded.store.getBooking(DEMO_PAST_BOOKING_ID);
    if (stay === null) throw new Error("demo stay was not seeded");

    const crashed = demoDeps(now);
    await seedBase(crashed);
    await crashed.store.putBooking({ ...stay, invoiceId: null });
    expect(await crashed.store.getInvoiceForBooking(DEMO_PAST_BOOKING_ID)).toBeNull();

    await seedDemo(crashed);
    const invoice = await crashed.store.getInvoiceForBooking(DEMO_PAST_BOOKING_ID);
    expect(invoice).not.toBeNull();
    expect((await crashed.store.getBooking(DEMO_PAST_BOOKING_ID))?.invoiceId).toBe(invoice?.id);

    // A second cold start neither re-issues nor burns another invoice number.
    await seedDemo(crashed);
    expect((await crashed.store.getInvoiceForBooking(DEMO_PAST_BOOKING_ID))?.number).toBe(invoice?.number);
  });
});
