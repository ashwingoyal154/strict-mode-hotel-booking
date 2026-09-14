/**
 * The booking state machine. §3.3 requires booking state to be a persisted
 * machine, which means illegal moves are rejected by code rather than by
 * convention — a cancelled booking that can be re-confirmed is a double charge.
 *
 * Slice 2 adds the states approvals and modify need: `pending_approval` (a request
 * waiting on a human, with no card issued), `rejected`, and `modified` (a
 * confirmed stay replaced by a new booking). All four end states are terminal.
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

/** The whole legal graph. `modified`, `rejected`, `cancelled` and `settled` are terminal by design. */
export const ALLOWED_TRANSITIONS: Record<BookingState, readonly BookingState[]> = {
  searched: ["held", "pending_approval", "confirmed"],
  held: ["pending_approval", "confirmed", "cancelled"],
  pending_approval: ["confirmed", "rejected", "cancelled"],
  confirmed: ["cancelled", "modified", "settled"],
  modified: [],
  rejected: [],
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
 * True only for a pending request. Withdrawing is the traveller's own "never mind"
 * — distinct from cancelling a stay, which has a free window and may cost money.
 */
export function canWithdraw(b: Booking): boolean {
  return b.state === "pending_approval";
}

/**
 * Whether a confirmed booking can still be cancelled for free at `now`. `now` is a
 * parameter, never a clock read, so tests and the server share one code path and
 * the cancellation window is reproducible.
 */
export function isCancellableAt(b: Booking, now: Date): boolean {
  // Only a confirmed stay has a free window to be inside of. A pending request is
  // withdrawn, not cancelled, and a hold has no supplier booking yet.
  if (b.state !== "confirmed") return false;

  // A non-refundable rate has no free window at all.
  if (b.cancellationDeadline === null) return false;

  const deadline = Date.parse(b.cancellationDeadline);
  if (Number.isNaN(deadline)) {
    throw new RangeError(`Booking ${b.id} has an unparseable cancellationDeadline`);
  }
  // Strictly before: at the deadline instant the free window has closed.
  return now.getTime() < deadline;
}
