/**
 * Chaos knobs for the fixture supply. Fixtures must be adversarial, not
 * happy-path (SPEC.md §3.1) — this is how price drift, sold-out-on-confirm and
 * source timeout become reproducible on demand instead of accidental.
 *
 * Two mechanisms, deliberately separate:
 *  - Marker suffixes: offer ids ending with DRIFT_MARKER_SUFFIX /
 *    SOLD_OUT_MARKER_SUFFIX / LATE_DRIFT_MARKER_SUFFIX ALWAYS misbehave,
 *    unconditionally of ChaosConfig.enabled. This is the addressable,
 *    deterministic canary a test can rely on without wiring any config at all.
 *  - ChaosConfig: additional, opt-in-by-id chaos for tests that want to force
 *    an arbitrary source to time out or an arbitrary offer to drift/sell out,
 *    gated by `enabled` so a test can flip it off entirely.
 */

export type FailureMode = "none" | "timeout" | "drift" | "sold_out" | "slow";

export interface ChaosConfig {
  readonly timeoutSourceIds: string[];
  readonly driftOfferIds: string[];
  readonly soldOutOfferIds: string[];
  /** Per-source latency override in ms, applied when `enabled` is true. */
  readonly latencyMs: Record<string, number>;
  readonly enabled: boolean;
}

/** Offer ids ending with this suffix always drift at priceCheck/book. */
export const DRIFT_MARKER_SUFFIX = "~DRIFT";
/** Offer ids ending with this suffix are always sold out at priceCheck/book. */
export const SOLD_OUT_MARKER_SUFFIX = "~SOLDOUT";
/**
 * Offer ids ending with this suffix re-price stably at priceCheck, but drift at
 * `book` when booked without a hold. It is how "approved, but the rate moved
 * while the approver thought about it" is tested without any server state.
 * Note "~LATEDRIFT" does not end with "~DRIFT" (the character before DRIFT is
 * "E", not "~"), so the two canaries never overlap.
 */
export const LATE_DRIFT_MARKER_SUFFIX = "~LATEDRIFT";

/** Chaos is on by default (only the marker canaries + any explicit ids bite). */
export function defaultChaos(): ChaosConfig {
  return {
    timeoutSourceIds: [],
    driftOfferIds: [],
    soldOutOfferIds: [],
    latencyMs: {},
    enabled: true,
  };
}

/**
 * `SM_CHAOS=off|on` toggles the master switch (default on).
 * `SM_CHAOS_TIMEOUT=<sourceId>` forces that one source to always time out.
 */
export function chaosFromEnv(env: NodeJS.ProcessEnv): ChaosConfig {
  const base = defaultChaos();
  const enabled = env.SM_CHAOS === "off" ? false : base.enabled;
  const timeoutSourceId = env.SM_CHAOS_TIMEOUT?.trim();
  return {
    ...base,
    enabled,
    timeoutSourceIds: timeoutSourceId ? [timeoutSourceId] : base.timeoutSourceIds,
  };
}
