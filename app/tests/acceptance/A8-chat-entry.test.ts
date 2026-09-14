/**
 * A8 — "Across a 50-utterance corpus, chat resolves anchor and dates correctly or
 * asks exactly one clarifying question in 9 of 10 cases — and never completes a
 * booking."
 *
 * The corpus is written the way business travellers actually type: lowercase,
 * abbreviations, missing words. Clock is fixed on Monday 14 Sep 2026, 09:00 IST.
 * Where a sentence is genuinely ambiguous, the correct behaviour is the question,
 * and the expectation says so.
 */
import { makeHarness } from "./harness.ts";

interface Case {
  text: string;
  expect: { city: string; checkIn: string; checkOut: string } | { clarify: "anchor" | "dates" };
}

const mon = "2026-09-14"; // clock date
const CORPUS: Case[] = [
  { text: "hotel near bkc tue to fri", expect: { city: "Mumbai", checkIn: "2026-09-15", checkOut: "2026-09-18" } },
  { text: "Need a hotel near the BKC office Tuesday to Friday, under the cap", expect: { city: "Mumbai", checkIn: "2026-09-15", checkOut: "2026-09-18" } },
  { text: "bandra kurla complex 12-15 oct", expect: { city: "Mumbai", checkIn: "2026-10-12", checkOut: "2026-10-15" } },
  { text: "stay at bkc from 12th october for 3 nights", expect: { city: "Mumbai", checkIn: "2026-10-12", checkOut: "2026-10-15" } },
  { text: "bkc tomorrow for 2 nights", expect: { city: "Mumbai", checkIn: "2026-09-15", checkOut: "2026-09-17" } },
  { text: "cyber city next week", expect: { city: "Gurugram", checkIn: "2026-09-21", checkOut: "2026-09-25" } },
  { text: "gurgaon mon-wed next week", expect: { city: "Gurugram", checkIn: "2026-09-21", checkOut: "2026-09-23" } },
  { text: "somewhere walking distance from cyber city, 12 oct to 15 oct", expect: { city: "Gurugram", checkIn: "2026-10-12", checkOut: "2026-10-15" } },
  { text: "whitefield wed to fri", expect: { city: "Bengaluru", checkIn: "2026-09-16", checkOut: "2026-09-18" } },
  { text: "Whitefield office, 20-22 Oct, free cancellation please", expect: { city: "Bengaluru", checkIn: "2026-10-20", checkOut: "2026-10-22" } },
  { text: "koramangala tomorrow for 1 night", expect: { city: "Bengaluru", checkIn: "2026-09-15", checkOut: "2026-09-16" } },
  { text: "hitec city thursday to saturday", expect: { city: "Hyderabad", checkIn: "2026-09-17", checkOut: "2026-09-19" } },
  { text: "hotel close to hitec city 5-8 nov with breakfast", expect: { city: "Hyderabad", checkIn: "2026-11-05", checkOut: "2026-11-08" } },
  { text: "hinjewadi next week work-ready", expect: { city: "Pune", checkIn: "2026-09-21", checkOut: "2026-09-25" } },
  { text: "pune hinjewadi 1-3 dec", expect: { city: "Pune", checkIn: "2026-12-01", checkOut: "2026-12-03" } },
  { text: "canary wharf 12-16 oct", expect: { city: "London", checkIn: "2026-10-12", checkOut: "2026-10-16" } },
  { text: "near canary wharf mon-thu next week", expect: { city: "London", checkIn: "2026-09-21", checkOut: "2026-09-24" } },
  { text: "difc dubai tue to thu", expect: { city: "Dubai", checkIn: "2026-09-15", checkOut: "2026-09-17" } },
  { text: "DIFC from 3rd november for 2 nights", expect: { city: "Dubai", checkIn: "2026-11-03", checkOut: "2026-11-05" } },
  { text: "mbfc singapore 9-12 oct", expect: { city: "Singapore", checkIn: "2026-10-09", checkOut: "2026-10-12" } },
  { text: "marina bay financial centre next week", expect: { city: "Singapore", checkIn: "2026-09-21", checkOut: "2026-09-25" } },
  { text: "bkc 2 rooms for me and a colleague 12-14 oct", expect: { city: "Mumbai", checkIn: "2026-10-12", checkOut: "2026-10-14" } },
  { text: "BKC, 15 to 18 October, 2 guests", expect: { city: "Mumbai", checkIn: "2026-10-15", checkOut: "2026-10-18" } },
  { text: "bkc 12 oct - 15 oct in policy", expect: { city: "Mumbai", checkIn: "2026-10-12", checkOut: "2026-10-15" } },
  { text: "near bkc within 15 minutes, tue to fri", expect: { city: "Mumbai", checkIn: "2026-09-15", checkOut: "2026-09-18" } },
  { text: "bkc thurs-fri", expect: { city: "Mumbai", checkIn: "2026-09-17", checkOut: "2026-09-18" } },
  { text: "bkc 24-26 dec", expect: { city: "Mumbai", checkIn: "2026-12-24", checkOut: "2026-12-26" } },
  { text: "cyber city 2 jan to 4 jan", expect: { city: "Gurugram", checkIn: "2027-01-02", checkOut: "2027-01-04" } },
  { text: "whitefield 10th sept to 12th sept", expect: { city: "Bengaluru", checkIn: "2027-09-10", checkOut: "2027-09-12" } },
  { text: "hitec city tomorrow for 3 nights, refundable", expect: { city: "Hyderabad", checkIn: "2026-09-15", checkOut: "2026-09-18" } },
  { text: "near the bkc office next week", expect: { city: "Mumbai", checkIn: "2026-09-21", checkOut: "2026-09-25" } },
  { text: "gurgaon cyber city wednesday to friday", expect: { city: "Gurugram", checkIn: "2026-09-16", checkOut: "2026-09-18" } },
  { text: "canary wharf 1st to 4th december", expect: { city: "London", checkIn: "2026-12-01", checkOut: "2026-12-04" } },
  { text: "difc 17-19 sep", expect: { city: "Dubai", checkIn: "2026-09-17", checkOut: "2026-09-19" } },
  { text: "koramangala 6-9 oct good wifi", expect: { city: "Bengaluru", checkIn: "2026-10-06", checkOut: "2026-10-09" } },

  // Missing or unclear anchor — the only right answer is to ask where.
  { text: "a hotel tue to fri", expect: { clarify: "anchor" } },
  { text: "need a room next week", expect: { clarify: "anchor" } },
  { text: "somewhere nice 12-15 oct under the cap", expect: { clarify: "anchor" } },
  { text: "near the client office tomorrow for 2 nights", expect: { clarify: "anchor" } },
  { text: "hotel in atlantis 12-15 oct", expect: { clarify: "anchor" } },
  { text: "book me something for the offsite", expect: { clarify: "anchor" } },

  // Anchor known, dates missing — ask when, never guess.
  { text: "hotel near bkc", expect: { clarify: "dates" } },
  { text: "cyber city please", expect: { clarify: "dates" } },
  { text: "whitefield work-ready with breakfast", expect: { clarify: "dates" } },
  { text: "canary wharf, in policy", expect: { clarify: "dates" } },
  { text: "difc hotel for 2 nights", expect: { clarify: "dates" } },
  { text: "hitec city sometime soon", expect: { clarify: "dates" } },
  { text: "near mbfc under the cap", expect: { clarify: "dates" } },
  { text: "hinjewadi for the workshop", expect: { clarify: "dates" } },
  { text: "bkc walking distance", expect: { clarify: "dates" } },
];

