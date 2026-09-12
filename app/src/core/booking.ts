/**
 * The booking state machine. §3.3 requires booking state to be a persisted
 * machine, which means illegal moves are rejected by code rather than by
 * convention — a cancelled booking that can be re-confirmed is a double charge.
 *
 * Slice 1 implements a subset of the full graph: `pending_approval` and
 * `modified` arrive with approvals in Slice 2, so they are absent here rather
 * than present and unreachable.
 */

import type { Booking, BookingState } from "./types.ts";

/** Thrown on any transition the machine does not allow. */
export class IllegalTransitionError extends Error {
  readonly from: BookingState;
  readonly to: BookingState;

  constructor(from: BookingState, to: BookingState) {
    super(`Illegal booking transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** The whole legal graph. `cancelled` and `settled` are terminal by design. */
export const ALLOWED_TRANSITIONS: Record<BookingState, readonly BookingState[]> = {
  searched: ["held", "confirmed"],
  held: ["confirmed", "cancelled"],
  confirmed: ["cancelled", "settled"],
  cancelled: [],
  settled: [],
};

/** True only when the graph permits this exact move; no state transitions to itself. */
export function canTransition(from: BookingState, to: BookingState): boolean {
  const allowed: readonly BookingState[] | undefined = ALLOWED_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/** Throws IllegalTransitionError unless the move is in the graph. */
export function assertTransition(from: BookingState, to: BookingState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/**
 * Whether a booking can still be cancelled for free at `now`. `now` is a
 * parameter, never a clock read, so tests and the server share one code path
 * and the cancellation window is reproducible.
 */
export function isCancellableAt(b: Booking, now: Date): boolean {
  if (!canTransition(b.state, "cancelled")) return false;

  // A non-refundable rate has no free window at all — there is nothing to be inside of.
  if (b.cancellationDeadline === null) return false;

  const deadline = Date.parse(b.cancellationDeadline);
  if (Number.isNaN(deadline)) {
    throw new RangeError(`Booking ${b.id} has an unparseable cancellationDeadline`);
  }
  // Strictly before: at the deadline instant the free window has closed.
  return now.getTime() < deadline;
}
