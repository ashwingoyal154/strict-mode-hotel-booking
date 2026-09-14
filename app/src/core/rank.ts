/**
 * Result ordering. Commute time is the only thing this product sells (§2.4), and
 * §3.4 forbids revenue from reordering results — so this module reads
 * `commute.minutes` first and has no access to, and no concept of, commission.
 *
 * Slice 2: over-cap offers are bookable (through approval), so they are ranked
 * and numbered alongside in-policy ones. Policy state is a tiebreak, not a
 * partition: a hotel next door that needs a manager's yes is still closer than
 * one across town that does not, and the traveller is shown that truthfully.
 *
 * Price is compared in the display currency (`display.to`), because a page that
 * mixes £ and ₹ rates can only be ordered by a figure that shares one currency.
 */

import type { Commute, Conversion, Offer, PolicyVerdict, RankedOffer } from "./types.ts";

export interface RankInput {
  offer: Offer;
  commute: Commute;
  verdict: PolicyVerdict;
  display: Conversion;
}

function stateOrder(verdict: PolicyVerdict): number {
  if (verdict.state === "in") return 0;
  if (verdict.state === "over") return 1;
  return 2;
}

function negotiatedOrder(input: RankInput): number {
  return input.offer.rate.channel === "negotiated" ? 0 : 1;
}

function compareText(a: string, b: string): number {
  // < and > rather than localeCompare, which depends on the host locale.
  if (a === b) return 0;
  return a < b ? -1 : 1;
}


/**
 * Total ordering over candidates. Each step is only reached when the previous
 * one ties:
 *   1. commute minutes ascending   — the product's promise
 *   2. in before over              — tiebreak only, at identical commute
 *   3. negotiated channel first    — tiebreak only
 *   4. displayed total ascending   — never consulted before commute
 *   5. property id ascending       — determinism
 */
function compareCandidates(a: RankInput, b: RankInput): number {
  if (a.commute.minutes !== b.commute.minutes) {
    return a.commute.minutes - b.commute.minutes;
  }

  const state = stateOrder(a.verdict) - stateOrder(b.verdict);
  if (state !== 0) return state;

  const channel = negotiatedOrder(a) - negotiatedOrder(b);
  if (channel !== 0) return channel;

  const price = compareDisplayed(a, b);
  if (price !== 0) return price;

  return compareText(a.offer.property.id, b.offer.property.id);
}

/** Display-currency price order; mixed currencies still order deterministically instead of throwing. */
function compareDisplayed(a: RankInput, b: RankInput): number {
  const aShown = a.display.to;
  const bShown = b.display.to;
  if (aShown.currency !== bShown.currency) return compareText(aShown.currency, bShown.currency);
  return aShown.minor - bShown.minor;
}

/**
 * Which of several rates for the SAME property the traveller should see:
 *   1. in → over → blocked   — show the rate that is easiest to actually book
 *   2. negotiated channel    — same trip, better terms
 *   3. lower displayed total
 *   4. rate id               — determinism
 */
function preferenceWithinProperty(a: RankInput, b: RankInput): number {
  const state = stateOrder(a.verdict) - stateOrder(b.verdict);
  if (state !== 0) return state;

  const channel = negotiatedOrder(a) - negotiatedOrder(b);
  if (channel !== 0) return channel;

  const price = compareDisplayed(a, b);
  if (price !== 0) return price;

  return compareText(a.offer.rate.id, b.offer.rate.id);
}

/**
 * One row per property, keeping the preferred rate for each. Independent of input
 * order, which matters because sources answer in whatever order the network gives.
 */
export function dedupeByProperty(inputs: readonly RankInput[]): RankInput[] {
  const best = new Map<string, RankInput>();
  for (const input of inputs) {
    const held = best.get(input.offer.property.id);
    if (held === undefined || preferenceWithinProperty(input, held) < 0) {
      best.set(input.offer.property.id, input);
    }
  }
  return [...best.values()];
}

/**
 * Ranks by commute time, one row per property, numbering `in` and `over` offers
 * together 1..n and returning blocked offers last with rank 0 and no reason.
 */
export function rankOffers(inputs: readonly RankInput[]): RankedOffer[] {
  const deduped = dedupeByProperty(inputs);
  const bookable = deduped.filter((i) => i.verdict.state !== "blocked").sort(compareCandidates);
  const blocked = deduped.filter((i) => i.verdict.state === "blocked").sort(compareCandidates);

  const closest = bookable[0]?.commute.minutes ?? 0;

  const ranked: RankedOffer[] = bookable.map((input, index) => ({
    offer: input.offer,
    commute: input.commute,
    verdict: input.verdict,
    rank: index + 1,
    rankReason:
      index === 0
        ? "closest to your meeting"
        : input.commute.minutes === closest
          ? "as close as the closest"
          : `+${input.commute.minutes - closest} min vs closest`,
    display: input.display,
  }));

  for (const input of blocked) {
    ranked.push({
      offer: input.offer,
      commute: input.commute,
      verdict: input.verdict,
      rank: 0,
      rankReason: "",
      display: input.display,
    });
  }

  return ranked;
}
