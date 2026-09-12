import type { Commute, GeoPoint } from "../core/types.ts";

/**
 * Commute time to the anchor address is the product's only ranking signal, so
 * this is never mocked away — it is the feature. Slice 1 ships a deterministic
 * local implementation; a maps-provider adapter drops in behind the same
 * interface without touching ranking code.
 */
export interface RouteSource {
  readonly id: string;
  commute(from: GeoPoint, to: GeoPoint): Promise<Commute>;
  /** Batched because a results page needs 20 of these at once. */
  commuteBatch(from: GeoPoint, to: readonly GeoPoint[]): Promise<Commute[]>;
}
