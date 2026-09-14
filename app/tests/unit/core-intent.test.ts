import { readFileSync } from "node:fs";

import type { Anchor } from "../../src/core/types.ts";
import type { IntentContext } from "../../src/intent/IntentParser.ts";
import { parseIntent } from "../../src/core/intent.ts";

// ---------- a small fake resolver, as /api/search would use ----------

function anchor(label: string, city: string, countryCode: string): Anchor {
  return { label, city, countryCode, geo: { lat: 0, lng: 0 } };
}

const BKC = anchor("BKC", "Mumbai", "IN");
const CYBER_CITY = anchor("Cyber City", "Gurugram", "IN");
const WHITEFIELD = anchor("Whitefield", "Bengaluru", "IN");
const HITEC_CITY = anchor("HITEC City", "Hyderabad", "IN");
const CANARY_WHARF = anchor("Canary Wharf", "London", "GB");
const DIFC = anchor("DIFC", "Dubai", "AE");
const MBFC = anchor("MBFC", "Singapore", "SG");
const ANCHORS = [BKC, CYBER_CITY, WHITEFIELD, HITEC_CITY, CANARY_WHARF, DIFC, MBFC];

const ALIASES: Readonly<Record<string, Anchor>> = {
  bkc: BKC,
  "bandra kurla complex": BKC,
  "cyber city": CYBER_CITY,
  whitefield: WHITEFIELD,
  "hitec city": HITEC_CITY,
  "canary wharf": CANARY_WHARF,
  difc: DIFC,
  mbfc: MBFC,
};

const resolveAnchor = (query: string): Anchor | null =>
  ALIASES[query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()] ?? null;

/** Monday 14 Sep 2026, 9 am in Mumbai. Tomorrow is Tue 15; next week starts Mon 21. */
const ctx: IntentContext = {
  now: new Date("2026-09-14T09:00:00+05:30"),
  timeZone: "Asia/Kolkata",
  anchors: ANCHORS,
  resolveAnchor,
};

// ---------- the corpus ----------

type Expectation =
  | { resolve: [label: string, checkIn: string, checkOut: string] }
  | { ask: "anchor" | "dates" };

interface Case {
  readonly text: string;
  readonly expect: Expectation;
}

