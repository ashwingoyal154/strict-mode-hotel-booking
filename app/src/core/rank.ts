/**
 * Result ordering. Commute time is the only thing this product sells (§2.4), and
 * §3.4 forbids revenue from reordering results — so this module reads
 * `commute.minutes` first and has no access to, and no concept of, commission.
 *
 * Channel is used once, and only as a tiebreak at identical commute time: a
 * negotiated corporate rate is the same trip at a better price, not a better trip.
 */

import type { Commute, Offer, PolicyVerdict, RankedOffer } from "./types.ts";

export interface RankInput {
  offer: Offer;
  commute: Commute;
  verdict: PolicyVerdict;
}

/**
 * Total ordering over candidates. The sequence is fixed and each step is only
 * reached when the previous one ties:
 *   1. commute minutes ascending  — the product's promise
 *   2. negotiated channel first   — tiebreak only
 *   3. all-in total ascending     — never consulted before commute
 *   4. property id ascending      — determinism, so the same search ranks the same way twice
 */
function compareCandidates(a: RankInput, b: RankInput): number {
  if (a.commute.minutes !== b.commute.minutes) {
    return a.commute.minutes - b.commute.minutes;
  }

  const aNegotiated = a.offer.rate.channel === "negotiated" ? 0 : 1;
  const bNegotiated = b.offer.rate.channel === "negotiated" ? 0 : 1;
  if (aNegotiated !== bNegotiated) return aNegotiated - bNegotiated;

  const aTotal = a.offer.rate.allInTotal;
  const bTotal = b.offer.rate.allInTotal;
  // Mixed currencies must not throw here — a partially mixed result list should
  // still order deterministically rather than fail the whole page. Codes are
  // compared with < / > because localeCompare is locale-dependent.
  if (aTotal.currency !== bTotal.currency) {
    return aTotal.currency < bTotal.currency ? -1 : 1;
  }
  if (aTotal.minor !== bTotal.minor) return aTotal.minor - bTotal.minor;

  const aId = a.offer.property.id;
  const bId = b.offer.property.id;
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

/**
 * Which of several rates for the SAME property the traveller should see. Four
 * sources each return the same hotel, so without this the results page shows one
 * building four times at four prices — and the commute-ranked list, the entire
 * product, becomes unreadable.
 *
 * Preference, in order:
 *   1. bookable over blocked  — show the rate they can actually book
 *   2. negotiated channel     — same trip, better price
 *   3. cheapest all-in
 *   4. rate id                — determinism
 */
function preferenceWithinProperty(a: RankInput, b: RankInput): number {
  const aBookable = a.verdict.state === "in" ? 0 : 1;
  const bBookable = b.verdict.state === "in" ? 0 : 1;
  if (aBookable !== bBookable) return aBookable - bBookable;

  const aNegotiated = a.offer.rate.channel === "negotiated" ? 0 : 1;
  const bNegotiated = b.offer.rate.channel === "negotiated" ? 0 : 1;
  if (aNegotiated !== bNegotiated) return aNegotiated - bNegotiated;

  const aTotal = a.offer.rate.allInTotal;
  const bTotal = b.offer.rate.allInTotal;
  if (aTotal.currency !== bTotal.currency) {
    return aTotal.currency < bTotal.currency ? -1 : 1;
  }
  if (aTotal.minor !== bTotal.minor) return aTotal.minor - bTotal.minor;

  const aId = a.offer.rate.id;
  const bId = b.offer.rate.id;
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

/**
 * One row per property, keeping the best rate for each. Order-independent: the
 * result does not depend on which source answered first, which matters because
 * sources answer in whatever order the network gives them.
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
 * Ranks offers by commute time, one row per property, numbering only bookable
 * ("in") offers 1..n and returning blocked offers unranked at the end, for the
 * "show blocked" disclosure.
 */
export function rankOffers(inputs: readonly RankInput[]): RankedOffer[] {
  const deduped = dedupeByProperty(inputs);
  const bookable = deduped.filter((i) => i.verdict.state === "in").sort(compareCandidates);
  const blocked = deduped.filter((i) => i.verdict.state !== "in").sort(compareCandidates);

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
  }));

  for (const input of blocked) {
    ranked.push({
      offer: input.offer,
      commute: input.commute,
      verdict: input.verdict,
      rank: 0,
      rankReason: "",
    });
  }

  return ranked;
}
