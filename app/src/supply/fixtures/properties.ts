/**
 * Fixture property catalogue. Every name here is invented — no real hotel or
 * chain name appears anywhere, because these are fixture rates and must never
 * be mistakable for a real quote (see tests/unit/supply-fixtures.test.ts).
 *
 * Properties cluster around FIXTURE_ANCHORS at genuinely varied true distances
 * (great-circle destination points, not eyeballed lat/lng) so commute ranking
 * has real signal to sort on.
 */
import type { GeoPoint, Property } from "../../core/types.ts";
import { haversineMeters } from "../../core/commute.ts";
import { FIXTURE_ANCHORS } from "./anchors.ts";

const EARTH_RADIUS_M = 6_371_000;

/** Exact great-circle destination point `distanceMeters` out on `bearingDeg`. */
function offsetGeo(base: GeoPoint, distanceMeters: number, bearingDeg: number): GeoPoint {
  const d = distanceMeters / EARTH_RADIUS_M;
  const brng = (bearingDeg * Math.PI) / 180;
  const lat1 = (base.lat * Math.PI) / 180;
  const lng1 = (base.lng * Math.PI) / 180;

  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: (lat2 * 180) / Math.PI, lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180 };
}

const FIRST_WORDS: readonly string[] = [
  "Silverleaf", "Amaranth", "Copperleaf", "Bluewood", "Meridian", "Palmcrest",
  "Cedarpoint", "Ivorycourt", "Lotusgrove", "Emeraldbay", "Goldenpalm", "Crimsonoak",
  "Azurecourt", "Marigold", "Sapphireridge", "Alderwood", "Birchgate", "Cascadia",
  "Driftwood", "Falconridge", "Granitehill", "Harborlane", "Indigovale", "Jadecourt",
  "Kestrelpark", "Lumencrest", "Moonstone", "Nightgale", "Opalgate", "Pinecrest",
  "Quartzview", "Rosewood", "Sundialpark", "Terrabriar", "Umbercourt", "Verdantvale",
  "Willowbrook", "Zephyrgate", "Brasswood", "Coralcrest",
];

const SECOND_WORDS: readonly string[] = [
  "Business Suites", "Residency", "Grand", "Executive Suites",
  "Corporate Court", "Serviced Suites", "Business Hotel", "Stay Inn",
];

const BRANDS: readonly string[] = [
  "Meridian Collection", "Silverleaf Group", "Harbor & Vale Hotels", "Cascadia Stays",
];

/**
 * Stride 3 is coprime to SECOND_WORDS.length (8), so the second word advances on
 * every property and cycles through all eight. Dividing by FIRST_WORDS.length
 * instead — the obvious thing — holds the second word constant for the first 26
 * properties, and a results page where every hotel is a "Business Suites" reads
 * as obviously generated.
 */
function fixtureName(index: number): string {
  const first = FIRST_WORDS[index % FIRST_WORDS.length]!;
  const second = SECOND_WORDS[(index * 3) % SECOND_WORDS.length]!;
  return `${first} ${second}`;
}

function fixturePhone(index: number): string {
  const n = (800_000_000 + index * 9137) % 1_000_000_000;
  return `+91-9${String(n).padStart(9, "0")}`;
}

interface AnchorSpec {
  readonly slug: string;
  readonly anchorIndex: number;
  readonly cityTier: "metro" | "tier1";
  /** [distanceMeters, bearingDeg] per generated property, 200m–14km spread. */
  readonly plots: readonly (readonly [number, number])[];
}

