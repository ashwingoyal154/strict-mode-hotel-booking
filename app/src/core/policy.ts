/**
 * Policy evaluation — a pure, versioned function (§3.3).
 *
 * A12 is the constraint that shapes every line here: re-running evaluation
 * against a stored booking must reproduce the verdict **and the reason string**
 * byte-identically, years later. That forbids, inside this module:
 *   - any clock, any randomness, any I/O
 *   - any locale-dependent formatting (hence `formatMoney`, never Intl)
 *   - any dependence on object key order
 *   - any change to the order of the checks below
 *
 * Two evaluators live here, because a stored verdict must be replayed by the
 * evaluator that produced it. v1 is Slice 1's, frozen: over cap was unbookable
 * and so read `blocked`. v2 makes over cap a real state (`over`, bookable through
 * approval) and adds currency — the FX pin is an *input*, recorded on the
 * verdict, so replay never needs to look up today's rate.
 */

import type {
  Booking,
  Currency,
  FxRate,
  IsoMonth,
  Money,
  Policy,
  PolicyCap,
  PolicyReasonCode,
  PolicyState,
  PolicyVerdict,
  Property,
  Rate,
  TravelAdvisory,
} from "./types.ts";
import { compareMoney, formatMoney, multiplyMoney, subMoney } from "./money.ts";
import { NoFxPinError, convertVia, monthLabel } from "./fx.ts";

/**
 * Version of the evaluator logic currently used for new verdicts, distinct from
 * `Policy.version` (the version of the authored caps).
 */
export const POLICY_EVALUATOR_VERSION = 2;

const EVALUATOR_V2 = 2;

function nightsPhrase(nights: number): string {
  return `${nights} ${nights === 1 ? "night" : "nights"}`;
}

// =====================================================================
// Evaluator v1 — FROZEN. Moved here unchanged from Slice 1. Do not edit:
// every Slice 1 booking's stored verdict is replayed through this code.
// =====================================================================

interface ResolvedCapV1 {
  readonly cap: Money;
  /** `property.city` when a named-city override matched, else `property.cityTier`. */
  readonly label: string;
}

/**
 * Resolves the effective nightly cap: a named-city override beats the city-tier
 * cap (§2.9). The first match in `policy.caps` wins — array order, never object
 * key order, so resolution is reproducible.
 */
function resolveCapV1(policy: Policy, property: Property): ResolvedCapV1 | null {
  const override = policy.caps.find((c) => c.city !== null && c.city === property.city);
  if (override !== undefined) {
    return { cap: override.perNight, label: property.city };
  }
  const tier = policy.caps.find((c) => c.city === null && c.cityTier === property.cityTier);
  if (tier !== undefined) {
    return { cap: tier.perNight, label: property.cityTier };
  }
  return null;
}

function blockedV1(reasonCode: PolicyReasonCode, reason: string, policyVersion: number): PolicyVerdict {
  return { state: "blocked", reasonCode, reason, policyVersion, capPerNight: null, overageMinor: null };
}

/**
 * The Slice 1 evaluator, byte-for-byte: fixed order blocked_country →
 * blocked_supplier → flex_required → over_cap → within_cap, over cap reads
 * `blocked`, and the output carries no Slice 2 keys.
 */
export function evaluateV1(args: { rate: Rate; property: Property; policy: Policy }): PolicyVerdict {
  const { rate, property, policy } = args;
  const version = policy.version;

  // 1. Restricted country — duty of care outranks everything, including price.
  if (policy.blockedCountries.includes(property.countryCode)) {
    return blockedV1(
      "blocked_country",
      `Bookings in ${property.countryCode} are blocked by your travel policy`,
      version,
    );
  }

  // 2. Unapproved supplier.
  if (policy.blockedSuppliers.includes(rate.sourceId)) {
    return blockedV1("blocked_supplier", "This supplier is not approved by your travel policy", version);
  }

  // 3. Flexibility requirement: refundableUntil === null *is* non-refundable.
  if (policy.requireFlexible && rate.refundableUntil === null) {
    return blockedV1("flex_required", "Your policy requires a free-cancellation rate", version);
  }

  const resolved = resolveCapV1(policy, property);

  // 4. Over cap. Strict greater-than: a rate exactly at the cap is in policy.
  if (resolved !== null && compareMoney(rate.perNight, resolved.cap) > 0) {
    const overagePerNight = subMoney(rate.perNight, resolved.cap);
    const overageStay = multiplyMoney(overagePerNight, rate.nights);
    return {
      state: "blocked",
      reasonCode: "over_cap",
      reason:
        `${formatMoney(rate.perNight)}/night is over your ${formatMoney(resolved.cap)} ${resolved.label} cap ` +
        `by ${formatMoney(overagePerNight)} — ${formatMoney(overageStay)} for ${rate.nights} ${rate.nights === 1 ? "night" : "nights"}`,
      policyVersion: version,
      capPerNight: resolved.cap,
      overageMinor: overagePerNight.minor,
    };
  }

  // 5. In policy. Two phrasings, because a market with no authored cap must say
  // so plainly rather than imply a cap that does not exist (§2.5).
  if (resolved === null) {
    return {
      state: "in",
      reasonCode: "within_cap",
      reason: `${formatMoney(rate.perNight)}/night is within your travel policy — no cap is set for ${property.cityTier}`,
      policyVersion: version,
      capPerNight: null,
      overageMinor: null,
    };
  }

  return {
    state: "in",
    reasonCode: "within_cap",
    reason: `${formatMoney(rate.perNight)}/night is within your ${formatMoney(resolved.cap)} ${resolved.label} cap`,
    policyVersion: version,
    capPerNight: resolved.cap,
    overageMinor: null,
  };
}

