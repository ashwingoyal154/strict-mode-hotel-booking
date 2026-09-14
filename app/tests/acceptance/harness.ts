/**
 * Acceptance harness. Builds the real app — real policy engine, real fixture
 * supply, real ranking, real card issuer, real approval engine — over an
 * in-memory store with an injectable clock. No mocks of our own code: these tests
 * exercise the product, not a stand-in for it.
 *
 * Slice 2: several people now act on one booking (traveller, approver, admin), so
 * the harness hands out one cookie-carrying agent per person against the same app.
 */
import request from "supertest";
import type { Express } from "express";
import { createApp, type AppDeps } from "../../src/server/index.ts";
import { createMemoryStore } from "../../src/store/FileStore.ts";
import { createFixtureRateSources } from "../../src/supply/FixtureRateSource.ts";
import { createLocalRouteSource } from "../../src/routing/LocalRouteSource.ts";
import { createSandboxCardIssuer } from "../../src/payments/SandboxCardIssuer.ts";
import { createRuleIntentParser } from "../../src/intent/RuleIntentParser.ts";
import { FIXTURE_ANCHORS, resolveAnchor } from "../../src/supply/fixtures/anchors.ts";
import { defaultChaos, type ChaosConfig } from "../../src/supply/fixtures/adversarial.ts";
import type { DirectoryEntry, Money, Policy, RankedOffer } from "../../src/core/types.ts";
import type { RateSource } from "../../src/supply/RateSource.ts";

export const CRON_SECRET = "acceptance-cron-secret";
process.env.CRON_SECRET = CRON_SECRET;

export type Agent = ReturnType<typeof request.agent>;

export interface HarnessOptions {
  chaos?: Partial<ChaosConfig>;
  now?: Date;
  alwaysDeclineRefs?: string[];
  /** Replace the fixture sources entirely — how gate S1 proves the seam holds. */
  sources?: RateSource[];
}

export interface Harness {
  app: Express;
  deps: AppDeps;
  /** The first person to sign in, and therefore the admin. */
  agent: Agent;
  now(): Date;
  setNow(d: Date): void;
  advanceMinutes(minutes: number): void;
  login(email?: string, name?: string): Promise<void>;
  /** A separate signed-in person against the same app. */
  as(email: string, name: string): Promise<Agent>;
  search(anchorQuery?: string, nights?: number, who?: Agent): Promise<SearchResult>;
  setPolicy(patch: Partial<Policy>): Promise<Policy>;
  getPolicy(): Promise<Policy>;
  uploadDirectory(entries: DirectoryEntry[]): Promise<unknown>;
  tick(): Promise<Record<string, number>>;
}

export interface SearchResult {
  searchId: string;
  results: RankedOffer[];
  /** state "in" — bookable in one tap */
  inPolicy: RankedOffer[];
  /** state "over" — bookable only through approval */
  overCap: RankedOffer[];
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
  const clock = (): Date => current;
  const chaos: ChaosConfig = { ...defaultChaos(), ...opts.chaos };

  const deps: AppDeps = {
    store: createMemoryStore(),
    sources: opts.sources ?? createFixtureRateSources({ chaos, now: clock }),
    routes: createLocalRouteSource(),
    issuer: createSandboxCardIssuer(
      opts.alwaysDeclineRefs ? { alwaysDeclineRefs: opts.alwaysDeclineRefs } : {},
    ),
    notifiers: [],
    intentParser: createRuleIntentParser(),
    resolveAnchor,
    knownAnchors: FIXTURE_ANCHORS,
    now: clock,
    publicBaseUrl: "http://localhost:8787",
    demo: false,
  };

  const app = createApp(deps);
  const agent = request.agent(app);