const ANCHOR_SPECS: readonly AnchorSpec[] = [
  {
    slug: "bkc",
    anchorIndex: 0,
    cityTier: "metro",
    plots: [
      [240, 20], [650, 95], [1350, 170], [2600, 230], [4100, 300], [6800, 40], [11500, 150],
    ],
  },
  {
    slug: "whitefield",
    anchorIndex: 1,
    cityTier: "metro",
    plots: [
      [300, 55], [820, 130], [1600, 205], [3100, 275], [4600, 15], [7200, 240], [12200, 90],
    ],
  },
  {
    slug: "koramangala",
    anchorIndex: 2,
    cityTier: "metro",
    plots: [
      [200, 10], [700, 260], [1450, 320], [2900, 60], [4400, 190], [7500, 100], [13400, 210],
    ],
  },
  {
    slug: "cybercity",
    anchorIndex: 3,
    cityTier: "tier1",
    plots: [
      [280, 300], [900, 45], [1800, 120], [3300, 200], [5000, 340], [8100, 70], [13900, 260],
    ],
  },
  {
    slug: "hitec",
    anchorIndex: 4,
    cityTier: "tier1",
    plots: [
      [260, 160], [750, 230], [1550, 10], [3000, 90], [4700, 320], [7800, 190], [12800, 40],
    ],
  },
  {
    slug: "hinjewadi",
    anchorIndex: 5,
    cityTier: "tier1",
    plots: [
      [220, 280], [680, 30], [1400, 110], [2700, 200], [4200, 340], [6900, 130], [11900, 60],
    ],
  },
];

function buildGeneratedProperties(): Property[] {
  const out: Property[] = [];
  let globalIndex = 0;
  for (const spec of ANCHOR_SPECS) {
    const anchor = FIXTURE_ANCHORS[spec.anchorIndex]!;
    spec.plots.forEach(([distanceMeters, bearingDeg], plotIndex) => {
      const idx = globalIndex; // stable across anchors for name/phone variety
      const geo = offsetGeo(anchor.geo, distanceMeters, bearingDeg);
      const workReady = idx % 5 < 3; // ~60/40 split
      const brand = idx % 2 === 0 ? BRANDS[idx % BRANDS.length]! : null;
      out.push({
        id: `prop-${spec.slug}-${String(plotIndex + 1).padStart(2, "0")}`,
        name: fixtureName(idx),
        addressLine: `${20 + idx} Business Park Road, near ${anchor.label.split(",")[0]}`,
        city: anchor.city,
        cityTier: spec.cityTier,
        countryCode: anchor.countryCode,
        geo,
        phone: fixturePhone(idx),
        brand,
        workReady,
        thumbnailUrl: null,
      });
      globalIndex += 1;
    });
  }
  return out;
}

/**
 * Two always-present canary properties near BKC. Their offer ids are the
 * addressable, deterministic drift/sold-out targets — see fixtures/rates.ts
 * and fixtures/adversarial.ts (DRIFT_MARKER_SUFFIX / SOLD_OUT_MARKER_SUFFIX).
 * They are ordinary-looking invented properties; nothing in this file marks
 * them specially — only ratesFor knows their ids matter.
 *
 * Deliberately placed farther out than most generated BKC properties (which
 * run 240m–11.5km) so they normally rank behind several legitimate offers
 * rather than becoming `results[0]` — happy-path tests elsewhere book "the
 * top result" and must not silently land on a canary.
 */
const CANARY_PROPERTIES: readonly Property[] = [
  {
    id: "prop-bkc-canary-drift",
    name: "Cobaltgate Business Suites",
    addressLine: "3 Financial District Link Road, near Bandra Kurla Complex",
    city: "Mumbai",
    cityTier: "metro",
    countryCode: "IN",
    geo: offsetGeo(FIXTURE_ANCHORS[0]!.geo, 9200, 45),
    phone: fixturePhone(9001),
    brand: null,
    workReady: true,
    thumbnailUrl: null,
  },
  {
    id: "prop-bkc-canary-soldout",
    name: "Russetfield Corporate Residency",
    addressLine: "18 Financial District Link Road, near Bandra Kurla Complex",
    city: "Mumbai",
    cityTier: "metro",
    countryCode: "IN",
    geo: offsetGeo(FIXTURE_ANCHORS[0]!.geo, 10400, 200),
    phone: fixturePhone(9002),
    brand: null,
    workReady: false,
    thumbnailUrl: null,
  },
];

export const FIXTURE_PROPERTIES: readonly Property[] = [
  ...buildGeneratedProperties(),
  ...CANARY_PROPERTIES,
];

/** All fixture properties within `radiusMeters` of `geo`, true great-circle distance. */
export function propertiesNear(geo: GeoPoint, radiusMeters: number): Property[] {
  return FIXTURE_PROPERTIES.filter((p) => haversineMeters(p.geo, geo) <= radiusMeters);
}
