/**
 * The composition seam. Everything the server talks to arrives here, so tests
 * substitute an in-memory store, controlled supply and a movable clock without
 * reaching into any module. Re-exported from `index.ts`, where the frozen module
 * contract names it.
 */

import type { Anchor } from "../core/types.ts";
import type { IntentParser } from "../intent/IntentParser.ts";
import type { Notifier } from "../notify/Notifier.ts";
import type { CardIssuer } from "../payments/CardIssuer.ts";
import type { RouteSource } from "../routing/RouteSource.ts";
import type { RateSource } from "../supply/RateSource.ts";
import type { Store } from "../store/Store.ts";

export interface AppDeps {
  store: Store;
  sources: RateSource[];
  routes: RouteSource;
  issuer: CardIssuer;
  notifiers: Notifier[];
  intentParser: IntentParser;
  resolveAnchor: (query: string) => Anchor | null;
  knownAnchors: readonly Anchor[];
  now: () => Date;
  publicBaseUrl: string;
  demo: boolean;
}