  const loginAgent = async (a: Agent, email: string, name: string): Promise<void> => {
    const res = await a.post("/api/auth/login").send({ email, name });
    if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${res.text}`);
  };

  const h: Harness = {
    app,
    deps,
    agent,
    now: clock,
    setNow(d) {
      current = d;
    },
    advanceMinutes(minutes) {
      current = new Date(current.getTime() + minutes * 60_000);
    },
    async login(email = "asha@acme.test", name = "Asha Rao") {
      await loginAgent(agent, email, name);
    },
    async as(email, name) {
      const a = request.agent(app);
      await loginAgent(a, email, name);
      return a;
    },
    async search(anchorQuery = ANCHOR, nights = 4, who = agent) {
      const { checkIn, checkOut } = dateRange(nights);
      const started = await who
        .post("/api/search")
        .send({ anchorQuery, checkIn, checkOut, guests: 1, rooms: 1 });
      if (started.status !== 202) {
        throw new Error(`search failed: ${started.status} ${started.text}`);
      }
      const searchId = started.body.searchId as string;
      const settled = await waitForSettled(who, searchId);
      const results = (settled.results ?? []) as RankedOffer[];
      return {
        searchId,
        results,
        inPolicy: results.filter((r) => r.verdict.state === "in"),
        overCap: results.filter((r) => r.verdict.state === "over"),
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
    async uploadDirectory(entries) {
      const res = await agent.post("/api/admin/directory").send({ entries });
      if (res.status !== 200) throw new Error(`directory: ${res.status} ${res.text}`);
      return res.body;
    },
    async tick() {
      const res = await agent.post("/api/cron/tick").set("Authorization", `Bearer ${CRON_SECRET}`);
      if (res.status !== 200) throw new Error(`tick: ${res.status} ${res.text}`);
      return res.body as Record<string, number>;
    },
  };

  return h;
}

/**
 * The approval cast: an admin who uploads the directory, then Asha (traveller) →
 * Meera (manager) → Vikram (VP). The admin signs in first so the JIT admin rule
 * lands on them rather than on the traveller.
 */
export async function withApprovalCast(h: Harness): Promise<{ asha: Agent; meera: Agent; vikram: Agent }> {
  await h.login("admin@acme.test", "Priya Admin");
  await h.uploadDirectory([
    { email: "admin@acme.test", name: "Priya Admin", managerEmail: null, costCentre: "FINANCE", isAdmin: true },
    { email: "asha@acme.test", name: "Asha Rao", managerEmail: "meera@acme.test", costCentre: "ENG-OPS", isAdmin: false },
    { email: "meera@acme.test", name: "Meera Iyer", managerEmail: "vikram@acme.test", costCentre: "ENG-OPS", isAdmin: false },
    { email: "vikram@acme.test", name: "Vikram Rao", managerEmail: null, costCentre: "ENG-OPS", isAdmin: false },
  ]);
  const asha = await h.as("asha@acme.test", "Asha Rao");
  const meera = await h.as("meera@acme.test", "Meera Iyer");
  const vikram = await h.as("vikram@acme.test", "Vikram Rao");
  return { asha, meera, vikram };
}

/** Polls the settled snapshot. The SSE stream is tested separately. */
export async function waitForSettled(
  agent: Agent,
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
  opts: {
    key?: string;
    acceptedTotal?: Money;
    costCentre?: string;
    justification?: { code: string; text: string };
    who?: Agent;
  } = {},
) {
  const who = opts.who ?? h.agent;
  return who
    .post("/api/bookings")
    .set("Idempotency-Key", opts.key ?? idemKey())
    .send({
      searchId,
      offerId: offer.offer.rate.id,
      costCentre: opts.costCentre ?? "ENG-OPS",
      acceptedTotal: opts.acceptedTotal ?? offer.offer.rate.allInTotal,
      ...(opts.justification ? { justification: opts.justification } : {}),
    });
}

export const JUSTIFICATION = {
  code: "client_site",
  text: "The client workshop is held in this building all week.",
};

/** Binds the app to a real port, for tests that mean genuine concurrency. */
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
