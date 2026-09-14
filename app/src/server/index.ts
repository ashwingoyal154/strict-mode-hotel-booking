/**
 * The HTTP app. Composition only: every decision lives in `src/core` (pure), in a
 * service module under `src/server`, or behind a port (`RateSource`, `RouteSource`,
 * `CardIssuer`, `Notifier`, `IntentParser`, `Store`). This file knows which kinds of
 * things exist and which implementation the environment asked for, and nothing
 * about how any of them work.
 *
 * `AppDeps` is the seam the tests use: an in-memory store, the fixture sources and
 * a movable `now`. No handler calls `new Date()` for a decision (spec §3.3).
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import express, { type NextFunction, type Request, type Response } from "express";

import { newId } from "../core/ids.ts";
import type { LegalEntity, Policy } from "../core/types.ts";
import { createClaudeIntentParser } from "../intent/ClaudeIntentParser.ts";
import { createRuleIntentParser } from "../intent/RuleIntentParser.ts";
import { createConsoleEmailNotifier } from "../notify/ConsoleEmailNotifier.ts";
import type { Notifier } from "../notify/Notifier.ts";
import { createSlackWebhookNotifier } from "../notify/SlackWebhookNotifier.ts";
import type { CardIssuer } from "../payments/CardIssuer.ts";
import { createSandboxCardIssuer } from "../payments/SandboxCardIssuer.ts";
import { createStripeIssuingCardIssuer } from "../payments/StripeIssuingCardIssuer.ts";
import { createLocalRouteSource } from "../routing/LocalRouteSource.ts";
import { createExpediaRapidRateSource } from "../supply/ExpediaRapidRateSource.ts";
import { createFixtureRateSources } from "../supply/FixtureRateSource.ts";
import type { RateSource } from "../supply/RateSource.ts";
import { FIXTURE_PROPERTIES, propertiesNear } from "../supply/fixtures/properties.ts";
import { chaosFromEnv } from "../supply/fixtures/adversarial.ts";
import { FIXTURE_ANCHORS, resolveAnchor } from "../supply/fixtures/anchors.ts";
import { createFileStore, createMemoryStore, createStore } from "../store/FileStore.ts";
import { createBlobPersistence } from "../store/persistence/blob.ts";
import type { Store } from "../store/Store.ts";
import { currentCorrelationId, instrumentCardIssuer, instrumentNotifier, instrumentRateSource } from "./audit.ts";
import { createAuth, DEFAULT_ENTITY_ID } from "./auth.ts";
import { tick } from "./cron.ts";
import type { AppDeps } from "./deps.ts";
import { adminRoutes } from "./routes/admin.ts";
import { approvalRoutes } from "./routes/approvals.ts";
import { authRoutes } from "./routes/auth.ts";
import { bookingRoutes } from "./routes/bookings.ts";
import { fail, type ServerContext } from "./routes/http.ts";
import { opsRoutes } from "./routes/ops.ts";
import { searchRoutes } from "./routes/search.ts";
import { createSearchRegistry } from "./search.ts";
import { defaultEntity, defaultPolicy, seedBase, seedDemo } from "./seed.ts";

export type { AppDeps } from "./deps.ts";
export { defaultPolicy, seedDemo } from "./seed.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");

/** How often, at most, a request may kick off a background tick on one instance. */
const OPPORTUNISTIC_TICK_MS = 30_000;

/** Which kind of store `buildDefaultDeps` built, for /api/version. Not a field on AppDeps, which is frozen. */
const storeKinds = new WeakMap<Store, string>();

/**
 * Picks every adapter from the environment. Anything that would silently run a
 * production deploy on the wrong implementation refuses to boot instead.
 */
