/**
 * Auth, ops and admin-authorisation behaviour.
 */

import request from "supertest";

import { createApp, type AppDeps } from "../../src/server/index.ts";
import { createMemoryStore } from "../../src/store/FileStore.ts";
import { createFixtureRateSources } from "../../src/supply/FixtureRateSource.ts";
import { createLocalRouteSource } from "../../src/routing/LocalRouteSource.ts";
import { createSandboxCardIssuer } from "../../src/payments/SandboxCardIssuer.ts";

const FIXED_NOW = new Date("2026-06-01T09:00:00.000Z");

function deps(): AppDeps {
  return {
    store: createMemoryStore(),
    sources: createFixtureRateSources(),
    routes: createLocalRouteSource(),
    issuer: createSandboxCardIssuer(),
    now: () => FIXED_NOW,
  };
}

describe("auth", () => {
  it("JIT-creates the traveller on first login and makes the first one an admin", async () => {
    const app = createApp(deps());

    const first = await request(app)
      .post("/api/auth/login")
      .send({ email: "ada@acme.test", name: "Ada Byron" })
      .expect(200);

    expect(first.body.traveller.email).toBe("ada@acme.test");
    expect(first.body.traveller.name).toBe("Ada Byron");
    expect(first.body.traveller.isAdmin).toBe(true);
    expect(first.body.traveller.entityId).toBe("acme");
    expect(first.body.traveller.createdAt).toBe(FIXED_NOW.toISOString());

    const second = await request(app)
      .post("/api/auth/login")
      .send({ email: "grace@acme.test" })
      .expect(200);
    expect(second.body.traveller.isAdmin).toBe(false);

    // Logging in again is not a second traveller.
    const again = await request(app)
      .post("/api/auth/login")
      .send({ email: "ada@acme.test" })
      .expect(200);
    expect(again.body.traveller.id).toBe(first.body.traveller.id);
  });

  it("rejects a malformed login body with 400 invalid_request", async () => {
    const app = createApp(deps());
    const res = await request(app).post("/api/auth/login").send({ email: "nope" }).expect(400);
    expect(res.body.error.code).toBe("invalid_request");
    expect(typeof res.body.error.message).toBe("string");
  });

  it("GET /api/me is 401 without a session and 200 with one", async () => {
    const app = createApp(deps());
    const anon = await request(app).get("/api/me").expect(401);
    expect(anon.body.error.code).toBe("unauthenticated");

    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "ada@acme.test" }).expect(200);
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.traveller.email).toBe("ada@acme.test");

    await agent.post("/api/auth/logout").expect(204);
    await agent.get("/api/me").expect(401);
  });

  it("refuses a tampered session cookie", async () => {
    const app = createApp(deps());
    await request(app)
      .get("/api/me")
      .set("Cookie", "sm_session=eyJ0aWQiOiJ0cnZfZmFrZSIsImlhdCI6MH0.not-a-real-signature")
      .expect(401);
  });
});

describe("admin authorisation", () => {
  it("401s anonymously and 403s a non-admin traveller", async () => {
    const app = createApp(deps());
    await request(app).get("/api/admin/policy").expect(401);

    const admin = request.agent(app);
    await admin.post("/api/auth/login").send({ email: "admin@acme.test" }).expect(200);
    await admin.get("/api/admin/policy").expect(200);

    const plain = request.agent(app);
    await plain.post("/api/auth/login").send({ email: "bob@acme.test" }).expect(200);
    const denied = await plain.get("/api/admin/policy").expect(403);
    expect(denied.body.error.code).toBe("forbidden");
    await plain.get("/api/admin/bookings").expect(403);
    await plain.get("/api/admin/bookings.csv").expect(403);
    await plain.get("/api/admin/source-log").expect(403);
  });

  it("seeds the acme policy on first boot and versions every save", async () => {
    const app = createApp(deps());
    const admin = request.agent(app);
    await admin.post("/api/auth/login").send({ email: "admin@acme.test" }).expect(200);

    const seeded = await admin.get("/api/admin/policy").expect(200);
    const policy = seeded.body.policy;
    expect(policy.version).toBe(1);
    expect(policy.entityId).toBe("acme");
    expect(policy.requireFlexible).toBe(false);
    expect(policy.blockedCountries).toEqual([]);
    expect(policy.costCentres).toEqual(["ENG-OPS", "SALES", "FINANCE"]);
    expect(policy.defaultCostCentre).toBe("ENG-OPS");
    const capFor = (tier: string): number =>
      policy.caps.find((c: { cityTier: string }) => c.cityTier === tier).perNight.minor;
    expect(capFor("metro")).toBe(900_000);
    expect(capFor("tier1")).toBe(700_000);
    expect(capFor("tier2")).toBe(500_000);

    const saved = await admin
      .put("/api/admin/policy")
      .send({
        caps: policy.caps,
        requireFlexible: true,
        blockedCountries: ["ae"],
        blockedSuppliers: [],
        costCentres: ["ENG-OPS", "SALES", "FINANCE"],
        defaultCostCentre: "SALES",
        incidentalsBufferMinor: 100_000,
      })
      .expect(200);
    expect(saved.body.policy.version).toBe(2);
    expect(saved.body.policy.blockedCountries).toEqual(["AE"]);
    expect(saved.body.policy.updatedBy).toBe("admin@acme.test");
    expect(saved.body.policy.updatedAt).toBe(FIXED_NOW.toISOString());

    // Version 1 is still readable — A12 replays against the version that applied.
    const store = (await admin.get("/api/admin/policy")).body.policy;
    expect(store.version).toBe(2);
  });

  it("rejects an invalid policy with 400 invalid_policy", async () => {
    const app = createApp(deps());
    const admin = request.agent(app);
    await admin.post("/api/auth/login").send({ email: "admin@acme.test" }).expect(200);

    const noCaps = await admin
      .put("/api/admin/policy")
      .send({
        caps: [],
        requireFlexible: false,
        blockedCountries: [],
        blockedSuppliers: [],
        costCentres: ["ENG-OPS"],
        defaultCostCentre: "ENG-OPS",
        incidentalsBufferMinor: 0,
      })
      .expect(400);
    expect(noCaps.body.error.code).toBe("invalid_policy");

    const badDefault = await admin
      .put("/api/admin/policy")
      .send({
        caps: [{ cityTier: "metro", city: null, perNight: { minor: 900_000, currency: "INR" } }],
        requireFlexible: false,
        blockedCountries: [],
        blockedSuppliers: [],
        costCentres: ["ENG-OPS"],
        defaultCostCentre: "NOPE",
        incidentalsBufferMinor: 0,
      })
      .expect(400);
    expect(badDefault.body.error.code).toBe("invalid_policy");
  });
});

describe("ops", () => {
  it("reports health and version", async () => {
    const app = createApp(deps());
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.sources.length).toBe(4);
    for (const s of health.body.sources) {
      expect(typeof s.id).toBe("string");
      expect(s.ok).toBe(true);
    }

    const version = await request(app).get("/api/version").expect(200);
    expect(version.body.slice).toBe(1);
    expect(typeof version.body.version).toBe("string");
    expect(version.body.policyVersion).toBe(1);
  });

  it("404s an unknown api path with the standard envelope", async () => {
    const app = createApp(deps());
    const res = await request(app).get("/api/nope").expect(404);
    expect(res.body.error.code).toBe("not_found");
  });
});
