/**
 * Fixture property catalogue. Every name here is invented — no real hotel or
 * chain name appears anywhere, because these are fixture rates and must never
 * be mistakable for a real quote (see tests/unit/supply-fixtures.test.ts).
 *
 * Properties cluster around FIXTURE_ANCHORS at genuinely varied true distances
 * (great-circle destination points, not eyeballed lat/lng) so commute ranking
 * has real signal to sort on.
 *
 * Slice 2: every property carries its IANA time zone. Indian properties carry
 * the GST state code of where they physically are (the place of supply for
 * accommodation) and a checksum-valid hotel GSTIN built with core
 * `gstinCheckDigit`, so a GST invoice can name a real-shaped supplier.
 * International properties carry null for both and `cityTier: "global"`.
 */
import type { GeoPoint, Property } from "../../core/types.ts";
import { haversineMeters } from "../../core/commute.ts";
import { gstinCheckDigit } from "../../core/gst.ts";
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

/** 64 invented first words, so no two of the ~60 generated names collide. */
const FIRST_WORDS: readonly string[] = [
  "Silverleaf", "Amaranth", "Copperleaf", "Bluewood", "Meridian", "Palmcrest",
  "Cedarpoint", "Ivorycourt", "Lotusgrove", "Emeraldbay", "Goldenpalm", "Crimsonoak",
  "Azurecourt", "Marigold", "Sapphireridge", "Alderwood", "Birchgate", "Cascadia",
  "Driftwood", "Falconridge", "Granitehill", "Harborlane", "Indigovale", "Jadecourt",
  "Kestrelpark", "Lumencrest", "Moonstone", "Nightgale", "Opalgate", "Pinecrest",
  "Quartzview", "Rosewood", "Sundialpark", "Terrabriar", "Umbercourt", "Verdantvale",
  "Willowbrook", "Zephyrgate", "Brasswood", "Coralcrest", "Ambergate", "Bayleaf",
  "Cloudmere", "Elmstead", "Fernhollow", "Glenbrook", "Hazelmere", "Irongate",
  "Juniperhill", "Larkspur", "Mistvale", "Northwind", "Oakhaven", "Primrose",
  "Quillmere", "Ravenhurst", "Stonebridge", "Thornbury", "Wrenfield", "Yarrowdale",
  "Zenithpark", "Saffronway", "Tidewater", "Velvetmoor",
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
 * instead — the obvious thing — holds the second word constant for the first
 * run of properties, and a results page where every hotel is a "Business
 * Suites" reads as obviously generated.
 */
function fixtureName(index: number): string {
  const first = FIRST_WORDS[index % FIRST_WORDS.length]!;
  const second = SECOND_WORDS[(index * 3) % SECOND_WORDS.length]!;
  return `${first} ${second}`;
}

type PhoneStyle = "IN" | "SG" | "AE" | "GB";

/**
 * Invented local-format phone numbers. Every group is short and dash-separated,
 * so no number here is ever a 13+ digit run (the A13 scan must stay clean).
 */
function fixturePhone(index: number, style: PhoneStyle): string {
  const four = String((index * 7919 + 1234) % 10_000).padStart(4, "0");
  const three = String((index * 131 + 200) % 1_000).padStart(3, "0");
  switch (style) {
    case "SG":
      return `+65-6${three}-${four}`;
    case "AE":
      return `+971-4-${three}-${four}`;
    case "GB":
      return `+44-20-7${three}-${four}`;
    case "IN": {
      const n = (800_000_000 + index * 9137) % 1_000_000_000;
      return `+91-9${String(n).padStart(9, "0")}`;
    }
  }
}

const GSTIN_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * A checksum-valid, invented hotel GSTIN: state code + a PAN-shaped block
 * (4th character "C" for a company) + entity number "1" + "Z" + check digit.
 */
function fixtureGstin(stateCode: string, index: number, name: string): string {
  const L = (k: number): string => GSTIN_LETTERS[((k % GSTIN_LETTERS.length) + GSTIN_LETTERS.length) % GSTIN_LETTERS.length]!;
  const initial = (name[0] ?? "X").toUpperCase();
  const digits = String(1000 + ((index * 37) % 9000)).padStart(4, "0");
  const pan = `${L(index)}${L(index * 7 + 3)}${L(index * 11 + 5)}C${initial}${digits}${L(index * 5 + 1)}`;
  const first14 = `${stateCode}${pan}1Z`;
  return `${first14}${gstinCheckDigit(first14)}`;
}

interface AnchorSpec {
  readonly slug: string;
  readonly anchorIndex: number;
  readonly cityTier: "metro" | "tier1" | "global";
  /** GST state code for Indian anchors; null abroad. */
  readonly stateCode: string | null;
  readonly timeZone: string;
  readonly phoneStyle: PhoneStyle;
  /** [distanceMeters, bearingDeg] per generated property, 200m–14km spread. */
  readonly plots: readonly (readonly [number, number])[];
}

const ANCHOR_SPECS: readonly AnchorSpec[] = [
  {
    slug: "bkc", anchorIndex: 0, cityTier: "metro", stateCode: "27", timeZone: "Asia/Kolkata", phoneStyle: "IN",
    plots: [[240, 20], [650, 95], [1350, 170], [2600, 230], [4100, 300], [6800, 40], [11500, 150]],
  },
  {
    slug: "whitefield", anchorIndex: 1, cityTier: "metro", stateCode: "29", timeZone: "Asia/Kolkata", phoneStyle: "IN",
    plots: [[300, 55], [820, 130], [1600, 205], [3100, 275], [4600, 15], [7200, 240], [12200, 90]],
  },
  {
    slug: "koramangala", anchorIndex: 2, cityTier: "metro", stateCode: "29", timeZone: "Asia/Kolkata", phoneStyle: "IN",
    plots: [[200, 10], [700, 260], [1450, 320], [2900, 60], [4400, 190], [7500, 100], [13400, 210]],
  },
  {
    slug: "cybercity", anchorIndex: 3, cityTier: "tier1", stateCode: "06", timeZone: "Asia/Kolkata", phoneStyle: "IN",
    plots: [[280, 300], [900, 45], [1800, 120], [3300, 200], [5000, 340], [8100, 70], [13900, 260]],
  },
  {
    slug: "hitec", anchorIndex: 4, cityTier: "tier1", stateCode: "36", timeZone: "Asia/Kolkata", phoneStyle: "IN",
    plots: [[260, 160], [750, 230], [1550, 10], [3000, 90], [4700, 320], [7800, 190], [12800, 40]],
  },
  {
    slug: "hinjewadi", anchorIndex: 5, cityTier: "tier1", stateCode: "27", timeZone: "Asia/Kolkata", phoneStyle: "IN",
    plots: [[220, 280], [680, 30], [1400, 110], [2700, 200], [4200, 340], [6900, 130], [11900, 60]],
  },
  {
    slug: "mbfc", anchorIndex: 6, cityTier: "global", stateCode: null, timeZone: "Asia/Singapore", phoneStyle: "SG",
    plots: [[230, 300], [610, 60], [1250, 150], [2400, 250], [4300, 20], [7600, 320]],
  },
  {
    slug: "difc", anchorIndex: 7, cityTier: "global", stateCode: null, timeZone: "Asia/Dubai", phoneStyle: "AE",
    plots: [[260, 120], [720, 210], [1500, 30], [3200, 300], [5600, 60], [9400, 230]],
  },
  {
    slug: "canarywharf", anchorIndex: 8, cityTier: "global", stateCode: null, timeZone: "Europe/London", phoneStyle: "GB",
    plots: [[210, 80], [580, 190], [1300, 280], [2800, 10], [4900, 250], [8300, 300]],
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
      const name = fixtureName(idx);
      out.push({
        id: `prop-${spec.slug}-${String(plotIndex + 1).padStart(2, "0")}`,
        name,
        addressLine: `${20 + idx} Business Park Road, near ${anchor.label.split(",")[0]}`,
        city: anchor.city,
        cityTier: spec.cityTier,
        countryCode: anchor.countryCode,
        geo,
        phone: fixturePhone(idx, spec.phoneStyle),
        brand,
        workReady,
        thumbnailUrl: null,
        stateCode: spec.stateCode,
        supplierGstin: spec.stateCode === null ? null : fixtureGstin(spec.stateCode, idx, name),
        timeZone: spec.timeZone,
      });
      globalIndex += 1;
    });
  }
  return out;
}