const CORPUS: readonly Case[] = [
  { text: "hotel near BKC tuesday to friday", expect: { resolve: ["BKC", "2026-09-15", "2026-09-18"] } },
  {
    text: "hotel near the Bandra Kurla Complex office Tuesday–Friday, under the cap",
    expect: { resolve: ["BKC", "2026-09-15", "2026-09-18"] },
  },
  { text: "need a room close to cyber city 12-15 oct", expect: { resolve: ["Cyber City", "2026-10-12", "2026-10-15"] } },
  { text: "whitefield 12 oct to 15 oct", expect: { resolve: ["Whitefield", "2026-10-12", "2026-10-15"] } },
  {
    text: "near hitec city from 12th October for 3 nights",
    expect: { resolve: ["HITEC City", "2026-10-12", "2026-10-15"] },
  },
  { text: "bkc tomorrow for 2 nights", expect: { resolve: ["BKC", "2026-09-15", "2026-09-17"] } },
  { text: "canary wharf next week", expect: { resolve: ["Canary Wharf", "2026-09-21", "2026-09-25"] } },
  { text: "difc mon-wed next week", expect: { resolve: ["DIFC", "2026-09-21", "2026-09-23"] } },
  { text: "hotel in mbfc 2-5 sep", expect: { resolve: ["MBFC", "2027-09-02", "2027-09-05"] } },
  {
    text: "somewhere near whitefeild thurs to sat",
    expect: { resolve: ["Whitefield", "2026-09-17", "2026-09-19"] },
  },
  { text: "tuesdy to thrusday near bkc", expect: { resolve: ["BKC", "2026-09-15", "2026-09-17"] } },
  {
    text: "me and a colleague near cyber city tomorrow for 1 night",
    expect: { resolve: ["Cyber City", "2026-09-15", "2026-09-16"] },
  },
  { text: "2 rooms near difc 20-23 oct", expect: { resolve: ["DIFC", "2026-10-20", "2026-10-23"] } },
  {
    text: "for 3 people near canary wharf 5 nov to 8 nov",
    expect: { resolve: ["Canary Wharf", "2026-11-05", "2026-11-08"] },
  },
  {
    text: "work-ready hotel near whitefield with good wifi and breakfast, 12-14 oct",
    expect: { resolve: ["Whitefield", "2026-10-12", "2026-10-14"] },
  },
  {
    text: "free cancellation near hitec city next week",
    expect: { resolve: ["HITEC City", "2026-09-21", "2026-09-25"] },
  },
  { text: "walking distance from bkc tue-thu", expect: { resolve: ["BKC", "2026-09-15", "2026-09-17"] } },
  {
    text: "within 15 minutes of cyber city tomorrow",
    expect: { resolve: ["Cyber City", "2026-09-15", "2026-09-16"] },
  },
  { text: "BKC TUE-FRI IN POLICY", expect: { resolve: ["BKC", "2026-09-15", "2026-09-18"] } },
  { text: "hotel near bkc 30 sep to 2 oct", expect: { resolve: ["BKC", "2026-09-30", "2026-10-02"] } },
  { text: "canary wharf dec 30 to jan 2", expect: { resolve: ["Canary Wharf", "2026-12-30", "2027-01-02"] } },
  { text: "near difc oct 12-15", expect: { resolve: ["DIFC", "2026-10-12", "2026-10-15"] } },
  {
    text: "hotel close to mbfc from 19 oct for 4 nights refundable",
    expect: { resolve: ["MBFC", "2026-10-19", "2026-10-23"] },
  },
  { text: "bkc tonight", expect: { resolve: ["BKC", "2026-09-14", "2026-09-15"] } },
  { text: "cyber city, 3 nights from monday", expect: { resolve: ["Cyber City", "2026-09-21", "2026-09-24"] } },
  {
    text: "whitefield next monday to thursday",
    expect: { resolve: ["Whitefield", "2026-09-21", "2026-09-24"] },
  },
  { text: "hitec city office wednesday night", expect: { resolve: ["HITEC City", "2026-09-16", "2026-09-17"] } },
  { text: "hotel near bkc this week wed to fri", expect: { resolve: ["BKC", "2026-09-16", "2026-09-18"] } },
  { text: "near canary wharf 12/10 to 15/10", expect: { resolve: ["Canary Wharf", "2026-10-12", "2026-10-15"] } },
  { text: "difc 2026-10-12 to 2026-10-15", expect: { resolve: ["DIFC", "2026-10-12", "2026-10-15"] } },
  {
    text: "just me, near whitefield, 12th to 15th october, under budget",
    expect: { resolve: ["Whitefield", "2026-10-12", "2026-10-15"] },
  },
  { text: "hotel nr bkc tmrw 2 nites", expect: { resolve: ["BKC", "2026-09-15", "2026-09-17"] } },
  { text: "mbfc tue - fri for me and 2 colleagues", expect: { resolve: ["MBFC", "2026-09-15", "2026-09-18"] } },
  {
    text: "canary wharf from the 5th to the 8th of november",
    expect: { resolve: ["Canary Wharf", "2026-11-05", "2026-11-08"] },
  },
  { text: "near DIFC 13-15 sep", expect: { resolve: ["DIFC", "2027-09-13", "2027-09-15"] } },
  { text: "hotel near bkc from 14 sep for 1 night", expect: { resolve: ["BKC", "2026-09-14", "2026-09-15"] } },
  { text: "near bkc friday to monday", expect: { resolve: ["BKC", "2026-09-18", "2026-09-21"] } },
  {
    text: "hotel near bkc 12-15 oct for 2 people with 2 rooms",
    expect: { resolve: ["BKC", "2026-10-12", "2026-10-15"] },
  },
  {
    text: "hotel by cyber city for one night tomorrow",
    expect: { resolve: ["Cyber City", "2026-09-15", "2026-09-16"] },
  },
  {
    text: "near the bandra kurla complex office next week in policy flexible",
    expect: { resolve: ["BKC", "2026-09-21", "2026-09-25"] },
  },
  { text: "hotle near bkc wednesay to firday", expect: { resolve: ["BKC", "2026-09-16", "2026-09-18"] } },
  { text: "place near difc 1-3 october", expect: { resolve: ["DIFC", "2026-10-01", "2026-10-03"] } },
  {
    text: "somewhere walkable to mbfc next week with breakfast",
    expect: { resolve: ["MBFC", "2026-09-21", "2026-09-25"] },
  },
  { text: "canary wharf 3 nights from 12 oct", expect: { resolve: ["Canary Wharf", "2026-10-12", "2026-10-15"] } },
  {
    text: "stay near hitec city, 2 guests, oct 5 to oct 9",
    expect: { resolve: ["HITEC City", "2026-10-05", "2026-10-09"] },
  },
  { text: "cyber city on thursday for 2 nights", expect: { resolve: ["Cyber City", "2026-09-17", "2026-09-19"] } },
  { text: "DIFC from sunday to wednesday", expect: { resolve: ["DIFC", "2026-09-20", "2026-09-23"] } },
  { text: "Hotel near BKC Tue–Fri", expect: { resolve: ["BKC", "2026-09-15", "2026-09-18"] } },

  { text: "hotel near bkc", expect: { ask: "dates" } },
  { text: "hotel for tuesday to friday", expect: { ask: "anchor" } },
  { text: "near andheri station tue to fri", expect: { ask: "anchor" } },
  { text: "book me something", expect: { ask: "anchor" } },
  { text: "bkc 12 oct", expect: { ask: "dates" } },
  { text: "near bkc for 2 nights", expect: { ask: "dates" } },
  { text: "near bkc sometime next month", expect: { ask: "dates" } },
  { text: "near the hitec city office thursday", expect: { ask: "dates" } },
  { text: "hotel near xyz tech park next week", expect: { ask: "anchor" } },
  { text: "i need a hotel", expect: { ask: "anchor" } },
  { text: "hotel near bkc this weekend", expect: { ask: "dates" } },
  { text: "hotel in pune 12-15 oct", expect: { ask: "anchor" } },
];

