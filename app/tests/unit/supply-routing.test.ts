import { createLocalRouteSource } from "../../src/routing/LocalRouteSource.ts";
import { estimateCommute } from "../../src/core/commute.ts";
import type { GeoPoint } from "../../src/core/types.ts";

const BKC: GeoPoint = { lat: 19.0669, lng: 72.8676 };
const NEAR: GeoPoint = { lat: 19.07, lng: 72.87 };
const FAR: GeoPoint = { lat: 19.2, lng: 73.0 };

describe("createLocalRouteSource", () => {
  it("delegates commute() to core estimateCommute", async () => {
    const route = createLocalRouteSource();
    const result = await route.commute(BKC, NEAR);
    expect(result).toEqual(estimateCommute(BKC, NEAR));
  });

  it("commuteBatch returns one commute per point, in order, in a single pass", async () => {
    const route = createLocalRouteSource();
    const points = [NEAR, FAR, BKC];
    const results = await route.commuteBatch(BKC, points);
    expect(results).toHaveLength(3);
    expect(results).toEqual(points.map((p) => estimateCommute(BKC, p)));
  });

  it("has a stable id", () => {
    const route = createLocalRouteSource();
    expect(typeof route.id).toBe("string");
    expect(route.id.length).toBeGreaterThan(0);
  });
});
