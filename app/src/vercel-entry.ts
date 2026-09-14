/**
 * Vercel serverless entry. The Express app is the function handler.
 *
 * `buildDefaultDeps` picks the Blob store automatically on Vercel, so bookings,
 * approvals and invoices survive across instances. Search needs no shared state at
 * all: a searchId is signed and self-describing, and any instance can recompute it
 * (src/server/search.ts). With SM_DEMO=1, `createApp` seeds the demo cast once per
 * cold instance, idempotently.
 */
import { buildDefaultDeps, createApp } from "./server/index.ts";

const app = createApp(buildDefaultDeps());
app.set("trust proxy", 1);

export default app;
