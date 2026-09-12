/**
 * Deterministic local commute source. Commute time is the product's only
 * ranking signal (RouteSource.ts), so this delegates entirely to the pure,
 * versioned `estimateCommute` — no independent distance/banding logic here to
 * drift out of sync with it.
 */
import type { Commute, GeoPoint } from "../core/types.ts";
import { estimateCommute } from "../core/commute.ts";
import type { RouteSource } from "./RouteSource.ts";

export function createLocalRouteSource(): RouteSource {
  return {
    id: "local-route",

    async commute(from: GeoPoint, to: GeoPoint): Promise<Commute> {
      return estimateCommute(from, to);
    },

    /** One pass over `points` — no N+1, since estimateCommute is pure/local. */
    async commuteBatch(from: GeoPoint, points: readonly GeoPoint[]): Promise<Commute[]> {
      return points.map((to) => estimateCommute(from, to));
    },
  };
}
