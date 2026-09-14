import type { Offer } from "../../src/core/types.ts";
import { money } from "../../src/core/money.ts";
import { canModify, quoteModify } from "../../src/core/modify.ts";
import { SLICE1_IN_VERDICT, booking, property, rate } from "./core-builders.ts";

const CURRENT = booking({
  offer: {
    property: property(),
    rate: rate({ allInTotal: money(2632800, "INR"), components: [{ kind: "base", label: "Room", amount: money(2632800, "INR") }] }),
  },
  cancellationDeadline: "2026-09-20T12:30:00.000Z",
});
const INSIDE = new Date("2026-09-15T00:00:00.000Z");
const OUTSIDE = new Date("2026-09-21T00:00:00.000Z");

function offer(totalMinor: number, currency = "INR"): Offer {
  const total = money(totalMinor, currency);
  return {
    property: property({ id: "prop_new" }),
    rate: rate({ id: "off_new", currency, allInTotal: total, components: [{ kind: "base", label: "Room", amount: total }] }),
  };
}

function quote(newOffer: Offer, now = INSIDE) {
  return quoteModify({ booking: CURRENT, newOffer, newVerdict: SLICE1_IN_VERDICT, searchId: "srch_2", now });
}

describe("canModify", () => {
  it("allows a confirmed booking inside its free window", () => {
    expect(canModify(CURRENT, INSIDE)).toEqual({ ok: true });
  });

  it("refuses a booking that is not confirmed", () => {
    expect(canModify({ ...CURRENT, state: "pending_approval" }, INSIDE)).toEqual({
      ok: false,
      code: "not_confirmed",
      message: "Only a confirmed booking can be changed",
    });
  });

  it("refuses outside the free window, stating the cost exactly", () => {
    expect(canModify(CURRENT, OUTSIDE)).toEqual({
      ok: false,
      code: "outside_free_window",
      message: "Your current booking can no longer be cancelled for free, so changing it would cost ₹26,328",
    });
  });
});

describe("quoteModify", () => {
  it("states a dearer change", () => {
    const q = quote(offer(2872800));
    expect(q.message).toBe("₹2,400 more than your current booking");
    expect(q.delta).toEqual(money(240000, "INR"));
    expect(q.cancellationCost).toEqual(money(0, "INR"));
  });

  it("states a cheaper change with a positive amount and a negative delta", () => {
    const q = quote(offer(2512800));
    expect(q.message).toBe("₹1,200 less than your current booking");
    expect(q.delta).toEqual(money(-120000, "INR"));
  });

  it("states an identical total", () => {
    expect(quote(offer(2632800)).message).toBe("Same total as your current booking");
  });

  it("shows both totals and no delta across currencies", () => {
    const q = quote(offer(30000, "USD"));
    expect(q.delta).toBeNull();
    expect(q.message).toBe("$300 instead of ₹26,328 for your current booking");
  });

  it("leads with the lost stay outside the free window", () => {
    const q = quote(offer(2872800), OUTSIDE);
    expect(q.cancellationCost).toEqual(money(2632800, "INR"));
    expect(q.message).toBe("Your current booking can no longer be cancelled for free, so changing it would cost ₹26,328");
  });

  it("carries the identifiers and the new verdict", () => {
    const q = quote(offer(2872800));
    expect([q.bookingId, q.searchId, q.newOfferId]).toEqual(["bkg_1", "srch_2", "off_new"]);
    expect(q.verdict).toBe(SLICE1_IN_VERDICT);
    expect(q.currentTotal).toEqual(money(2632800, "INR"));
    expect(q.newTotal).toEqual(money(2872800, "INR"));
  });
});
