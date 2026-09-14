import type { Booking, BookingState, Property } from "../../src/core/types.ts";
import { summariseByCountry, travellersInMarket } from "../../src/core/duty.ts";
import { booking, londonProperty, policy, property, rate, traveller } from "./core-builders.ts";

function stay(id: string, travellerId: string, p: Property, checkIn: string, checkOut: string, state: BookingState): Booking {
  return booking({
    id,
    travellerId,
    state,
    confirmationCode: id.toUpperCase().slice(-6),
    offer: { property: p, rate: rate({ id: `r_${id}`, propertyId: p.id, checkIn, checkOut }) },
  });
}

const DUBAI = property({ id: "prop_dxb", name: "Gate Village Suites", city: "Dubai", countryCode: "AE", cityTier: "global" });
const BENGALURU = property({ id: "prop_blr", name: "Whitefield Commons", city: "Bengaluru", stateCode: "29" });

const POLICY = policy({
  advisories: [
    { countryCode: "AE", city: "Dubai", level: "caution", note: "Heat advisory", updatedAt: "2026-09-01T00:00:00.000Z" },
  ],
});

const TRAVELLERS = [
  traveller({ id: "trv_asha", name: "Asha Rao" }),
  traveller({ id: "trv_dev", name: "Dev Patel", email: "dev@acme.test" }),
  traveller({ id: "trv_zoya", name: "Zoya Khan", email: "zoya@acme.test" }),
];

const BOOKINGS = [
  stay("bkg_mum_asha", "trv_asha", property(), "2026-09-14", "2026-09-16", "confirmed"),
  stay("bkg_dxb_dev", "trv_dev", DUBAI, "2026-09-15", "2026-09-17", "pending_approval"),
  stay("bkg_cancelled", "trv_zoya", property(), "2026-09-14", "2026-09-16", "cancelled"),
  stay("bkg_lon_leaving", "trv_zoya", londonProperty(), "2026-09-13", "2026-09-15", "confirmed"),
  stay("bkg_blr_zoya", "trv_zoya", BENGALURU, "2026-09-15", "2026-09-16", "confirmed"),
  stay("bkg_mum_ghost", "trv_missing", property(), "2026-09-10", "2026-09-20", "confirmed"),
  stay("bkg_rejected", "trv_asha", DUBAI, "2026-09-15", "2026-09-16", "rejected"),
];

describe("travellersInMarket", () => {
  const rows = travellersInMarket({ date: "2026-09-15", bookings: BOOKINGS, travellers: TRAVELLERS, policy: POLICY });

  it("includes confirmed and pending stays whose nights cover the date", () => {
    expect(rows.map((r) => r.bookingId)).toEqual(["bkg_dxb_dev", "bkg_blr_zoya", "bkg_mum_asha", "bkg_mum_ghost"]);
  });

  it("counts the check-in day and excludes the checkout day", () => {
    const ids = rows.map((r) => r.bookingId);
    expect(ids).toContain("bkg_blr_zoya"); // checks in on the date
    expect(ids).not.toContain("bkg_lon_leaving"); // checks out on the date
  });

  it("leaves out cancelled and rejected bookings", () => {
    const ids = rows.map((r) => r.bookingId);
    expect(ids).not.toContain("bkg_cancelled");
    expect(ids).not.toContain("bkg_rejected");
  });

  it("sorts by country, then city, then name", () => {
    expect(rows.map((r) => `${r.countryCode}/${r.city}/${r.name}`)).toEqual([
      "AE/Dubai/Dev Patel",
      "IN/Bengaluru/Zoya Khan",
      "IN/Mumbai/Asha Rao",
      "IN/Mumbai/Unknown traveller",
    ]);
  });

  it("keeps a stay whose traveller record is missing, rather than losing a person", () => {
    const ghost = rows.find((r) => r.bookingId === "bkg_mum_ghost");
    expect(ghost?.name).toBe("Unknown traveller");
    expect(ghost?.email).toBe("");
  });

  it("carries the property contact facts and the advisory", () => {
    const dubai = rows[0];
    expect(dubai).toMatchObject({
      travellerId: "trv_dev",
      email: "dev@acme.test",
      state: "pending_approval",
      propertyName: "Gate Village Suites",
      propertyPhone: DUBAI.phone,
      addressLine: DUBAI.addressLine,
      checkIn: "2026-09-15",
      checkOut: "2026-09-17",
    });
    expect(dubai?.advisory?.level).toBe("caution");
    expect(rows[1]?.advisory).toBeNull();
  });

  it("rejects a malformed date", () => {
    expect(() => travellersInMarket({ date: "15/09/2026", bookings: [], travellers: [], policy: POLICY })).toThrow(
      RangeError,
    );
  });
});

describe("summariseByCountry", () => {
  it("counts travellers and advisories per country", () => {
    const rows = travellersInMarket({ date: "2026-09-15", bookings: BOOKINGS, travellers: TRAVELLERS, policy: POLICY });
    expect(summariseByCountry(rows)).toEqual([
      { countryCode: "AE", count: 1, advisories: 1 },
      { countryCode: "IN", count: 3, advisories: 0 },
    ]);
  });

  it("is empty for an empty market", () => {
    expect(summariseByCountry([])).toEqual([]);
  });
});
