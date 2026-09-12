/**
 * Commute estimation — the product's only ranking signal (§2.4), so it is pure,
 * fixed-constant maths rather than a live routing call. A2 allows ±3 minutes
 * against a maps reference; a deterministic band beats an unavailable API.
 *
 * Dates are parsed with an explicit regex and UTC arithmetic. `new Date(string)`
 * on a date-only value is implementation-sensitive, and nights count is money.
 */

import type { Commute, GeoPoint, IsoDate } from "./types.ts";

const WALK_METRES_PER_MIN = 80;
const WALK_BAND_MAX_MIN = 12;
const TRANSIT_BAND_MAX_METRES = 15_000;
const TRANSIT_METRES_PER_MIN = 18_000 / 60; // 18 km/h
const TRANSIT_WAIT_MIN = 6;
const DRIVE_METRES_PER_MIN = 28_000 / 60; // 28 km/h
const EARTH_RADIUS_METRES = 6_371_000;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtcMidnight(date: IsoDate): number {
  const match = ISO_DATE.exec(date);
  if (match === null) {
    throw new RangeError(`Expected an ISO date (YYYY-MM-DD), received "${date}"`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = Date.UTC(year, month - 1, day);
  // Rejects "2026-02-30" and friends: round-tripping catches the overflow.
  const round = new Date(stamp);
  if (
    round.getUTCFullYear() !== year ||
    round.getUTCMonth() !== month - 1 ||
    round.getUTCDate() !== day
  ) {
    throw new RangeError(`"${date}" is not a real calendar date`);
  }
  return stamp;
}

const MS_PER_DAY = 86_400_000;

/** Nights in a stay: 0 for a same-day range, and never negative (that throws). */
export function nightsBetween(checkIn: IsoDate, checkOut: IsoDate): number {
  const from = toUtcMidnight(checkIn);
  const to = toUtcMidnight(checkOut);
  if (to < from) {
    throw new RangeError(`checkOut ${checkOut} is before checkIn ${checkIn}`);
  }
  // Both stamps are UTC midnight, so the division is exact — no DST to absorb.
  return (to - from) / MS_PER_DAY;
}

/** Great-circle distance between two points, in whole metres. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = Math.PI / 180;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));

  return Math.round(EARTH_RADIUS_METRES * c);
}

/** Minutes, rounded and floored at 1 — a commute of "0 min" would read as a bug. */
function minutesFrom(metres: number, metresPerMin: number, waitMin: number): number {
  return Math.max(1, Math.round(metres / metresPerMin) + waitMin);
}

/**
 * Bands a straight-line distance into a mode and a minute count, by the fixed
 * rules in MODULE_EXPORTS: walk ≤ 12 min, else transit within 15 km, else drive.
 */
export function estimateCommute(from: GeoPoint, to: GeoPoint): Commute {
  const distanceMeters = haversineMeters(from, to);

  // Banding is decided on the rounded walk figure, the same number the UI shows,
  // so a result can never display "12 min walk" while having been banded as transit.
  const walkMinutes = minutesFrom(distanceMeters, WALK_METRES_PER_MIN, 0);
  if (walkMinutes <= WALK_BAND_MAX_MIN) {
    return { minutes: walkMinutes, mode: "walk", distanceMeters };
  }

  if (distanceMeters <= TRANSIT_BAND_MAX_METRES) {
    return {
      minutes: minutesFrom(distanceMeters, TRANSIT_METRES_PER_MIN, TRANSIT_WAIT_MIN),
      mode: "transit",
      distanceMeters,
    };
  }

  return {
    minutes: minutesFrom(distanceMeters, DRIVE_METRES_PER_MIN, 0),
    mode: "drive",
    distanceMeters,
  };
}

/**
 * The banding is deliberately non-monotonic at its two boundaries: 1.04 km is
 * "9 min transit" while 0.96 km is "12 min walk", because transit carries a
 * fixed 6-minute wait and no walk does. That is the specified model, not a bug —
 * the bands are frozen so that a stored commute can be recomputed years later.
 */

/** The commute badge copy, e.g. "7 min walk". */
export function describeCommute(c: Commute): string {
  return `${c.minutes} min ${c.mode}`;
}
