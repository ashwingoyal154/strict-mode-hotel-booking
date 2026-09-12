import type { Booking, BookingState } from "../../src/core/types.ts";
import { money } from "../../src/core/money.ts";
import {
  ALLOWED_TRANSITIONS,
  IllegalTransitionError,
  assertTransition,
  canTransition,
  isCancellableAt,
} from "../../src/core/booking.ts";

const ALL_STATES: readonly BookingState[] = [
  "searched",
  "held",
  "confirmed",
  "cancelled",
  "settled",
];

function booking(over: Partial<Booking> = {}): Booking {
  const property = {
    id: "prop_1",
    name: "The Kurla Works",
    addressLine: "G Block, BKC",
    city: "Mumbai",
    cityTier: "metro",
    countryCode: "IN",
    geo: { lat: 19.0654, lng: 72.8686 },
    phone: "+91 22 0000 0000",
    brand: null,
    workReady: true,
    thumbnailUrl: null,
  };
  return {
    id: "bkg_1",
    confirmationCode: "7KQM4Z",
    travellerId: "trv_1",
    entityId: "acme",
    state: "confirmed",
    offer: {
      property,
      rate: {
        id: "off_1",
        propertyId: "prop_1",
        checkIn: "2026-06-11",
        checkOut: "2026-06-15",
        nights: 4,
        currency: "INR",
        components: [{ kind: "base", label: "Room", amount: money(3480000, "INR") }],
        allInTotal: money(3480000, "INR"),
        perNight: money(870000, "INR"),
        breakfastIncluded: true,
        refundableUntil: "2026-06-09T12:30:00.000Z",
        channel: "public",
        supplierRef: "sup-1",
        sourceId: "src_a",
      },
    },
    commute: { minutes: 7, mode: "walk", distanceMeters: 559 },
    verdict: {
      state: "in",
      reasonCode: "within_cap",
      reason: "₹8,700/night is within your ₹9,000 metro cap",
      policyVersion: 1,
      capPerNight: money(900000, "INR"),
      overageMinor: null,
    },
    anchor: {
      label: "Bandra Kurla Complex",
      geo: property.geo,
      city: "Mumbai",
      countryCode: "IN",
    },
    costCentre: "ENG-OPS",
    card: null,
    cancellationDeadline: "2026-06-09T12:30:00.000Z",
    createdAt: "2026-06-01T10:00:00.000Z",
    cancelledAt: null,
    idempotencyKey: "11111111-2222-3333-4444-555555555555",
    supplierBookingRef: "SUP-1",
    ...over,
  };
}

describe("ALLOWED_TRANSITIONS", () => {
  it("is exactly the Slice 1 graph", () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      searched: ["held", "confirmed"],
      held: ["confirmed", "cancelled"],
      confirmed: ["cancelled", "settled"],
      cancelled: [],
      settled: [],
    });
  });

  it("covers every BookingState, so no state is silently unreachable", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });

  it("omits the Slice 2 states rather than leaving them unreachable", () => {
    const reachable = Object.values(ALLOWED_TRANSITIONS).flat();
    expect(reachable).not.toContain("pending_approval");
    expect(reachable).not.toContain("modified");
  });
});

describe("canTransition", () => {
  it("allows every legal move", () => {
    expect(canTransition("searched", "held")).toBe(true);
    expect(canTransition("searched", "confirmed")).toBe(true);
    expect(canTransition("held", "confirmed")).toBe(true);
    expect(canTransition("held", "cancelled")).toBe(true);
    expect(canTransition("confirmed", "cancelled")).toBe(true);
    expect(canTransition("confirmed", "settled")).toBe(true);
  });

  it("lets nothing leave a terminal state — a re-confirmed cancellation is a double charge", () => {
    for (const to of ALL_STATES) {
      expect(canTransition("cancelled", to)).toBe(false);
      expect(canTransition("settled", to)).toBe(false);
    }
  });

  it("forbids the illegal moves that would lose money or history", () => {
    expect(canTransition("searched", "cancelled")).toBe(false);
    expect(canTransition("searched", "settled")).toBe(false);
    expect(canTransition("held", "settled")).toBe(false);
    expect(canTransition("confirmed", "held")).toBe(false);
    expect(canTransition("held", "searched")).toBe(false);
  });

  it("forbids a state transitioning to itself", () => {
    for (const state of ALL_STATES) expect(canTransition(state, state)).toBe(false);
  });
});

describe("assertTransition", () => {
  it("is silent on a legal move", () => {
    expect(() => assertTransition("confirmed", "cancelled")).not.toThrow();
  });

  it("throws IllegalTransitionError naming both states", () => {
    expect(() => assertTransition("cancelled", "confirmed")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("cancelled", "confirmed")).toThrow(
      "Illegal booking transition: cancelled → confirmed",
    );
  });

  it("carries the states on the error for the caller to log", () => {
    try {
      assertTransition("settled", "cancelled");
      expect.unreachable?.();
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      if (err instanceof IllegalTransitionError) {
        expect(err.from).toBe("settled");
        expect(err.to).toBe("cancelled");
        expect(err.name).toBe("IllegalTransitionError");
      }
    }
  });
});

describe("isCancellableAt", () => {
  const deadline = "2026-06-09T12:30:00.000Z";

  it("is true well inside the free window", () => {
    expect(isCancellableAt(booking(), new Date("2026-06-08T00:00:00.000Z"))).toBe(true);
  });

  it("is true one millisecond before the deadline", () => {
    expect(isCancellableAt(booking(), new Date("2026-06-09T12:29:59.999Z"))).toBe(true);
  });

  it("is false at the deadline instant — the window has closed", () => {
    expect(isCancellableAt(booking(), new Date(deadline))).toBe(false);
  });

  it("is false after the deadline", () => {
    expect(isCancellableAt(booking(), new Date("2026-06-10T00:00:00.000Z"))).toBe(false);
  });

  it("is false for a non-refundable booking, which has no window at all", () => {
    expect(
      isCancellableAt(booking({ cancellationDeadline: null }), new Date("2026-06-01T00:00:00.000Z")),
    ).toBe(false);
  });

  it("is false once the booking is already cancelled or settled", () => {
    const early = new Date("2026-06-01T00:00:00.000Z");
    expect(isCancellableAt(booking({ state: "cancelled" }), early)).toBe(false);
    expect(isCancellableAt(booking({ state: "settled" }), early)).toBe(false);
  });

  it("is false for a searched booking, which has nothing to cancel", () => {
    expect(isCancellableAt(booking({ state: "searched" }), new Date("2026-06-01T00:00:00.000Z"))).toBe(
      false,
    );
  });

  it("is true for a held booking inside the window", () => {
    expect(isCancellableAt(booking({ state: "held" }), new Date("2026-06-01T00:00:00.000Z"))).toBe(
      true,
    );
  });

  it("throws on an unparseable deadline rather than guessing", () => {
    expect(() =>
      isCancellableAt(booking({ cancellationDeadline: "soon" }), new Date("2026-06-01T00:00:00.000Z")),
    ).toThrow(RangeError);
  });

  it("reads no clock of its own — the same booking and instant always agree", () => {
    const b = booking();
    const at = new Date("2026-06-08T00:00:00.000Z");
    expect(isCancellableAt(b, at)).toBe(isCancellableAt(b, at));
  });
});