/** A8's definition of success for one utterance. */
function succeeds(c: Case): boolean {
  const intent = parseIntent(c.text, ctx);
  if ("resolve" in c.expect) {
    const [label, checkIn, checkOut] = c.expect.resolve;
    return (
      intent.anchor?.label === label &&
      intent.checkIn === checkIn &&
      intent.checkOut === checkOut &&
      intent.clarification === null
    );
  }
  return intent.clarification?.field === c.expect.ask;
}

describe("parseIntent — the A8 corpus", () => {
  it("has at least 40 utterances", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CORPUS)("$text", (c) => {
    const intent = parseIntent(c.text, ctx);
    if ("resolve" in c.expect) {
      const [label, checkIn, checkOut] = c.expect.resolve;
      expect({ anchor: intent.anchor?.label, checkIn: intent.checkIn, checkOut: intent.checkOut }).toEqual({
        anchor: label,
        checkIn,
        checkOut,
      });
      expect(intent.clarification).toBeNull();
    } else {
      expect(intent.clarification?.field).toBe(c.expect.ask);
    }
  });

  it("meets A8: 9 in 10 resolve correctly or ask exactly one question", () => {
    const passed = CORPUS.filter(succeeds).length;
    expect(passed / CORPUS.length).toBeGreaterThanOrEqual(0.9);
  });

  it("never guesses a date silently: whenever it asks about dates, the stay is incomplete", () => {
    for (const c of CORPUS) {
      const intent = parseIntent(c.text, ctx);
      if (intent.confidence.dates < 0.6) expect(intent.checkOut).toBeNull();
      if (intent.clarification === null) {
        expect(intent.checkIn).not.toBeNull();
        expect(intent.checkOut).not.toBeNull();
        expect(intent.confidence.dates).toBeGreaterThanOrEqual(0.6);
        expect(intent.confidence.anchor).toBeGreaterThanOrEqual(0.6);
      }
    }
  });

  it("asks at most one question, anchor before dates", () => {
    const both = parseIntent("book me something", ctx);
    expect(both.confidence.anchor).toBe(0);
    expect(both.confidence.dates).toBe(0);
    expect(both.clarification?.field).toBe("anchor");
  });
});

