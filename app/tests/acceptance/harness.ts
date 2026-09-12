/**
 * Acceptance harness. Builds the real app — real policy engine, real fixture
 * supply, real ranking, real card issuer — over an in-memory store with an
 * injectable clock. No mocks of our own code: these tests must exercise the
 * product, not a stand-in for it.
 */
import request from "supertest";
import type { Express } from "express";
import { createApp, type AppDeps } from "../../src/server/index.ts";
import { createMemoryStore } from "../../src/store/FileStore.ts";
import { createFixtureRateSources } from "../../src/supply/FixtureRateSource.ts";
import { createLocalRouteSource } from "../../src/routing/LocalRouteSource.ts";
import { createSandboxCardIssuer } from "../../src/payments/SandboxCardIssuer.ts";
import { defaultChaos, type ChaosConfig } from "../../src/supply/fixtures/adversarial.ts";
import type { Money, Policy, RankedOffer } from "../../src/core/types.ts";

export interface HarnessOptions {
  chaos?: Partial<ChaosConfig>;
  now?: Date;
  alwaysDeclineRefs?: string[];
}

export interface Harness {
  app: Express;
  agent: ReturnType<typeof request.agent>;
  setNow(d: Date): void;
  login(email?: string, name?: string): Promise<void>;
  search(anchorQuery?: string, nights?: number): Promise<SearchResult>;
  setPolicy(patch: Partial<Policy>): Promise<Policy>;
  getPolicy(): Promise<Policy>;
}

export interface SearchResult {
  searchId: string;
  results: RankedOffer[];
  inPolicy: RankedOffer[];
  blocked: RankedOffer[];
  sources: unknown[];
}

export const ANCHOR = "Bandra Kurla Complex";

/** Stable future dates so fixtures and cancellation windows are predictable. */
export function dateRange(nights = 4): { checkIn: string; checkOut: string } {
  const inDate = new Date(Date.UTC(2026, 9, 12));
  const outDate = new Date(inDate.getTime() + nights * 86400000);
  return {
    checkIn: inDate.toISOString().slice(0, 10),
    checkOut: outDate.toISOString().slice(0, 10),
  };
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  let current = opts.now ?? new Date(Date.UTC(2026, 8, 20, 9, 0, 0));
  const chaos: ChaosConfig = { ...defaultChaos(), ...opts.chaos };

  const deps: AppDeps = {
    store: createMemoryStore(),
    sources: createFixtureRateSources({ chaos }),
    routes: createLocalRouteSource(),
    issuer: createSandboxCardIssuer(
      opts.alwaysDeclineRefs ? { alwaysDeclineRefs: opts.alwaysDeclineRefs } : {},
    ),
    now: () => current,
  };

  const app = createApp(deps);
  const agent = request.agent(app);

  const h: Harness = {
    app,
    agent,
    setNow(d) {
      current = d;
    },
    async login(email = "asha@acme.test", name = "Asha Rao") {
      const res = await agent.post("/api/auth/login").send({ email, name });
      if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
    },
    async search(anchorQuery = ANCHOR, nights = 4) {
      const { checkIn, checkOut } = dateRange(nights);
      const started = await agent
        .post("/api/search")
        .send({ anchorQuery, checkIn, checkOut, guests: 1, rooms: 1 });
      if (started.status !== 202) {
        throw new Error(`search failed: ${started.status} ${started.text}`);
      }
      const searchId = started.body.searchId as string;
      const settled = await waitForSettled(agent, searchId);
      const results = (settled.results ?? []) as RankedOffer[];
      return {
        searchId,
        results,
        inPolicy: results.filter((r) => r.verdict.state === "in"),
        blocked: results.filter((r) => r.verdict.state === "blocked"),
        sources: settled.sources ?? [],
      };
    },
    async getPolicy() {
      const res = await agent.get("/api/admin/policy");
      if (res.status !== 200) throw new Error(`getPolicy: ${res.status} ${res.text}`);
      return res.body.policy as Policy;
    },
    async setPolicy(patch) {
      const currentPolicy = await h.getPolicy();
      const {
        version: _v,
        updatedAt: _u,
        updatedBy: _b,
        ...rest
      } = { ...currentPolicy, ...patch } as Policy & Record<string, unknown>;
      const res = await agent.put("/api/admin/policy").send(rest);
      if (res.status !== 200) throw new Error(`setPolicy: ${res.status} ${res.text}`);
      return res.body.policy as Policy;
    },
  };

  return h;
}

/** Polls the settled snapshot. The SSE stream is tested separately. */
export async function waitForSettled(
  agent: ReturnType<typeof request.agent>,
  searchId: string,
  timeoutMs = 12000,
): Promise<{ results: RankedOffer[]; sources: unknown[] }> {
  const deadline = Date.now() + timeoutMs;
  let last: { results: RankedOffer[]; sources: unknown[] } = { results: [], sources: [] };
  while (Date.now() < deadline) {
    const res = await agent.get(`/api/search/${searchId}`);
    if (res.status === 200) {
      last = { results: res.body.results ?? [], sources: res.body.sources ?? [] };
      const srcs = (res.body.sources ?? []) as Array<{ status?: string }>;
      const allDone =
        srcs.length > 0 && srcs.every((s) => s.status === "answered" || s.status === "failed");
      if (allDone) return last;
    }
    await sleep(120);
  }
  return last;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function idemKey(tag = "k"): string {
  return `${tag}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** Books an offer the way the web client does. */
export async function book(
  h: Harness,
  searchId: string,
  offer: RankedOffer,
  opts: { key?: string; acceptedTotal?: Money; costCentre?: string } = {},
) {
  return h.agent
    .post("/api/bookings")
    .set("Idempotency-Key", opts.key ?? idemKey())
    .send({
      searchId,
      offerId: offer.offer.rate.id,
      costCentre: opts.costCentre ?? "ENG-OPS",
      acceptedTotal: opts.acceptedTotal ?? offer.offer.rate.allInTotal,
    });
}

/**
 * Binds the app to a real port. supertest's agent spins an ephemeral server per
 * request, which collapses under genuine concurrency (ECONNRESET) — so any test
 * that means "50 at once" must talk to one real listener.
 */
export interface BoundApp {
  baseUrl: string;
  cookie: string;
  close(): Promise<void>;
}

export async function bindHarness(h: Harness, email = "load@acme.test"): Promise<BoundApp> {
  const server = h.app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port bound");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name: "Load Tester" }),
  });
  if (!res.ok) throw new Error(`bound login failed: ${res.status}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("no session cookie returned");

  return {
    baseUrl,
    cookie,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
