import type { BookingState } from "../../src/core/types.ts";
import {
  ALLOWED_TRANSITIONS,
  IllegalTransitionError,
  assertTransition,
  canTransition,
  canWithdraw,
  isCancellableAt,
} from "../../src/core/booking.ts";
import { booking } from "./core-builders.ts";

const ALL_STATES: readonly BookingState[] = [
  "searched",
  "held",
  "pending_approval",
  "confirmed",
  "modified",
  "rejected",
  "cancelled",
  "settled",
];

const TERMINAL: readonly BookingState[] = ["modified", "rejected", "cancelled", "settled"];

describe("ALLOWED_TRANSITIONS", () => {
  it("is exactly the Slice 2 graph", () => {
    // Slice 2 deliberately replaces the Slice 1 graph: approvals and modify add states.
    expect(ALLOWED_TRANSITIONS).toEqual({
      searched: ["held", "pending_approval", "confirmed"],
      held: ["pending_approval", "confirmed", "cancelled"],
      pending_approval: ["confirmed", "rejected", "cancelled"],
      confirmed: ["cancelled", "modified", "settled"],
      modified: [],
      rejected: [],
      cancelled: [],
      settled: [],
    });
  });

  it("covers every BookingState, so no state is silently unreachable", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
    const reachable = new Set(Object.values(ALLOWED_TRANSITIONS).flat());
    for (const state of ALL_STATES) if (state !== "searched") expect(reachable.has(state)).toBe(true);
  });
});

describe("canTransition", () => {
  it("allows the approval path and the modify path", () => {
    expect(canTransition("searched", "pending_approval")).toBe(true);
    expect(canTransition("held", "pending_approval")).toBe(true);
    expect(canTransition("pending_approval", "confirmed")).toBe(true);
    expect(canTransition("pending_approval", "rejected")).toBe(true);
    expect(canTransition("pending_approval", "cancelled")).toBe(true);
    expect(canTransition("confirmed", "modified")).toBe(true);
  });

  it("keeps the Slice 1 moves", () => {
    expect(canTransition("searched", "held")).toBe(true);
    expect(canTransition("searched", "confirmed")).toBe(true);
    expect(canTransition("held", "confirmed")).toBe(true);
    expect(canTransition("held", "cancelled")).toBe(true);
    expect(canTransition("confirmed", "cancelled")).toBe(true);
    expect(canTransition("confirmed", "settled")).toBe(true);
  });

  it("lets nothing leave a terminal state", () => {
    for (const from of TERMINAL) for (const to of ALL_STATES) expect(canTransition(from, to)).toBe(false);
  });

  it("forbids the moves that would lose money or skip an approval", () => {
    expect(canTransition("pending_approval", "settled")).toBe(false);
    expect(canTransition("pending_approval", "held")).toBe(false);
    expect(canTransition("confirmed", "pending_approval")).toBe(false);
    expect(canTransition("searched", "rejected")).toBe(false);
    expect(canTransition("held", "modified")).toBe(false);
  });

  it("forbids a state transitioning to itself", () => {
    for (const state of ALL_STATES) expect(canTransition(state, state)).toBe(false);
  });
});

describe("assertTransition", () => {
  it("is silent on a legal move", () => {
    expect(() => assertTransition("pending_approval", "confirmed")).not.toThrow();
  });

  it("throws IllegalTransitionError naming both states", () => {
    expect(() => assertTransition("rejected", "confirmed")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("rejected", "confirmed")).toThrow("Illegal booking transition: rejected → confirmed");
  });
});

describe("canWithdraw", () => {
  it("is true only for a pending request", () => {
    for (const state of ALL_STATES) {
      expect(canWithdraw(booking({ state }))).toBe(state === "pending_approval");
    }
  });
});

describe("isCancellableAt", () => {
  it("is true for a confirmed booking before the deadline, and false at it", () => {
    expect(isCancellableAt(booking(), new Date("2026-06-09T12:29:59.999Z"))).toBe(true);
    expect(isCancellableAt(booking(), new Date("2026-06-09T12:30:00.000Z"))).toBe(false);
  });

  it("is false for every state other than confirmed, even inside the window", () => {
    const early = new Date("2026-06-01T00:00:00.000Z");
    for (const state of ALL_STATES) {
      if (state === "confirmed") continue;
      expect(isCancellableAt(booking({ state }), early)).toBe(false);
    }
  });

  it("is false for a non-refundable booking", () => {
    expect(isCancellableAt(booking({ cancellationDeadline: null }), new Date("2026-06-01T00:00:00.000Z"))).toBe(false);
  });

  it("throws on an unparseable deadline rather than guessing", () => {
    expect(() => isCancellableAt(booking({ cancellationDeadline: "soon" }), new Date("2026-06-01T00:00:00.000Z"))).toThrow(
      RangeError,
    );
  });
});
