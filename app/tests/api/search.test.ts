import { createRuleIntentParser } from "../../src/intent/RuleIntentParser.ts";
/**
 * Streaming search: the fan-out, the SSE event sequence and graceful degradation
 * when a source times out (A24).
 */

import request from "supertest";

import { createApp, type AppDeps } from "../../src/server/index.ts";
import { createMemoryStore } from "../../src/store/FileStore.ts";
import { createFixtureRateSources } from "../../src/supply/FixtureRateSource.ts";
import { createLocalRouteSource } from "../../src/routing/LocalRouteSource.ts";
import { createSandboxCardIssuer } from "../../src/payments/SandboxCardIssuer.ts";
import { FIXTURE_ANCHORS, resolveAnchor } from "../../src/supply/fixtures/anchors.ts";
import type { RateSource } from "../../src/supply/RateSource.ts";

const FIXED_NOW = new Date("2026-06-01T09:00:00.000Z");
const ANCHOR = FIXTURE_ANCHORS[0]!;
const QUERY = { anchorQuery: ANCHOR.label, checkIn: "2026-06-11", checkOut: "2026-06-15" };

function deps(sources?: RateSource[]): AppDeps {
  return {
    store: createMemoryStore(),
    sources: sources ?? createFixtureRateSources(),
    routes: createLocalRouteSource(),
    issuer: createSandboxCardIssuer(),
    now: () => FIXED_NOW,
    notifiers: [],
    intentParser: createRuleIntentParser(),
    resolveAnchor,
    knownAnchors: FIXTURE_ANCHORS,
    publicBaseUrl: "http://localhost:8787",
    demo: false,
  };
}

async function signedIn(app: ReturnType<typeof createApp>) {
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: "ada@acme.test" }).expect(200);
  return agent;
}

interface SseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const nameLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (nameLine === undefined || dataLine === undefined) continue;
    events.push({
      event: nameLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>,
    });
  }
  return events;
}

describe("POST /api/search", () => {
  it("returns 202 immediately with the session and the source list", async () => {
    const app = createApp(deps());
    const agent = await signedIn(app);

    const started = Date.now();
    const res = await agent.post("/api/search").send(QUERY).expect(202);
    const elapsed = Date.now() - started;

    expect(typeof res.body.searchId).toBe("string");
    expect(res.body.anchor.label).toBe(ANCHOR.label);
    expect(res.body.query.nights).toBe(4);
    expect(res.body.sources).toHaveLength(4);
    // It must not block on the slowest source (~1800ms).
    expect(elapsed).toBeLessThan(1200);
  });

  it("400 anchor_not_found for an unresolvable anchor", async () => {
    const app = createApp(deps());
    const agent = await signedIn(app);
    const res = await agent
      .post("/api/search")
      .send({ ...QUERY, anchorQuery: "Tranquility Base, Mare Serenitatis" })
      .expect(400);
    expect(res.body.error.code).toBe("anchor_not_found");
  });

  it("400 invalid_request when check-out is not after check-in", async () => {
    const app = createApp(deps());
    const agent = await signedIn(app);
    const res = await agent
      .post("/api/search")
      .send({ ...QUERY, checkIn: "2026-06-15", checkOut: "2026-06-15" })
      .expect(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("401s an anonymous search", async () => {
    const app = createApp(deps());
    await request(app).post("/api/search").send(QUERY).expect(401);
  });
});

describe("GET /api/search/:id/events", () => {
  it("streams source events, re-ranked results and one done event", async () => {
    const app = createApp(deps());
    const agent = await signedIn(app);
    const { body } = await agent.post("/api/search").send(QUERY).expect(202);

    const stream = await agent.get(`/api/search/${body.searchId}/events`).expect(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(stream.text);
    const sourceEvents = events.filter((e) => e.event === "source");
    const resultEvents = events.filter((e) => e.event === "results");
    const doneEvents = events.filter((e) => e.event === "done");

    // One terminal event, and every source accounted for exactly once.
    expect(doneEvents).toHaveLength(1);
    expect(events[events.length - 1]!.event).toBe("done");
    expect(new Set(sourceEvents.map((e) => e.data.sourceId)).size).toBe(4);
    expect(resultEvents.length).toBeGreaterThan(0);

    for (const e of sourceEvents) {
      expect(["answered", "failed"]).toContain(e.data.status);
      expect(typeof e.data.durationMs).toBe("number");
    }

    const done = doneEvents[0]!.data as { answered: number; total: number; failed: number };
    expect(done.total).toBe(4);
    expect(done.answered + done.failed).toBe(4);

    // Each results event carries the FULL re-ranked list, not a delta.
    const counts = resultEvents.map((e) => (e.data.results as unknown[]).length);
    expect(counts[counts.length - 1]!).toBeGreaterThan(0);
  });

  it("404s an expired or unknown search", async () => {
    const app = createApp(deps());
    const agent = await signedIn(app);
    const res = await agent.get("/api/search/srch_nope/events").expect(404);
    expect(res.body.error.code).toBe("search_not_found");
  });

  it("degrades instead of erroring when a source times out", async () => {
    // A source that never answers must be marked failed and the page must still
    // be usable — the single most load-bearing behaviour in A24.
    const hung: RateSource = {
      id: "hung",
      displayName: "Hung Source",
      capabilities: { holds: false, maxHoldMinutes: 0, live: false, currencies: "any" },
      hold: () => Promise.reject(new Error("never")),
      releaseHold: async () => undefined,
      searchAvailability: (_q, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      priceCheck: async () => null,
      book: () => Promise.reject(new Error("never")),
      cancel: async () => undefined,
    };

    const app = createApp(deps([...createFixtureRateSources(), hung]));
    const agent = await signedIn(app);
    const { body } = await agent.post("/api/search").send(QUERY).expect(202);

    const snap = await agent.get(`/api/search/${body.searchId}`).expect(200);
    const hungState = snap.body.sources.find((s: { sourceId: string }) => s.sourceId === "hung");
    expect(hungState.status).toBe("failed");
    expect(snap.body.results.length).toBeGreaterThan(0);
  });
});

describe("GET /api/search/:id", () => {
  it("returns a settled snapshot ranked by commute with blocked offers included", async () => {
    const app = createApp(deps());
    const agent = await signedIn(app);
    const { body } = await agent.post("/api/search").send(QUERY).expect(202);

    const snap = await agent.get(`/api/search/${body.searchId}`).expect(200);
    expect(snap.body.searchId).toBe(body.searchId);
    expect(snap.body.anchor.label).toBe(ANCHOR.label);
    expect(snap.body.results.length).toBeGreaterThan(0);
    expect(typeof snap.body.blockedCount).toBe("number");

    const results = snap.body.results as {
      commute: { minutes: number };
      rank: number;
      rankReason: string;
      verdict: { state: string };
    }[];

    // Commute time ascending across the ranked (in-policy) head of the list.
    const ranked = results.filter((r) => r.verdict.state === "in");
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i]!.commute.minutes).toBeGreaterThanOrEqual(ranked[i - 1]!.commute.minutes);
    }
    // Only in-policy offers are numbered; blocked ones sit at rank 0 after them.
    for (const r of results.filter((x) => x.verdict.state === "blocked")) {
      expect(r.rank).toBe(0);
      expect(r.rankReason).toBe("");
    }
    expect(snap.body.blockedCount).toBe(results.filter((r) => r.verdict.state === "blocked").length);
  });
});