// =====================================================================
// Evaluator v2
// =====================================================================

interface ResolvedCap {
  readonly cap: Money;
  readonly label: string;
}

/**
 * Among rows at one level, a cap authored in the rate's own currency beats one
 * that would need converting: an authored number is a decision, a converted one
 * is an approximation of somebody else's decision.
 */
function pickRow(rows: readonly PolicyCap[], rateCurrency: Currency | undefined): PolicyCap | undefined {
  const sameCurrency =
    rateCurrency === undefined ? undefined : rows.find((r) => r.perNight.currency === rateCurrency);
  return sameCurrency ?? rows[0];
}

function resolveCap(policy: Policy, property: Property, rateCurrency: Currency | undefined): ResolvedCap | null {
  // The level is decided before the currency: a London row authored in INR still
  // beats a global-tier row authored in GBP, because the admin named the city.
  const cityRow = pickRow(
    policy.caps.filter((c) => c.city !== null && c.city === property.city),
    rateCurrency,
  );
  if (cityRow !== undefined) return { cap: cityRow.perNight, label: property.city };

  const tierRow = pickRow(
    policy.caps.filter((c) => c.city === null && c.cityTier === property.cityTier),
    rateCurrency,
  );
  if (tierRow !== undefined) return { cap: tierRow.perNight, label: property.cityTier };

  return null;
}

/**
 * The nightly cap for a property: named-city rows beat tier rows, and at the
 * winning level a cap in `rateCurrency` beats one in another currency. Null when
 * the policy authors none.
 */
export function capFor(policy: Policy, property: Property, rateCurrency?: Currency): Money | null {
  return resolveCap(policy, property, rateCurrency)?.cap ?? null;
}

const ADVISORY_SEVERITY: Readonly<Record<TravelAdvisory["level"], number>> = { high: 0, caution: 1 };

/**
 * The advisory to flag for a property: the most severe one matching its country,
 * city-specific before country-wide at equal severity, then authored order. Null
 * when none applies.
 */
export function advisoryFor(policy: Policy, property: Property): TravelAdvisory | null {
  let best: TravelAdvisory | null = null;
  for (const advisory of policy.advisories) {
    if (advisory.countryCode !== property.countryCode) continue;
    if (advisory.city !== null && advisory.city !== property.city) continue;
    if (best === null) {
      best = advisory;
      continue;
    }
    const severity = ADVISORY_SEVERITY[advisory.level] - ADVISORY_SEVERITY[best.level];
    const specificity = (advisory.city === null ? 1 : 0) - (best.city === null ? 1 : 0);
    // Strictly better only, so the earlier-authored advisory wins a tie.
    if (severity < 0 || (severity === 0 && specificity < 0)) best = advisory;
  }
  return best;
}

/** Builds a v2 verdict with one fixed key order, so JSON.stringify output is stable. */
function verdictV2(fields: {
  state: PolicyState;
  reasonCode: PolicyReasonCode;
  reason: string;
  policyVersion: number;
  capPerNight: Money | null;
  overage: Money | null;
  fxPin: FxRate | null;
  advisory: TravelAdvisory | null;
}): PolicyVerdict {
  return {
    state: fields.state,
    reasonCode: fields.reasonCode,
    reason: fields.reason,
    policyVersion: fields.policyVersion,
    capPerNight: fields.capPerNight,
    overageMinor: fields.overage === null ? null : fields.overage.minor,
    evaluatorVersion: EVALUATOR_V2,
    overage: fields.overage,
    fxPin: fields.fxPin,
    advisory: fields.advisory,
  };
}

/**
 * The Slice 2 evaluator. Same check order as v1; over cap is `over`; a rate in
 * another currency is converted at a `pinned_monthly` pin only, and with no pin
 * the verdict is `over` — never silently in policy. Pure: `pinMonth` is passed in.
 */