describe("parseIntent — confidence", () => {
  it("is 1.0 for an explicit date range and a resolved anchor", () => {
    expect(parseIntent("bkc 12-15 oct", ctx).confidence).toEqual({ anchor: 1, dates: 1 });
  });

  it("is 0.7 for a weekday range without a week, and still does not ask", () => {
    const intent = parseIntent("bkc tue to fri", ctx);
    expect(intent.confidence.dates).toBe(0.7);
    expect(intent.clarification).toBeNull();
  });

  it("is 0.7 for a fuzzy anchor match, shown corrected in the read-back", () => {
    const intent = parseIntent("whitefeild 12-15 oct", ctx);
    expect(intent.confidence.anchor).toBe(0.7);
    expect(intent.readBack.startsWith("Whitefield, Bengaluru")).toBe(true);
  });

  it("is 0 when nothing is said", () => {
    expect(parseIntent("", ctx).confidence).toEqual({ anchor: 0, dates: 0 });
  });

  it("fills a check-in but never a checkout from a bare start date", () => {
    const intent = parseIntent("bkc 12 oct", ctx);
    expect(intent.checkIn).toBe("2026-10-12");
    expect(intent.checkOut).toBeNull();
    expect(intent.readBack).toBe("BKC, Mumbai · from Mon 12 Oct · 1 guest");
  });
});

describe("parseIntent — clarification", () => {
  it("asks where the meeting is, offering up to four anchors", () => {
    expect(parseIntent("hotel for tue to fri", ctx).clarification).toEqual({
      field: "anchor",
      question: "Where is your meeting?",
      options: ["BKC", "Cyber City", "Whitefield", "HITEC City"],
    });
  });

  it("quotes an unknown place back, and prefers anchors in a city it mentions", () => {
    const intent = parseIntent("near powai mumbai tue to fri", ctx);
    expect(intent.anchorQuery).toBe("powai mumbai");
    expect(intent.anchor).toBeNull();
    expect(intent.clarification?.question).toBe('I couldn\'t place "powai mumbai" — where is your meeting?');
    expect(intent.clarification?.options[0]).toBe("BKC");
    expect(intent.clarification?.options.length).toBeLessThanOrEqual(4);
  });

  it("asks about dates with the three fixed options", () => {
    expect(parseIntent("hotel near bkc", ctx).clarification).toEqual({
      field: "dates",
      question: "Which dates do you need the hotel for?",
      options: ["Tomorrow · 1 night", "Mon–Wed next week", "Mon–Fri next week"],
    });
  });
});

describe("parseIntent — guests, rooms and constraints", () => {
  it("counts me and a colleague as two", () => {
    expect(parseIntent("me and a colleague near bkc tue to fri", ctx).guests).toBe(2);
  });

  it("counts me and two colleagues as three", () => {
    expect(parseIntent("mbfc tue - fri for me and 2 colleagues", ctx).guests).toBe(3);
  });

  it("reads explicit people and rooms, and never gives a room no guest", () => {
    const people = parseIntent("hotel near bkc 12-15 oct for 2 people with 2 rooms", ctx);
    expect([people.guests, people.rooms]).toEqual([2, 2]);
    const rooms = parseIntent("2 rooms near difc 20-23 oct", ctx);
    expect([rooms.guests, rooms.rooms]).toEqual([2, 2]);
  });

  it("defaults to one guest and one room", () => {
    const intent = parseIntent("bkc tue to fri", ctx);
    expect([intent.guests, intent.rooms]).toEqual([1, 1]);
  });

  it("reads every constraint", () => {
    const intent = parseIntent(
      "work-ready hotel near bkc in policy with breakfast, free cancellation, within 15 min, tue to fri",
      ctx,
    );
    expect(intent.constraints).toEqual({
      inPolicyOnly: true,
      workReady: true,
      freeCancellation: true,
      breakfast: true,
      maxCommuteMinutes: 15,
    });
  });

  it("reads walking distance as 12 minutes, and keeps the tighter of two limits", () => {
    expect(parseIntent("walking distance from bkc tue to fri", ctx).constraints.maxCommuteMinutes).toBe(12);
    expect(
      parseIntent("walkable, within 20 minutes of bkc tue to fri", ctx).constraints.maxCommuteMinutes,
    ).toBe(12);
  });

  it("does not read negations as wishes", () => {
    const intent = parseIntent("non-refundable is fine, no breakfast, near bkc tue to fri", ctx);
    expect(intent.constraints.freeCancellation).toBe(false);
    expect(intent.constraints.breakfast).toBe(false);
  });
});

