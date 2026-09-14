import { createRuleIntentParser } from "../../src/intent/RuleIntentParser.ts";
/**
 * Booking against the real fixture supply: the happy path, idempotency (A14),
 * policy enforcement at the API (A6), price parity (A3), the CSV export and the
 * immutable source log.
 */

import request from "supertest";

import { createApp, type AppDeps } from "../../src/server/index.ts";
import { createMemoryStore } from "../../src/store/FileStore.ts";
import { createFixtureRateSources } from "../../src/supply/FixtureRateSource.ts";
import { createLocalRouteSource } from "../../src/routing/LocalRouteSource.ts";
import { createSandboxCardIssuer } from "../../src/payments/SandboxCardIssuer.ts";
import { FIXTURE_ANCHORS, resolveAnchor } from "../../src/supply/fixtures/anchors.ts";
import {
  DRIFT_MARKER_SUFFIX,
  SOLD_OUT_MARKER_SUFFIX,
} from "../../src/supply/fixtures/adversarial.ts";
import { BOOKINGS_CSV_COLUMNS } from "../../src/server/csv.ts";
import type { RankedOffer, SourceLogEntry } from "../../src/core/types.ts";

const FIXED_NOW = new Date("2026-06-01T09:00:00.000Z");
const ANCHOR = FIXTURE_ANCHORS[0]!;
const QUERY = { anchorQuery: ANCHOR.label, checkIn: "2026-06-11", checkOut: "2026-06-15" };

function deps(): AppDeps {
  return {
    store: createMemoryStore(),
    sources: createFixtureRateSources(),
    routes: createLocalRouteSource(),
    issuer: createSandboxCardIssuer({ declineRate: 0 }),
    now: () => FIXED_NOW,
    notifiers: [],
    intentParser: createRuleIntentParser(),
    resolveAnchor,
    knownAnchors: FIXTURE_ANCHORS,
    publicBaseUrl: "http://localhost:8787",
    demo: false,
  };
}

type Agent = ReturnType<typeof request.agent>;

async function signIn(app: ReturnType<typeof createApp>, email: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email }).expect(200);
  return agent;
}

/** A settled search plus the first stable, in-policy offer in it. */
async function searchAndPick(agent: Agent): Promise<{
  searchId: string;
  pick: RankedOffer;
  results: RankedOffer[];
}> {
  const started = await agent.post("/api/search").send(QUERY).expect(202);
  const searchId = started.body.searchId as string;
  const snap = await agent.get(`/api/search/${searchId}`).expect(200);
  const results = snap.body.results as RankedOffer[];
  const pick = results.find(
    (r) =>
      r.verdict.state === "in" &&
      !r.offer.rate.id.endsWith(DRIFT_MARKER_SUFFIX) &&
      !r.offer.rate.id.endsWith(SOLD_OUT_MARKER_SUFFIX),
  );
  expect(pick).toBeDefined();
  return { searchId, pick: pick!, results };
}

