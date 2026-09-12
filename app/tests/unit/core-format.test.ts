import { formatDateRange, formatDeadline, formatDuration } from "../../src/core/format.ts";

const EN_DASH = "–";

describe("formatDateRange", () => {
  it("collapses a same-month range to one month name", () => {
    expect(formatDateRange("2026-06-11", "2026-06-15")).toBe(`11${EN_DASH}15 Jun`);
  });

  it("uses an en dash, not a hyphen", () => {
    expect(formatDateRange("2026-06-11", "2026-06-15")).toBe("11–15 Jun");
    expect(formatDateRange("2026-06-11", "2026-06-15")).not.toContain("-");
  });

  it("does not pad single-digit days", () => {
    expect(formatDateRange("2026-06-01", "2026-06-09")).toBe(`1${EN_DASH}9 Jun`);
  });

  it("names both months when the stay crosses one", () => {
    expect(formatDateRange("2026-06-29", "2026-07-02")).toBe(`29 Jun${EN_DASH}2 Jul`);
  });

  it("adds years only when the stay crosses one", () => {
    expect(formatDateRange("2026-12-30", "2027-01-02")).toBe(`30 Dec 2026${EN_DASH}2 Jan 2027`);
  });

  it("handles a same-day range", () => {
    expect(formatDateRange("2026-06-11", "2026-06-11")).toBe(`11${EN_DASH}11 Jun`);
  });

  it("renders every month with the English short name, whatever the host locale", () => {
    expect(formatDateRange("2026-01-01", "2026-02-01")).toBe(`1 Jan${EN_DASH}1 Feb`);
    expect(formatDateRange("2026-11-01", "2026-12-01")).toBe(`1 Nov${EN_DASH}1 Dec`);
  });

  it("rejects a malformed date", () => {
    expect(() => formatDateRange("11 Jun 2026", "2026-06-15")).toThrow(RangeError);
  });
});

describe("formatDeadline", () => {
  // 13 June 2026 is a Saturday; 12:30 UTC is 18:00 IST.
  const sixPmIst = "2026-06-13T12:30:00.000Z";

  it("renders the documented shape in the traveller's default zone (IST)", () => {
    expect(formatDeadline(sixPmIst)).toBe("6:00 pm, Sat 13 Jun");
  });

  it("honours an explicit time zone", () => {
    expect(formatDeadline(sixPmIst, "UTC")).toBe("12:30 pm, Sat 13 Jun");
    expect(formatDeadline(sixPmIst, "America/New_York")).toBe("8:30 am, Sat 13 Jun");
  });

  it("shifts the calendar day when the zone does", () => {
    // 18:30 UTC is midnight in Kolkata, the next day.
    expect(formatDeadline("2026-06-13T18:30:00.000Z")).toBe("12:00 am, Sun 14 Jun");
  });

  it("writes midnight and noon as 12, never 0", () => {
    expect(formatDeadline("2026-06-13T00:00:00.000Z", "UTC")).toBe("12:00 am, Sat 13 Jun");
    expect(formatDeadline("2026-06-13T12:00:00.000Z", "UTC")).toBe("12:00 pm, Sat 13 Jun");
  });

  it("pads the minutes", () => {
    expect(formatDeadline("2026-06-13T18:05:00.000Z", "UTC")).toBe("6:05 pm, Sat 13 Jun");
  });

  it("is am before noon and pm from noon", () => {
    expect(formatDeadline("2026-06-13T11:59:00.000Z", "UTC")).toBe("11:59 am, Sat 13 Jun");
    expect(formatDeadline("2026-06-13T12:01:00.000Z", "UTC")).toBe("12:01 pm, Sat 13 Jun");
  });

  it("names the weekday correctly across a week", () => {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let i = 0; i < 7; i++) {
      const day = String(14 + i).padStart(2, "0");
      expect(formatDeadline(`2026-06-${day}T09:00:00.000Z`, "UTC")).toBe(
        `9:00 am, ${days[i]} ${14 + i} Jun`,
      );
    }
  });

  it("is deterministic for the same instant and zone", () => {
    expect(formatDeadline(sixPmIst)).toBe(formatDeadline(sixPmIst));
  });

  it("rejects an unparseable instant", () => {
    expect(() => formatDeadline("tomorrow evening")).toThrow(RangeError);
  });
});

describe("formatDuration", () => {
  it("renders sub-second durations in whole milliseconds", () => {
    expect(formatDuration(840)).toBe("840ms");
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(1)).toBe("1ms");
    expect(formatDuration(120.4)).toBe("120ms");
  });

  it("renders seconds to one decimal", () => {
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(2500)).toBe("2.5s");
    expect(formatDuration(59_900)).toBe("59.9s");
  });

  it("never reports 1000ms — a rounded-up millisecond count becomes seconds", () => {
    expect(formatDuration(999.6)).toBe("1.0s");
    expect(formatDuration(999.4)).toBe("999ms");
  });

  it("splits minutes out past a minute", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(64_000)).toBe("1m 4s");
    expect(formatDuration(3_661_000)).toBe("61m 1s");
  });

  it("keeps the sign of a negative measurement instead of hiding it", () => {
    expect(formatDuration(-840)).toBe("-840ms");
    expect(formatDuration(-1200)).toBe("-1.2s");
  });

  it("rejects a non-finite measurement", () => {
    expect(() => formatDuration(Number.NaN)).toThrow(RangeError);
    expect(() => formatDuration(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("uses a dot decimal separator whatever the host locale", () => {
    expect(formatDuration(1250)).toContain(".");
    expect(formatDuration(1250)).not.toContain(",");
  });
});