export function buildDefaultDeps(opts?: { dir?: string; memory?: boolean }): AppDeps {
  const env = process.env;

  const kind = opts?.memory === true
    ? "memory"
    : env.SM_STORE ?? (env.BLOB_READ_WRITE_TOKEN !== undefined && env.VERCEL !== undefined ? "blob" : "file");
  let store: Store;
  if (kind === "memory") {
    store = createMemoryStore();
  } else if (kind === "file") {
    store = createFileStore(opts?.dir ?? env.SM_DATA_DIR ?? join(projectRoot, ".data"));
  } else if (kind === "blob") {
    const token = env.BLOB_READ_WRITE_TOKEN;
    if (token === undefined || token === "") throw new Error("SM_STORE=blob requires BLOB_READ_WRITE_TOKEN");
    store = createStore(createBlobPersistence({ token, prefix: env.SM_BLOB_PREFIX ?? "strict-mode" }));
  } else {
    throw new Error(`SM_STORE must be memory, file or blob — got "${kind}"`);
  }
  storeKinds.set(store, kind);

  // Supply. `rapid` refuses to boot without Expedia credentials rather than fall
  // back to fixtures: booking "real" hotels on invented inventory would be the worst
  // possible silent fallback.
  const supply = env.SM_SUPPLY ?? "fixture";
  let sources: RateSource[];
  if (supply === "fixture") {
    sources = createFixtureRateSources({ chaos: chaosFromEnv(env) });
  } else if (supply === "rapid") {
    const apiKey = env.EAN_API_KEY;
    const sharedSecret = env.EAN_SHARED_SECRET;
    if (apiKey === undefined || apiKey === "" || sharedSecret === undefined || sharedSecret === "") {
      throw new Error("SM_SUPPLY=rapid requires EAN_API_KEY and EAN_SHARED_SECRET");
    }
    sources = [
      createExpediaRapidRateSource({
        apiKey,
        sharedSecret,
        baseUrl: env.EAN_BASE_URL ?? "https://test.ean.com",
        customerIp: env.EAN_CUSTOMER_IP ?? "127.0.0.1",
        posCountryCode: env.EAN_POS_COUNTRY ?? "IN",
        language: "en-US",
        currency: env.EAN_CURRENCY ?? "INR",
        salesChannel: "website",
        salesEnvironment: "hotel_only",
        // Rapid Content ingestion is not built yet. The fixture catalogue stands in as
        // the content cache, so a live deployment must replace these two functions with
        // a Rapid Content API pipeline before any real property will appear.
        propertyIdsForAnchor: async (anchor) => propertiesNear(anchor.geo, 20_000).map((p) => p.id),
        propertyFor: (id) => FIXTURE_PROPERTIES.find((p) => p.id === id) ?? null,
      }),
    ];
  } else {
    throw new Error(`SM_SUPPLY must be fixture or rapid — got "${supply}"`);
  }

  // Card issuing. Same rule: `stripe` without credentials refuses to boot.
  const issuerKind = env.SM_ISSUER ?? "sandbox";
  let issuer: CardIssuer;
  if (issuerKind === "sandbox") {
    issuer = createSandboxCardIssuer();
  } else if (issuerKind === "stripe") {
    const secretKey = env.STRIPE_SECRET_KEY;
    const cardholderId = env.STRIPE_CARDHOLDER_ID;
    if (secretKey === undefined || secretKey === "" || cardholderId === undefined || cardholderId === "") {
      throw new Error("SM_ISSUER=stripe requires STRIPE_SECRET_KEY and STRIPE_CARDHOLDER_ID");
    }
    issuer = createStripeIssuingCardIssuer({ secretKey, cardholderId });
  } else {
    throw new Error(`SM_ISSUER must be sandbox or stripe — got "${issuerKind}"`);
  }

  // Chat entry: Claude when a key is configured, always with the rules parser behind it.
  const rules = createRuleIntentParser();
  const intentParser =
    env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== ""
      ? createClaudeIntentParser({ fallback: rules })
      : rules;

  const notifiers: Notifier[] = [createConsoleEmailNotifier()];
  const slack = env.SLACK_WEBHOOK_URL;
  if (slack !== undefined && slack !== "") notifiers.push(createSlackWebhookNotifier({ webhookUrl: slack }));

  const port = env.PORT ?? env.SM_PORT ?? "8787";

  return {
    store,
    sources,
    routes: createLocalRouteSource(),
    issuer,
    notifiers,
    intentParser,
    resolveAnchor,
    knownAnchors: FIXTURE_ANCHORS,
    now: () => new Date(),
    publicBaseUrl: (env.SM_PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    demo: env.SM_DEMO === "1",
  };
}

export function createApp(deps: AppDeps): express.Express {
  // Instrumentation lives here so no route can reach an un-logged supplier, card
  // issuer or notifier: the immutable source log is a property of composition,
  // not of diligence (A18).
  const correlation = (): string => currentCorrelationId() ?? newId("corr");
  const sources = deps.sources.map((src) => instrumentRateSource(src, deps.store, correlation));
  const issuer = instrumentCardIssuer(deps.issuer, deps.store);
  const notifiers = deps.notifiers.map((n) => instrumentNotifier(n, deps.store));

  const auth = createAuth(deps.store, deps.now);
  const searches = createSearchRegistry({ sources, routes: deps.routes, store: deps.store, now: deps.now });

  // Seeded once per instance before the first request is answered. Seeding is
  // idempotent, so every cold serverless instance may safely do it.
  const ready: Promise<void> = (deps.demo ? seedDemo(deps) : seedBase(deps)).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("seed failed", err);
  });

  const policyFor = async (entityId: string): Promise<Policy> => {
    const current = await deps.store.getCurrentPolicy(entityId);
    if (current !== null) return current;
    await seedBase(deps);
    const seeded = await deps.store.getCurrentPolicy(entityId);
    if (seeded !== null) return seeded;
    const fallback: Policy = { ...defaultPolicy(deps.now()), entityId };
    await deps.store.savePolicy(fallback);
    return fallback;
  };

  const entityFor = async (entityId: string): Promise<LegalEntity> => {
    const current = await deps.store.getEntity(entityId);
    if (current !== null) return current;
    await seedBase(deps);
    return (await deps.store.getEntity(entityId)) ?? { ...defaultEntity(), id: entityId };
  };

  const ctx: ServerContext = {
    ...deps,
    sources,
    issuer,
    notifiers,
    searches,
    auth,
    policyFor,
    entityFor,
    storeKind: storeKinds.get(deps.store) ?? "custom",
  };

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.use(express.json({ limit: "256kb" }));

  const api = express.Router();
  api.use((_req, _res, next) => {
    ready.then(() => next(), next);
  });
  api.use(auth.middleware);

  // SLA escalations are also materialised on every approval read, so correctness
  // never depends on this. It exists so escalation notifications go out promptly
  // on a host whose cron fires only daily. Never blocks, never fails, a request.
  let lastTick = 0;
  const opportunistic = process.env.VITEST === undefined && process.env.SM_OPPORTUNISTIC_TICK !== "off";
  api.use((_req, _res, next) => {
    if (opportunistic && Date.now() - lastTick >= OPPORTUNISTIC_TICK_MS) {
      lastTick = Date.now();
      void tick(ctx, deps.now()).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("opportunistic tick failed", err);
      });
    }
    next();
  });

  api.use(authRoutes(ctx));
  api.use(searchRoutes(ctx));
  api.use(bookingRoutes(ctx));
  api.use(approvalRoutes(ctx));
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

  // Behind a TLS-terminating proxy Express must trust X-Forwarded-*, or it sees
  // plain HTTP and silently declines to set the `secure` session cookie.
  if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

  // 0.0.0.0, not localhost: a container bound to loopback passes its own health
  // check and is unreachable from outside.
  const server = app.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`strict-mode listening on 0.0.0.0:${port} (slice 2, entity ${DEFAULT_ENTITY_ID})`);
  });

  // Managed hosts send SIGTERM on deploy. Draining in-flight bookings matters here
  // more than anywhere: a supplier write cut in half is the one failure the
  // idempotency key cannot clean up after.
  const shutdown = (signal: string) => () => {
    // eslint-disable-next-line no-console
    console.log(`${signal} received, draining connections`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("SIGINT", shutdown("SIGINT"));
}
