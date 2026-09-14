/**
 * Fixture business-district anchors. Real coordinates so commute math (core
 * commute.ts) has something true to say — this is the seam SPEC.md §3.1 exists
 * to protect: nothing above RateSource/RouteSource may know these are fixtures.
 *
 * Slice 2 adds three international districts so the multi-currency, pinned-FX
 * and advisory paths have real places to exercise them.
 */
import type { Anchor } from "../../core/types.ts";

export const FIXTURE_ANCHORS: readonly Anchor[] = [
  {
    label: "Bandra Kurla Complex, Mumbai",
    geo: { lat: 19.0669, lng: 72.8676 },
    city: "Mumbai",
    countryCode: "IN",
  },
  {
    label: "Whitefield, Bengaluru",
    geo: { lat: 12.9698, lng: 77.75 },
    city: "Bengaluru",
    countryCode: "IN",
  },
  {
    label: "Koramangala, Bengaluru",
    geo: { lat: 12.9352, lng: 77.6245 },
    city: "Bengaluru",
    countryCode: "IN",
  },
  {
    label: "Cyber City, Gurugram",
    geo: { lat: 28.495, lng: 77.089 },
    city: "Gurugram",
    countryCode: "IN",
  },
  {
    label: "HITEC City, Hyderabad",
    geo: { lat: 17.4435, lng: 78.3772 },
    city: "Hyderabad",
    countryCode: "IN",
  },
  {
    label: "Hinjewadi, Pune",
    geo: { lat: 18.5908, lng: 73.7392 },
    city: "Pune",
    countryCode: "IN",
  },
  {
    label: "Marina Bay Financial Centre, Singapore",
    geo: { lat: 1.2789, lng: 103.8536 },
    city: "Singapore",
    countryCode: "SG",
  },
  {
    label: "DIFC, Dubai",
    geo: { lat: 25.2131, lng: 55.2796 },
    city: "Dubai",
    countryCode: "AE",
  },
  {
    label: "Canary Wharf, London",
    geo: { lat: 51.5054, lng: -0.0235 },
    city: "London",
    countryCode: "GB",
  },
] as const;

/** Extra ways a traveller might type each anchor, beyond its own label/city. */
const ALIASES: readonly (readonly string[])[] = [
  ["bkc", "bandra kurla", "bandra kurla complex", "bkc mumbai"],
  ["whitefield", "whitefield bangalore", "whitefield bengaluru"],
  ["koramangala", "koramangala bangalore", "koramangala bengaluru"],
  ["cyber city", "cybercity", "cyber hub", "gurgaon", "cyber city gurgaon"],
  ["hitec city", "hitech city", "hitec", "hi tec city", "cyberabad"],
  ["hinjewadi", "hinjewadi phase 1", "hinjewadi pune"],
  ["mbfc", "marina bay", "marina bay financial centre", "marina bay financial center", "raffles place"],
  ["difc", "dubai international financial centre", "dubai international financial center", "gate village"],
  ["canary wharf", "canary wharf london", "e14", "docklands"],
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

interface ResolvableEntry {
  readonly anchor: Anchor;
  readonly needles: readonly string[];
}

const RESOLVABLE: readonly ResolvableEntry[] = FIXTURE_ANCHORS.map((anchor, i) => ({
  anchor,
  needles: [normalize(anchor.label), normalize(anchor.city), ...(ALIASES[i] ?? []).map(normalize)],
}));

/**
 * Resolves free-text (case/punctuation-insensitive, alias-aware) to a fixture
 * anchor. Returns null rather than guessing when nothing matches.
 */
export function resolveAnchor(query: string): Anchor | null {
  const q = normalize(query);
  if (q.length === 0) return null;

  // Exact needle match first.
  for (const entry of RESOLVABLE) {
    if (entry.needles.includes(q)) return entry.anchor;
  }

  // Then containment either direction, preferring the longest needle overlap
  // so "koramangala" doesn't lose to a coincidental short prefix elsewhere.
  let best: { anchor: Anchor; score: number } | null = null;
  for (const entry of RESOLVABLE) {
    for (const needle of entry.needles) {
      if (needle.length < 3) continue; // avoid noisy short-token false positives
      if (q.includes(needle) || needle.includes(q)) {
        const score = Math.min(needle.length, q.length);
        if (best === null || score > best.score) best = { anchor: entry.anchor, score };
      }
    }
  }
  return best?.anchor ?? null;
}
