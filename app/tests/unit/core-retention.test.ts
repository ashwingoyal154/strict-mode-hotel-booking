import { RETENTION, eraseTraveller, pseudonymFor, scrubBookingForErasure, searchCutoff } from "../../src/core/retention.ts";
import { booking, traveller } from "./core-builders.ts";

describe("RETENTION", () => {
  it("states the §3.2 periods", () => {
    expect(RETENTION).toEqual({ bookingsYears: 7, locationDays: 90, searchDays: 30 });
  });
});

describe("pseudonymFor", () => {
  it("is 'erased-' plus ten hex characters, stable per id", () => {
    expect(pseudonymFor("trv_asha")).toMatch(/^erased-[0-9a-f]{10}$/);
    expect(pseudonymFor("trv_asha")).toBe(pseudonymFor("trv_asha"));
    expect(pseudonymFor("trv_asha")).not.toBe(pseudonymFor("trv_meera"));
  });
});

describe("eraseTraveller", () => {
  const now = new Date("2026-09-14T09:00:00.000Z");

  it("pseudonymises name and email and stamps erasedAt, keeping the rest", () => {
    const t = traveller({ managerId: "trv_meera" });
    const erased = eraseTraveller(t, now);
    expect(erased).toEqual({
      ...t,
      name: "Erased traveller",
      email: `${pseudonymFor("trv_asha")}@erased.invalid`,
      erasedAt: "2026-09-14T09:00:00.000Z",
    });
    expect(JSON.stringify(erased)).not.toContain("asha@acme.test");
    expect(JSON.stringify(erased)).not.toContain("Asha Rao");
  });

  it("is idempotent: erasing again keeps the original erasure time", () => {
    const once = eraseTraveller(traveller(), now);
    expect(eraseTraveller(once, new Date("2027-01-01T00:00:00.000Z"))).toBe(once);
  });
});

describe("scrubBookingForErasure", () => {
  it("removes the meeting location and keeps money, tax and property facts", () => {
    const b = booking();
    const scrubbed = scrubBookingForErasure(b);
    expect(scrubbed.anchor).toEqual({ label: "(erased)", geo: { lat: 0, lng: 0 }, city: "Mumbai", countryCode: "IN" });
    expect(scrubbed.offer).toEqual(b.offer);
    expect(scrubbed.amounts).toEqual(b.amounts);
    expect(scrubbed.verdict).toEqual(b.verdict);
    expect(scrubbed.confirmationCode).toBe(b.confirmationCode);
  });
});

describe("searchCutoff", () => {
  it("is exactly 30 days before now", () => {
    expect(searchCutoff(new Date("2026-09-14T00:00:00.000Z"))).toBe("2026-08-15T00:00:00.000Z");
  });
});
