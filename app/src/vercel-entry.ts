/**
 * Vercel serverless entry. The Express app is exported as the function handler.
 *
 * Serverless constraints this deployment lives under:
 *  - the filesystem is read-only, so the Store must be in-memory
 *  - each invocation may be a different instance, so nothing may rely on
 *    process memory surviving between requests
 *
 * The second constraint is the interesting one, and it is why search had to
 * become stateless (see src/server/search.ts). Fixture supply is deterministic,
 * so a searchId carries its own query and any instance can recompute the
 * identical result set rather than look one up.
 */
import { createApp, buildDefaultDeps } from "../src/server/index.ts";

const app = createApp(buildDefaultDeps({ memory: true }));
app.set("trust proxy", 1);

export default app;
