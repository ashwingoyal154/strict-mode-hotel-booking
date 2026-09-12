/**
 * Policy evaluation — a pure, versioned function (§3.3).
 *
 * A12 is the constraint that shapes every line here: re-running `evaluate`
 * against a stored booking must reproduce the verdict **and the reason string**
 * byte-identically, years later. That forbids, inside this module:
 *   - any clock (`Date.now`), any randomness, any I/O
 *   - any locale-dependent formatting (hence `formatMoney`, never Intl)
 *   - any dependence on object key order
 *   - any change to the order of the checks below
 *
 * The check order is part of the contract, not an implementation detail: a rate
 * that is both from a blocked supplier and over cap must keep reporting
 * `blocked_supplier` forever, or a stored audit record stops matching.
 */

import type {
  Money,
  Policy,
  PolicyReasonCode,
  PolicyVerdict,
  Property,
  Rate,
  Booking,
} from "./types.ts";
import { compareMoney, formatMoney, multiplyMoney, subMoney } from "./money.ts";

/**
 * Version of this evaluator's logic, distinct from `Policy.version` (the
 * version of the authored caps). Bumping this is how a future change to the
 * rules stays distinguishable from a change to a customer's numbers.
 */
export const POLICY_EVALUATOR_VERSION = 1;

interface ResolvedCap {
  readonly cap: Money;
  /** `property.city` when a named-city override matched, else `property.cityTier`. */
  readonly label: string;
}

/**
 * Resolves the effective nightly cap: a named-city override beats the city-tier
 * cap (§2.9). The first match in `policy.caps` wins — array order, never object
 * key order, so resolution is reproducible.
 */
function resolveCap(policy: Policy, property: Property): ResolvedCap | null {
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

/** The nightly cap that applies to a property, or null when the policy sets none. */
export function capFor(policy: Policy, property: Property): Money | null {
  return resolveCap(policy, property)?.cap ?? null;
}

function blocked(reasonCode: PolicyReasonCode, reason: string, policyVersion: number): PolicyVerdict {
  return { state: "blocked", reasonCode, reason, policyVersion, capPerNight: null, overageMinor: null };
}

/**
 * Decides whether a rate is bookable, in the fixed order
 * blocked_country → blocked_supplier → flex_required → over_cap → within_cap.
 * Same inputs always produce byte-identical output (A12).
 */
export function evaluate(args: { rate: Rate; property: Property; policy: Policy }): PolicyVerdict {
  const { rate, property, policy } = args;
  const version = policy.version;

  // 1. Restricted country — duty of care outranks everything, including price.
  if (policy.blockedCountries.includes(property.countryCode)) {
    return blocked(
      "blocked_country",
      `Bookings in ${property.countryCode} are blocked by your travel policy`,
      version,
    );
  }

  // 2. Unapproved supplier.
  if (policy.blockedSuppliers.includes(rate.sourceId)) {
    return blocked("blocked_supplier", "This supplier is not approved by your travel policy", version);
  }

  // 3. Flexibility requirement: refundableUntil === null *is* non-refundable.
  if (policy.requireFlexible && rate.refundableUntil === null) {
    return blocked("flex_required", "Your policy requires a free-cancellation rate", version);
  }

  const resolved = resolveCap(policy, property);

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

/**
 * Re-evaluates a stored booking from its own frozen offer snapshot — never live
 * supply — which is what makes A12's byte-identical replay possible at all.
 */
export function replay(booking: Booking, policy: Policy): PolicyVerdict {
  return evaluate({
    rate: booking.offer.rate,
    property: booking.offer.property,
    policy,
  });
}
