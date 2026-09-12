/**
 * The HTTP app. Composition only: every decision lives in `src/core` (pure) or
 * behind a port (`RateSource`, `RouteSource`, `CardIssuer`, `Store`), so this
 * file knows which *kinds* of things exist and none of their implementations.
 *
 * `AppDeps` is the seam the tests use: an in-memory store, the fixture sources
 * and a frozen `now`. No route handler may call `new Date()` — the cancellation
 * window is a decision, and decisions must be reproducible (spec §3.3).
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import express, { type NextFunction, type Request, type Response } from "express";

import { money } from "../core/money.ts";
import type { Policy } from "../core/types.ts";
import { createSandboxCardIssuer } from "../payments/SandboxCardIssuer.ts";
import type { CardIssuer } from "../payments/CardIssuer.ts";
import { createLocalRouteSource } from "../routing/LocalRouteSource.ts";
import type { RouteSource } from "../routing/RouteSource.ts";
import { createFixtureRateSources } from "../supply/FixtureRateSource.ts";
import { chaosFromEnv } from "../supply/fixtures/adversarial.ts";
import type { RateSource } from "../supply/RateSource.ts";
import { createFileStore, createMemoryStore } from "../store/FileStore.ts";
import type { Store } from "../store/Store.ts";
import { instrumentCardIssuer, instrumentRateSource } from "./audit.ts";
import { createAuth, DEFAULT_ENTITY_ID } from "./auth.ts";
import { newId } from "../core/ids.ts";
import { createSearchRegistry } from "./search.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { bookingRoutes } from "./routes/bookings.ts";
import { fail, type ServerContext } from "./routes/http.ts";
import { opsRoutes } from "./routes/ops.ts";
import { searchRoutes } from "./routes/search.ts";

export interface AppDeps {
  store: Store;
  sources: RateSource[];
  routes: RouteSource;
  issuer: CardIssuer;
  now: () => Date;
}

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");

/**
 * The policy a fresh install boots with. Caps are nightly, in integer minor
 * units: tier fallbacks of ₹9,000 metro / ₹7,000 tier1 / ₹5,000 tier2, plus a
 * named-city override per launch city.
 *
 * The city rows are not redundant with the tier rows. A verdict names the level
 * that produced it, so a named city makes the one sentence a traveller reads when
 * a booking is blocked say "your ₹9,000 Mumbai cap" rather than "your ₹9,000
 * metro cap" — a travel policy is argued about in cities, not in tiers.
 */
export function defaultPolicy(now: Date): Policy {
  return {
    version: 1,
    entityId: DEFAULT_ENTITY_ID,
    caps: [
      { cityTier: "metro", city: "Mumbai", perNight: money(900_000, "INR") },
      { cityTier: "metro", city: "Bengaluru", perNight: money(850_000, "INR") },
      { cityTier: "metro", city: "Gurugram", perNight: money(800_000, "INR") },
      { cityTier: "tier1", city: "Hyderabad", perNight: money(700_000, "INR") },
      { cityTier: "tier1", city: "Pune", perNight: money(650_000, "INR") },
      { cityTier: "metro", city: null, perNight: money(900_000, "INR") },
      { cityTier: "tier1", city: null, perNight: money(700_000, "INR") },
      { cityTier: "tier2", city: null, perNight: money(500_000, "INR") },
    ],
    requireFlexible: false,
    blockedCountries: [],
    blockedSuppliers: [],
    costCentres: ["ENG-OPS", "SALES", "FINANCE"],
    defaultCostCentre: "ENG-OPS",
    // ₹2,000 of headroom for incidentals on the single-use card (§2.6).
    incidentalsBufferMinor: 200_000,
    updatedAt: now.toISOString(),
    updatedBy: "system@seed",
  };
}

export function buildDefaultDeps(opts?: { dir?: string; memory?: boolean }): AppDeps {
  const memory = opts?.memory ?? false;
  const dir = opts?.dir ?? process.env.SM_DATA_DIR ?? join(projectRoot, ".data");
  return {
    store: memory ? createMemoryStore() : createFileStore(dir),
    sources: createFixtureRateSources({ chaos: chaosFromEnv(process.env) }),
    routes: createLocalRouteSource(),
    issuer: createSandboxCardIssuer(),
    now: () => new Date(),
  };
}

export function createApp(deps: AppDeps): express.Express {
  // Instrumentation lives here so no route can reach an un-logged supplier: the
  // immutable source log is a property of composition, not of diligence (A18).
  const sources = deps.sources.map((src) =>
    instrumentRateSource(src, deps.store, () => newId("corr")),
  );
  const issuer = instrumentCardIssuer(deps.issuer, deps.store);

  const auth = createAuth(deps.store, deps.now);
  const searches = createSearchRegistry({
    sources,
    routes: deps.routes,
    store: deps.store,
  });

  const policyFor = async (entityId: string): Promise<Policy> => {
    const current = await deps.store.getCurrentPolicy(entityId);
    if (current !== null) return current;
    const seeded = { ...defaultPolicy(deps.now()), entityId };
    await deps.store.savePolicy(seeded);
    return seeded;
  };

  const ctx: ServerContext = {
    store: deps.store,
    sources,
    routes: deps.routes,
    issuer,
    now: deps.now,
    searches,
    auth,
    policyFor,
  };

  // Seeded once, before the first request is answered.
  const ready = policyFor(DEFAULT_ENTITY_ID).then(
    () => undefined,
    () => undefined,
  );

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.use(express.json({ limit: "256kb" }));

  const api = express.Router();
  api.use((_req, _res, next) => {
    ready.then(() => next(), next);
  });
  api.use(auth.middleware);
  api.use(authRoutes(ctx));
  api.use(searchRoutes(ctx));
  api.use(bookingRoutes(ctx));
  api.use(adminRoutes(ctx));
  api.use(opsRoutes(ctx));

  api.use((_req, res) => {
    fail(res, 404, "not_found", "No such endpoint.");
  });

  app.use("/api", api);

  // Single-origin production run: `npm run build && npm start` serves the SPA and
  // the API from one port, so there is no CORS surface and no second process.
  const webDir = join(projectRoot, "dist", "web");
  if (existsSync(webDir)) {
    app.use(express.static(webDir, { index: false }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(join(webDir, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof SyntaxError && message.includes("JSON")) {
      fail(res, 400, "invalid_request", "That request body is not valid JSON.");
      return;
    }
    fail(res, 500, "internal_error", "Something went wrong on our side.", { message });
  });

  return app;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  // PORT is what every managed host injects; SM_PORT stays for local use.
  const port =
    Number.parseInt(process.env.PORT ?? "", 10) ||
    Number.parseInt(process.env.SM_PORT ?? "", 10) ||
    8787;
  const app = createApp(buildDefaultDeps());

  // Behind a platform's TLS-terminating proxy, Express must trust X-Forwarded-*
  // or it sees plain HTTP and silently declines to set the `secure` session cookie.
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  // 0.0.0.0, not localhost: a container that binds the loopback interface passes
  // its own health check and is unreachable from outside.
  const server = app.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`strict-mode listening on 0.0.0.0:${port} (slice 1, fixture supply)`);
  });

  // Managed hosts send SIGTERM on deploy and scale-down. Draining in-flight
  // bookings matters more here than anywhere else in the app: a supplier write
  // cut in half is the one failure the idempotency key cannot clean up after.
  const shutdown = (signal: string) => () => {
    // eslint-disable-next-line no-console
    console.log(`${signal} received, draining connections`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("SIGINT", shutdown("SIGINT"));
}