export function evaluate(args: {
  rate: Rate;
  property: Property;
  policy: Policy;
  fxPins: readonly FxRate[];
  pinMonth: IsoMonth;
}): PolicyVerdict {
  const { rate, property, policy, fxPins, pinMonth } = args;
  const policyVersion = policy.version;
  const advisory = advisoryFor(policy, property);

  const blocked = (reasonCode: PolicyReasonCode, reason: string): PolicyVerdict =>
    verdictV2({
      state: "blocked",
      reasonCode,
      reason,
      policyVersion,
      capPerNight: null,
      overage: null,
      fxPin: null,
      advisory,
    });

  // 1–3: unchanged from v1, strings included.
  if (policy.blockedCountries.includes(property.countryCode)) {
    return blocked("blocked_country", `Bookings in ${property.countryCode} are blocked by your travel policy`);
  }
  if (policy.blockedSuppliers.includes(rate.sourceId)) {
    return blocked("blocked_supplier", "This supplier is not approved by your travel policy");
  }
  if (policy.requireFlexible && rate.refundableUntil === null) {
    return blocked("flex_required", "Your policy requires a free-cancellation rate");
  }

  const perNight = rate.perNight;
  const resolved = resolveCap(policy, property, perNight.currency);

  if (resolved === null) {
    return verdictV2({
      state: "in",
      reasonCode: "within_cap",
      reason: `${formatMoney(perNight)}/night is within your travel policy — no cap is set for ${property.cityTier}`,
      policyVersion,
      capPerNight: null,
      overage: null,
      fxPin: null,
      advisory,
    });
  }

  const { cap, label } = resolved;
  const capText = `${formatMoney(cap)} ${label} cap`;

  // 4a. Different currencies: convert at a monthly pin, or refuse to call it in policy.
  let compared: Money = perNight;
  let fxPin: FxRate | null = null;
  let rateText = `${formatMoney(perNight)}/night`;

  if (cap.currency !== perNight.currency) {
    const pinned = fxPins.filter((p) => p.source === "pinned_monthly");
    try {
      const conversion = convertVia(perNight, cap.currency, pinned);
      compared = conversion.to;
      fxPin = conversion.fx;
    } catch (err) {
      if (!(err instanceof NoFxPinError)) throw err;
      // An unconvertible rate goes to a human rather than through the door: the
      // overage is unknown, so it is null, not zero.
      return verdictV2({
        state: "over",
        reasonCode: "over_cap",
        reason:
          `${formatMoney(perNight)}/night can't be checked against your ${capText} — there is no pinned ` +
          `${perNight.currency}→${cap.currency} rate for ${monthLabel(pinMonth)}, so it needs approval`,
        policyVersion,
        capPerNight: cap,
        overage: null,
        fxPin: null,
        advisory,
      });
    }
    // The pin's own month names the rate, so a replay reads the month it used.
    const month = fxPin?.pinMonth ?? pinMonth;
    rateText = `${formatMoney(perNight)}/night (${formatMoney(compared)} at the ${monthLabel(month)} pinned rate)`;
  }

  // 4b. Over cap, strictly greater-than; the overage is argued in the cap currency.
  if (compareMoney(compared, cap) > 0) {
    const overage = subMoney(compared, cap);
    const overageStay = multiplyMoney(overage, rate.nights);
    return verdictV2({
      state: "over",
      reasonCode: "over_cap",
      reason: `${rateText} is over your ${capText} by ${formatMoney(overage)} — ${formatMoney(overageStay)} for ${nightsPhrase(rate.nights)}`,
      policyVersion,
      capPerNight: cap,
      overage,
      fxPin,
      advisory,
    });
  }

  // 5. Within cap.
  return verdictV2({
    state: "in",
    reasonCode: "within_cap",
    reason: `${rateText} is within your ${capText}`,
    policyVersion,
    capPerNight: cap,
    overage: null,
    fxPin,
    advisory,
  });
}

// =====================================================================
// Replay
// =====================================================================

const MS_PER_DAY = 86_400_000;

/**
 * The UTC calendar month of an ISO instant, by civil-date arithmetic (Hinnant's
 * days-to-civil). Written out rather than via a Date object so this module stays
 * provably clock-free — the purity test forbids `new Date` here.
 */
function utcMonthOfInstant(iso: string): IsoMonth {
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) throw new RangeError(`Expected an ISO date-time, received "${iso}"`);
  const z = Math.floor(stamp / MS_PER_DAY) + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/**
 * Re-evaluates a stored booking from its own frozen snapshot with the evaluator
 * that produced its verdict (`evaluatorVersion ?? 1`). A v2 replay is fed only the
 * verdict's own pin, never today's pins.
 */
export function replay(booking: Booking, policy: Policy): PolicyVerdict {
  const version = booking.verdict.evaluatorVersion ?? 1;
  const rate = booking.offer.rate;
  const property = booking.offer.property;

  if (version === 1) return evaluateV1({ rate, property, policy });

  if (version === EVALUATOR_V2) {
    const fxPin = booking.verdict.fxPin ?? null;
    return evaluate({
      rate,
      property,
      policy,
      fxPins: fxPin === null ? [] : [fxPin],
      pinMonth: fxPin?.pinMonth ?? utcMonthOfInstant(booking.createdAt),
    });
  }

  throw new RangeError(`Unknown policy evaluator version ${String(version)}`);
}
