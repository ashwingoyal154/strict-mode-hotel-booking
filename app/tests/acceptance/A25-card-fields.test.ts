/**
 * A25 — "A build-failing test asserts no results card renders any element
 * outside the approved field list."
 *
 * The whole product claim is a quiet, honest results list. This test is the thing
 * standing between that claim and the first "just add a review score" ticket.
 * It reads the component source rather than a rendered DOM so it cannot be
 * satisfied by conditionally hiding something.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEB = new URL("../../src/web/", import.meta.url).pathname;

const APPROVED_FIELDS = [
  "commute",
  "rank",
  "name",
  "address",
  "total",
  "per-night",
  "verdict",
  "work-ready",
  "free-cancel",
  "thumb",
].sort();

/**
 * Strips comments and string-literal-free prose so the scan reads executable code
 * only. Without this, the comment in OfferCard that documents "no star rating, no
 * review score" is itself flagged — a test that can only be satisfied by deleting
 * its own specification is a broken test.
 */
function executableCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

function findOfferCard(): string {
  const candidates = [
    join(WEB, "components/OfferCard.tsx"),
    join(WEB, "components/offer-card.tsx"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  const comps = join(WEB, "components");
  if (existsSync(comps)) {
    const hit = readdirSync(comps).find((f) => /offercard/i.test(f));
    if (hit) return join(comps, hit);
  }
  throw new Error("OfferCard component not found");
}

describe("A25 — the results card renders only its approved fields", () => {
  it("declares exactly the approved data-field set and nothing more", () => {
    const src = readFileSync(findOfferCard(), "utf8");
    const found = [...src.matchAll(/data-field=["']([a-z-]+)["']/g)].map((m) => m[1] as string);
    const unique = [...new Set(found)].sort();

    expect(unique.length).toBeGreaterThan(0);
    const unapproved = unique.filter((f) => !APPROVED_FIELDS.includes(f));
    expect(unapproved).toEqual([]);
  });

  it("contains no banned commercial or social-proof surface", () => {
    const src = executableCode(readFileSync(findOfferCard(), "utf8")).toLowerCase();
    // Word-boundary patterns: "start" must not trip "star", "generating" must not
    // trip "rating".
    const banned: Array<[string, RegExp]> = [
      ["star rating", /\bstars?\b/],
      ["review score", /\breview\s*score\b|\breviewscore\b/],
      ["rating", /\bratings?\b/],
      ["popular", /\bpopular\b/],
      ["urgency", /\bonly\s+\d|\bhurry\b|\blast\s+room\b|\bselling\s+fast\b/],
      ["deal", /\bdeals?\b/],
      ["discount", /\bdiscounts?\b/],
      ["strikethrough price", /line-through|\bstrikethrough\b|<del\b|\bwas\s*₹/],
      ["carousel", /\bcarousel\b/],
      ["sponsored", /\bsponsored\b|\bpromoted\b|\bad\b/],
    ];
    const hits = banned.filter(([, re]) => re.test(src)).map(([name]) => name);
    expect(hits).toEqual([]);
  });

  it("never conveys a verdict by colour alone — the chip carries its word", () => {
    const chip = join(WEB, "components/VerdictChip.tsx");
    if (!existsSync(chip)) return;
    const src = readFileSync(chip, "utf8");
    expect(/In policy|Blocked/i.test(src)).toBe(true);
  });
});

describe("standing guard — revenue may never reorder results", () => {
  it("ranking code references no commission or revenue signal", () => {
    const rank = executableCode(
      readFileSync(new URL("../../src/core/rank.ts", import.meta.url).pathname, "utf8"),
    ).toLowerCase();
    for (const banned of ["commission", "revenue", "margin", "markup", "payout", "takerate", "take_rate"]) {
      expect(rank).not.toContain(banned);
    }
  });

  it("ranking reads commute before price, structurally", () => {
    const rank = executableCode(
      readFileSync(new URL("../../src/core/rank.ts", import.meta.url).pathname, "utf8"),
    );
    const commuteAt = rank.indexOf("commute");
    const priceAt = rank.search(/allInTotal|minor/);
    expect(commuteAt).toBeGreaterThan(-1);
    if (priceAt > -1) expect(commuteAt).toBeLessThan(priceAt);
  });
});