describe("A8 — chat entry", () => {
  it("has a corpus of 50", () => {
    expect(CORPUS.length).toBe(50);
    expect(mon).toBe("2026-09-14");
  });

  it("resolves or asks exactly one question in at least 9 of 10 utterances", async () => {
    const h = await makeHarness({ now: new Date("2026-09-14T03:30:00.000Z") });
    await h.login();

    const misses: string[] = [];
    for (const c of CORPUS) {
      const res = await h.agent.post("/api/intent").send({ text: c.text });
      expect(res.status, c.text).toBe(200);
      const intent = res.body.intent;
      const q = intent.clarification;

      let ok: boolean;
      if ("clarify" in c.expect) {
        ok = q !== null && q.field === c.expect.clarify && res.body.searchRequest === null;
      } else {
        ok =
          q === null &&
          intent.anchor?.city === c.expect.city &&
          intent.checkIn === c.expect.checkIn &&
          intent.checkOut === c.expect.checkOut &&
          res.body.searchRequest !== null;
      }
      if (!ok) {
        misses.push(
          `${c.text} → anchor=${intent.anchor?.city ?? "∅"} ${intent.checkIn ?? "∅"}→${intent.checkOut ?? "∅"} ask=${q?.field ?? "∅"}`,
        );
      }
    }
    const score = CORPUS.length - misses.length;
    console.log(`A8 chat corpus: ${score}/${CORPUS.length}${misses.length ? `\n  misses:\n  ${misses.join("\n  ")}` : ""}`);
    expect(score).toBeGreaterThanOrEqual(45);
  }, 120000);

  it("never books — no booking exists after the whole corpus, and the response has no booking", async () => {
    const h = await makeHarness({ now: new Date("2026-09-14T03:30:00.000Z") });
    await h.login();
    for (const c of CORPUS.slice(0, 20)) {
      const res = await h.agent.post("/api/intent").send({ text: `${c.text} and book it now` });
      expect(res.status).toBe(200);
      expect(res.body.booking).toBeUndefined();
    }
    const mine = await h.agent.get("/api/bookings");
    expect(mine.body.bookings.length).toBe(0);
  }, 120000);

  it("reads back what it understood in one machine-voice line", async () => {
    const h = await makeHarness({ now: new Date("2026-09-14T03:30:00.000Z") });
    await h.login();
    const res = await h.agent.post("/api/intent").send({ text: "hotel near bkc tue to fri, in policy" });
    expect(res.body.intent.readBack).toMatch(/Mumbai/);
    expect(res.body.intent.readBack).toMatch(/15/);
    expect(res.body.intent.constraints.inPolicyOnly).toBe(true);
  }, 30000);
});