describe("POST /api/bookings — happy path", () => {
  it("books at exactly the total the traveller accepted", async () => {
    const app = createApp(deps());
    const agent = await signIn(app, "ada@acme.test");
    const { searchId, pick } = await searchAndPick(agent);

    const res = await agent
      .post("/api/bookings")
      .set("Idempotency-Key", "11111111-1111-4111-8111-111111111111")
      .send({
        searchId,
        offerId: pick.offer.rate.id,
        costCentre: "ENG-OPS",
        acceptedTotal: pick.offer.rate.allInTotal,
      })
      .expect(201);

    const booking = res.body.booking;
    expect(booking.state).toBe("confirmed");
    expect(booking.confirmationCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(booking.costCentre).toBe("ENG-OPS");
    expect(booking.entityId).toBe("acme");
    expect(booking.createdAt).toBe(FIXED_NOW.toISOString());
    expect(booking.cancelledAt).toBeNull();
    expect(booking.supplierBookingRef).toBeTruthy();

    // A3: the number quoted is the number booked, to the minor unit.
    expect(booking.offer.rate.allInTotal).toEqual(pick.offer.rate.allInTotal);
    // A9: central billing, and A13: token + last4 only, never a PAN.
    expect(booking.card.tokenRef).toBeTruthy();
    expect(booking.card.last4).toMatch(/^\d{4}$/);
    expect(JSON.stringify(booking.card)).not.toMatch(/\d{12,}/);
    // The verdict is frozen with the booking (A12 replays this, not live policy).
    expect(booking.verdict.state).toBe("in");
    expect(typeof booking.verdict.reason).toBe("string");
    expect(booking.verdict.policyVersion).toBe(1);
    // The snapshot is a copy, not a reference into live supply.
    expect(booking.anchor.label).toBe(ANCHOR.label);
    expect(booking.commute.minutes).toBe(pick.commute.minutes);

    const list = await agent.get("/api/bookings").expect(200);
    expect(list.body.bookings).toHaveLength(1);
    const one = await agent.get(`/api/bookings/${booking.id}`).expect(200);
    expect(one.body.booking.id).toBe(booking.id);
  });

  it("defaults the cost centre and rejects one that is not on the policy", async () => {
    const app = createApp(deps());
    const agent = await signIn(app, "ada@acme.test");
    const { searchId, pick } = await searchAndPick(agent);

    const bad = await agent
      .post("/api/bookings")
      .set("Idempotency-Key", "cc-invalid-key-0000000001")
      .send({
        searchId,
        offerId: pick.offer.rate.id,
        costCentre: "NOT-A-CENTRE",
        acceptedTotal: pick.offer.rate.allInTotal,
      })
      .expect(400);
    expect(bad.body.error.code).toBe("invalid_cost_centre");

    const ok = await agent
      .post("/api/bookings")
      .set("Idempotency-Key", "cc-default-key-0000000002")
      .send({ searchId, offerId: pick.offer.rate.id, acceptedTotal: pick.offer.rate.allInTotal })
      .expect(201);
    expect(ok.body.booking.costCentre).toBe("ENG-OPS");
  });

  it("404s another traveller's booking as 403 and an unknown id as 404", async () => {
    const app = createApp(deps());
    const ada = await signIn(app, "ada@acme.test");
    const { searchId, pick } = await searchAndPick(ada);
    const res = await ada
      .post("/api/bookings")
      .set("Idempotency-Key", "ownership-key-000000000001")
      .send({ searchId, offerId: pick.offer.rate.id, acceptedTotal: pick.offer.rate.allInTotal })
      .expect(201);

    const bob = await signIn(app, "bob@acme.test");
    const denied = await bob.get(`/api/bookings/${res.body.booking.id}`).expect(403);
    expect(denied.body.error.code).toBe("forbidden");
    await bob.get("/api/bookings/bkg_nope").expect(404);
    expect((await bob.get("/api/bookings").expect(200)).body.bookings).toHaveLength(0);
  });
});

describe("idempotency (A14)", () => {
  it("400 idempotency_key_required when the header is missing", async () => {
    const app = createApp(deps());
    const agent = await signIn(app, "ada@acme.test");
    const { searchId, pick } = await searchAndPick(agent);
    const res = await agent
      .post("/api/bookings")
      .send({ searchId, offerId: pick.offer.rate.id, acceptedTotal: pick.offer.rate.allInTotal })
      .expect(400);
    expect(res.body.error.code).toBe("idempotency_key_required");
  });

  it("replays the same booking with 200 on a repeated key", async () => {
    const app = createApp(deps());
    const agent = await signIn(app, "ada@acme.test");
    const { searchId, pick } = await searchAndPick(agent);
    const body = {
      searchId,
      offerId: pick.offer.rate.id,
      acceptedTotal: pick.offer.rate.allInTotal,
    };
    const key = "22222222-2222-4222-8222-222222222222";

    const first = await agent.post("/api/bookings").set("Idempotency-Key", key).send(body).expect(201);
    const second = await agent.post("/api/bookings").set("Idempotency-Key", key).send(body).expect(200);

    expect(second.body.booking.id).toBe(first.body.booking.id);
    expect(second.body.booking.confirmationCode).toBe(first.body.booking.confirmationCode);
    expect((await agent.get("/api/bookings").expect(200)).body.bookings).toHaveLength(1);

    // No second supplier call and no second card for the replay.
    const log = await sourceLog(agent);
    expect(log.filter((e) => e.operation === "book")).toHaveLength(1);
    expect(log.filter((e) => e.operation === "issueCard")).toHaveLength(1);
  });

  it("yields exactly one booking for two CONCURRENT posts of the same key", async () => {
    const app = createApp(deps());
    const agent = await signIn(app, "ada@acme.test");
    const { searchId, pick } = await searchAndPick(agent);
    const body = {
      searchId,
      offerId: pick.offer.rate.id,
      acceptedTotal: pick.offer.rate.allInTotal,
    };
    const key = "33333333-3333-4333-8333-333333333333";

    const [a, b] = await Promise.all([
      agent.post("/api/bookings").set("Idempotency-Key", key).send(body),
      agent.post("/api/bookings").set("Idempotency-Key", key).send(body),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.booking.id).toBe(b.body.booking.id);

    const list = await agent.get("/api/bookings").expect(200);
    expect(list.body.bookings).toHaveLength(1);

    const log = await sourceLog(agent);
    expect(log.filter((e) => e.operation === "book")).toHaveLength(1);
    expect(log.filter((e) => e.operation === "issueCard")).toHaveLength(1);
  });
});

describe("policy is enforced at the API (A6)", () => {
  it("403 blocked_by_policy when posting a rate the current policy blocks", async () => {
    const app = createApp(deps());
    const admin = await signIn(app, "admin@acme.test");
    const { searchId, pick } = await searchAndPick(admin);

    // Block the offer's supplier after the search, then post the offer straight
    // at the endpoint. The server re-evaluates and must refuse.
    const policy = (await admin.get("/api/admin/policy").expect(200)).body.policy;
    await admin
      .put("/api/admin/policy")
      .send({
        caps: policy.caps,
        requireFlexible: false,
        blockedCountries: [],
        blockedSuppliers: [pick.offer.rate.sourceId],
        costCentres: policy.costCentres,
        defaultCostCentre: policy.defaultCostCentre,
        incidentalsBufferMinor: policy.incidentalsBufferMinor,
      })
      .expect(200);

    const res = await admin
      .post("/api/bookings")
      .set("Idempotency-Key", "blocked-supplier-key-00001")
      .send({ searchId, offerId: pick.offer.rate.id, acceptedTotal: pick.offer.rate.allInTotal })
      .expect(403);

    expect(res.body.error.code).toBe("blocked_by_policy");
    expect(res.body.error.detail.verdict.state).toBe("blocked");
    expect(res.body.error.detail.verdict.reasonCode).toBe("blocked_supplier");
    expect((await admin.get("/api/bookings").expect(200)).body.bookings).toHaveLength(0);
  });

  it("403 blocked_by_policy for an offer the results page marked blocked", async () => {
    const app = createApp(deps());
    const agent = await signIn(app, "ada@acme.test");
    // Slice 2: over cap is "over", and results show one row per hotel preferring its
    // bookable rate, so a hotel only reads as blocked when every rate it has is
    // blocked. Blocking the country does exactly that.
    const current = (await agent.get("/api/admin/policy").expect(200)).body.policy;
    const { version: _v, updatedAt: _u, updatedBy: _b, ...rest } = current;
    await agent.put("/api/admin/policy").send({ ...rest, blockedCountries: ["IN"] }).expect(200);

    const started = await agent.post("/api/search").send(QUERY).expect(202);
    const snap = await agent.get(`/api/search/${started.body.searchId}`).expect(200);
    const results = snap.body.results as RankedOffer[];
    const blocked = results.find(
      (r) =>
        r.verdict.state === "blocked" &&
        !r.offer.rate.id.endsWith(DRIFT_MARKER_SUFFIX) &&
        !r.offer.rate.id.endsWith(SOLD_OUT_MARKER_SUFFIX),
    );
    expect(blocked).toBeDefined();
    expect(blocked?.verdict.reasonCode).toBe("blocked_country");

    const res = await agent
      .post("/api/bookings")
      .set("Idempotency-Key", "blocked-offer-key-0000001")
      .send({
        searchId: started.body.searchId,
        offerId: blocked!.offer.rate.id,
        acceptedTotal: blocked!.offer.rate.allInTotal,
      })
      .expect(403);
    expect(res.body.error.code).toBe("blocked_by_policy");
  });
});

describe("price parity (A3)", () => {
  it("409 price_drift when the accepted total is not the current total", async () => {
    const app = createApp(deps());
    const agent = await signIn(app, "ada@acme.test");
    const { searchId, pick } = await searchAndPick(agent);
    const stale = {
      minor: pick.offer.rate.allInTotal.minor - 150_00,
      currency: pick.offer.rate.allInTotal.currency,
    };

    const res = await agent
      .post("/api/bookings")
      .set("Idempotency-Key", "drift-key-0000000000000001")
      .send({ searchId, offerId: pick.offer.rate.id, acceptedTotal: stale })
      .expect(409);

    expect(res.body.error.code).toBe("price_drift");
    expect(res.body.error.detail.kind).toBe("price_drift");
    expect(res.body.error.detail.acceptedTotal).toEqual(stale);
    expect(res.body.error.detail.currentTotal).toEqual(pick.offer.rate.allInTotal);
    expect(res.body.error.detail.deltaMinor).toBe(
      pick.offer.rate.allInTotal.minor - stale.minor,
    );
    // Nothing was absorbed and nothing was booked.
    expect((await agent.get("/api/bookings").expect(200)).body.bookings).toHaveLength(0);

    // The same key is retryable after a failure, at the right number.
    await agent
      .post("/api/bookings")
      .set("Idempotency-Key", "drift-key-0000000000000001")
      .send({ searchId, offerId: pick.offer.rate.id, acceptedTotal: pick.offer.rate.allInTotal })
      .expect(201);
  });

  it("404s a search that has expired and an offer that was never in it", async () => {
    const app = createApp(deps());
    const agent = await signIn(app, "ada@acme.test");
    const { searchId, pick } = await searchAndPick(agent);

    const noSearch = await agent
      .post("/api/bookings")
      .set("Idempotency-Key", "no-search-key-00000000001")
      .send({ searchId: "srch_gone", offerId: pick.offer.rate.id, acceptedTotal: pick.offer.rate.allInTotal })
      .expect(404);
    expect(noSearch.body.error.code).toBe("search_not_found");

    const noOffer = await agent
      .post("/api/bookings")
      .set("Idempotency-Key", "no-offer-key-000000000001")
      .send({ searchId, offerId: "rate_not_in_this_search", acceptedTotal: pick.offer.rate.allInTotal })
      .expect(404);
    expect(noOffer.body.error.code).toBe("offer_not_found");
  });
});

describe("admin reporting", () => {
  it("exports the frozen CSV column list and one row per booking", async () => {
    const app = createApp(deps());
    const admin = await signIn(app, "admin@acme.test");
    const { searchId, pick } = await searchAndPick(admin);
    const booked = await admin
      .post("/api/bookings")
      .set("Idempotency-Key", "csv-key-00000000000000001")
      .send({ searchId, offerId: pick.offer.rate.id, acceptedTotal: pick.offer.rate.allInTotal })
      .expect(201);

    const csv = await admin.get("/api/admin/bookings.csv").expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.text.trim().split("\n");
    expect(lines[0]).toBe(BOOKINGS_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(2);
    expect(lines[1]!.startsWith(`${booked.body.booking.confirmationCode},`)).toBe(true);
    expect(lines[1]).toContain("admin@acme.test");
    expect(lines[1]).toContain(String(pick.offer.rate.allInTotal.minor));
    expect(lines[1]).toContain("confirmed");

    const entity = await admin.get("/api/admin/bookings").expect(200);
    expect(entity.body.bookings).toHaveLength(1);
  });

  it("records every supplier and card call in the append-only source log", async () => {
    const app = createApp(deps());
    const admin = await signIn(app, "admin@acme.test");
    const { searchId, pick } = await searchAndPick(admin);
    await admin
      .post("/api/bookings")
      .set("Idempotency-Key", "log-key-00000000000000001")
      .send({ searchId, offerId: pick.offer.rate.id, acceptedTotal: pick.offer.rate.allInTotal })
      .expect(201);

    const entries = await sourceLog(admin);
    const ops = new Set(entries.map((e) => e.operation));
    expect(ops.has("search")).toBe(true);
    expect(ops.has("priceCheck")).toBe(true);
    expect(ops.has("book")).toBe(true);
    expect(ops.has("issueCard")).toBe(true);

    for (const e of entries) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.at).toBe("string");
      expect(typeof e.correlationId).toBe("string");
      expect(typeof e.durationMs).toBe("number");
    }
    // A13: nothing card-like anywhere in the log.
    expect(JSON.stringify(entries)).not.toMatch(/\d{12,}/);

    // The booking's calls share one correlation id.
    const bookEntry = entries.find((e) => e.operation === "book")!;
    const issueEntry = entries.find((e) => e.operation === "issueCard")!;
    expect(bookEntry.correlationId).toBe(issueEntry.correlationId);

    const limited = await admin.get("/api/admin/source-log?limit=2").expect(200);
    expect(limited.body.entries).toHaveLength(2);
  });
});

/** The first traveller signed in by each test is the admin, so it can read this. */
async function sourceLog(agent: Agent): Promise<SourceLogEntry[]> {
  const res = await agent.get("/api/admin/source-log?limit=1000").expect(200);
  return res.body.entries as SourceLogEntry[];
}