describe("parseIntent — read-back", () => {
  it("renders the documented read-back", () => {
    expect(parseIntent("hotel near the Bandra Kurla Complex office Tuesday–Friday, under the cap", ctx).readBack).toBe(
      "BKC, Mumbai · Tue 15 – Fri 18 Sep · 1 guest · in policy",
    );
  });

  it("names both months across a month boundary", () => {
    expect(parseIntent("hotel near bkc 30 sep to 2 oct", ctx).readBack).toBe("BKC, Mumbai · Wed 30 Sep – Fri 2 Oct · 1 guest");
  });

  it("names both years across a year boundary", () => {
    expect(parseIntent("canary wharf dec 30 to jan 2", ctx).readBack).toBe(
      "Canary Wharf, London · Wed 30 Dec 2026 – Sat 2 Jan 2027 · 1 guest",
    );
  });

  it("shows the year when a passed date rolled into next year, so the roll is never silent", () => {
    expect(parseIntent("hotel in mbfc 2-5 sep", ctx).readBack).toBe("MBFC, Singapore · Thu 2 – Sun 5 Sep 2027 · 1 guest");
  });

  it("lists guests, rooms and every constraint in a fixed order", () => {
    expect(
      parseIntent("2 rooms for 3 people near difc 20-23 oct, work-ready, refundable, breakfast, walkable, in policy", ctx)
        .readBack,
    ).toBe("DIFC, Dubai · Tue 20 – Fri 23 Oct · 3 guests · 2 rooms · in policy · work-ready · free cancellation · breakfast · within 12 min");
  });

  it("omits what it does not know", () => {
    expect(parseIntent("book me something", ctx).readBack).toBe("1 guest");
  });
});

describe("parseIntent — determinism and boundaries", () => {
  it("is deterministic", () => {
    const text = "me and a colleague near cyber city tomorrow for 1 night";
    expect(parseIntent(text, ctx)).toEqual(parseIntent(text, ctx));
  });

  it("preserves the original text and names its parser", () => {
    const intent = parseIntent("Hotel near BKC Tue–Fri", ctx);
    expect(intent.text).toBe("Hotel near BKC Tue–Fri");
    expect(intent.parser).toBe("rules");
  });

  it("reads 'tomorrow' in the traveller's time zone, not the server's", () => {
    // 01:30 on Tue 15 Sep in Kolkata is still Mon 14 Sep in UTC.
    const lateNight = new Date("2026-09-14T20:00:00.000Z");
    expect(parseIntent("bkc tomorrow for 1 night", { ...ctx, now: lateNight }).checkIn).toBe("2026-09-16");
    expect(parseIntent("bkc tomorrow for 1 night", { ...ctx, now: lateNight, timeZone: "UTC" }).checkIn).toBe(
      "2026-09-15",
    );
  });

  it("reads a slashed date month-first only in the Americas", () => {
    expect(parseIntent("bkc 12/10 to 15/10", ctx).checkIn).toBe("2026-10-12");
    expect(parseIntent("bkc 10/12 to 10/15", { ...ctx, timeZone: "America/New_York" }).checkIn).toBe("2026-10-12");
  });

  it("rejects an impossible date rather than inventing one", () => {
    expect(parseIntent("bkc 30-31 feb", ctx).checkIn).toBeNull();
  });

  it("has no path to booking — the module imports nothing but types", () => {
    const source = readFileSync(new URL("../../src/core/intent.ts", import.meta.url), "utf8");
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports.every((line) => line.startsWith("import type"))).toBe(true);
    expect(source).not.toMatch(/payments|supply|store|server/);
  });
});