/** The addressable canaries. Only fixtures/rates.ts gives their ids meaning. */
export const CANARY_PROPERTY_IDS = {
  drift: "prop-bkc-canary-drift",
  soldOut: "prop-bkc-canary-soldout",
  lateDrift: "prop-bkc-canary-latedrift",
} as const;

function bkcCanary(id: string, name: string, index: number, meters: number, bearing: number, workReady: boolean): Property {
  return {
    id,
    name,
    addressLine: `${index} Financial District Link Road, near Bandra Kurla Complex`,
    city: "Mumbai",
    cityTier: "metro",
    countryCode: "IN",
    geo: offsetGeo(FIXTURE_ANCHORS[0]!.geo, meters, bearing),
    phone: fixturePhone(9000 + index, "IN"),
    brand: null,
    workReady,
    thumbnailUrl: null,
    stateCode: "27",
    supplierGstin: fixtureGstin("27", 9000 + index, name),
    timeZone: "Asia/Kolkata",
  };
}

/**
 * Three always-present canary properties near BKC. Their offer ids are the
 * addressable, deterministic drift / sold-out / late-drift targets — see
 * fixtures/rates.ts and fixtures/adversarial.ts. They are ordinary-looking
 * invented properties; nothing about them is visibly special.
 *
 * Deliberately placed farther out than most generated BKC properties (which
 * run 240m–11.5km) so they normally rank behind several legitimate offers
 * rather than becoming `results[0]` — happy-path tests elsewhere book "the
 * top result" and must not silently land on a canary.
 */
const CANARY_PROPERTIES: readonly Property[] = [
  bkcCanary(CANARY_PROPERTY_IDS.drift, "Cobaltgate Business Suites", 3, 9200, 45, true),
  bkcCanary(CANARY_PROPERTY_IDS.soldOut, "Russetfield Corporate Residency", 18, 10400, 200, false),
  bkcCanary(CANARY_PROPERTY_IDS.lateDrift, "Slatebrook Executive Suites", 27, 9800, 110, true),
];

export const FIXTURE_PROPERTIES: readonly Property[] = [
  ...buildGeneratedProperties(),
  ...CANARY_PROPERTIES,
];

/** All fixture properties within `radiusMeters` of `geo`, true great-circle distance. */
export function propertiesNear(geo: GeoPoint, radiusMeters: number): Property[] {
  return FIXTURE_PROPERTIES.filter((p) => haversineMeters(p.geo, geo) <= radiusMeters);
}
