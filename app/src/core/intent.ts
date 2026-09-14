/**
 * Chat entry, rules edition: one sentence → a structured search (§2.3, A8).
 *
 * Two promises shape this parser more than cleverness does:
 *  - It never guesses a date silently. Every date it fills in came from words in
 *    the sentence; an inferred default (a weekday range with no week, "tomorrow"
 *    with no length) is marked 0.7 and shown in the read-back, and anything
 *    thinner than that is left empty and asked about.
 *  - It asks exactly one question. Anchor first, because a search without a place
 *    is not a search; dates second.
 *
 * Mechanically it is a token pipeline with masking. The sentence is tokenised and
 * each token gets a canonical form (typos and abbreviations folded: "thrusday" →
 * "thu", "tmrw" → "tomorrow"). Extractors run in a fixed order — constraints,
 * dates, guests, rooms — and every span they consume is masked, so what remains
 * for anchor extraction is only the words nobody else claimed. Anchor extraction
 * reads the *raw* tokens, so a place name is never mangled by typo correction.
 *
 * Deterministic: `now` and `timeZone` come from the context, and Intl is used only
 * to find today's calendar date in that zone.
 */

import type { Anchor, ClarifyingQuestion, IsoDate, ParsedIntent } from "./types.ts";
import type { IntentContext } from "../intent/IntentParser.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const ALIASES: Readonly<Record<string, string>> = {
  monday: "mon", mon: "mon", mondays: "mon",
  tuesday: "tue", tue: "tue", tues: "tue", tuesdays: "tue",
  wednesday: "wed", wed: "wed", weds: "wed", wednesdays: "wed",
  thursday: "thu", thu: "thu", thur: "thu", thurs: "thu", thursdays: "thu",
  friday: "fri", fri: "fri", fridays: "fri",
  saturday: "sat", sat: "sat", saturdays: "sat",
  sunday: "sun", sun: "sun", sundays: "sun",
  january: "jan", jan: "jan",
  february: "feb", feb: "feb",
  march: "mar", mar: "mar",
  april: "apr", apr: "apr",
  may: "may",
  june: "jun", jun: "jun",
  july: "jul", jul: "jul",
  august: "aug", aug: "aug",
  september: "sep", sep: "sep", sept: "sep",
  october: "oct", oct: "oct",
  november: "nov", nov: "nov",
  december: "dec", dec: "dec",
  tomorrow: "tomorrow", tmrw: "tomorrow", tmr: "tomorrow", tmrow: "tomorrow", tomo: "tomorrow",
  tommorow: "tomorrow", tomorow: "tomorrow", tommorrow: "tomorrow", tomm: "tomorrow",
  tonite: "tonight",
  nite: "night", nites: "nights", nts: "nights",
  ppl: "people", persons: "people", person: "people", pax: "people",
  wk: "week", wks: "weeks",
  nxt: "next",
  thru: "to", through: "to", till: "to", til: "to", until: "to", untill: "to",
};

/** Long words worth typo-correcting toward, and what they fold to. */
const FUZZY_TARGETS: Readonly<Record<string, string>> = {
  monday: "mon", tuesday: "tue", wednesday: "wed", thursday: "thu", friday: "fri",
  saturday: "sat", sunday: "sun",
  january: "jan", february: "feb", march: "mar", april: "apr", june: "jun", july: "jul",
  august: "aug", september: "sep", october: "oct", november: "nov", december: "dec",
  tomorrow: "tomorrow", tonight: "tonight", nights: "nights",
  colleague: "colleague", colleagues: "colleagues",
  breakfast: "breakfast", cancellation: "cancellation", refundable: "refundable", flexible: "flexible",
};

/** Real words one edit away from a target, which must never be "corrected" into a date. */
const PROTECTED = new Set(["lights", "rights", "sights", "fights", "match", "marsh", "money", "sundae", "sundar", "fridge"]);

const WEEKDAY_INDEX: Readonly<Record<string, number>> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_INDEX: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Words that end an anchor phrase. */
const STOP = new Set([
  "near", "nr", "nearby", "around", "opposite", "beside", "besides", "at", "in", "by", "from", "of", "off",
  "for", "with", "and", "or", "but", "please", "pls", "plz", "tomorrow", "tonight", "today", "next", "this",
  "on", "under", "within", "over", "sometime", "starting", "arriving", "checking", "staying", "to", "am", "pm",
  "-", "/", "|", "close", "walking", "distance", "is", "which", "where", "that",
]);

/** Words stripped from the edges of an anchor phrase: "the bkc office" asks about "bkc". */
const FILLER = new Set([
  "the", "a", "an", "our", "my", "your", "their", "company", "office", "offices", "campus", "hq",
  "headquarters", "building", "area", "meeting", "client", "clients", "site", "location", "hotel",
  "hotels", "place", "room", "rooms", "something", "somewhere", "stay", "there", "it", "i", "me", "need",
  "want", "book", "find", "get", "looking", "look", "good", "nice", "decent", "cheap", "hotle", "hotal",
  "want", "can", "you", "we", "us", "some", "any",
]);

const STRONG_PREPS: readonly (readonly string[])[] = [
  ["close", "to"], ["next", "to"], ["near", "to"], ["near", "by"], ["right", "by"],
  ["near"], ["nr"], ["nearby"], ["around"], ["opposite"], ["beside"], ["besides"],
];
const WEAK_PREPS: readonly (readonly string[])[] = [["at"], ["in"], ["by"], ["from"], ["of"], ["off"]];
const PLACE_NOUNS = new Set(["office", "offices", "campus", "hq", "headquarters"]);

const DATE_OPTIONS: readonly string[] = ["Tomorrow · 1 night", "Mon–Wed next week", "Mon–Fri next week"];

// ---------------------------------------------------------------------------
// Tokens and masking
// ---------------------------------------------------------------------------

interface Token {
  /** Lowercased, punctuation-split, uncorrected — what anchors are resolved from. */
  readonly raw: string;
  /** Canonical form the date, guest and constraint patterns read. */
  readonly canon: string;
}

interface State {
  readonly tokens: readonly Token[];
  readonly masked: boolean[];
}

interface Hit {
  readonly g: readonly (string | undefined)[];
  commit(): void;
}

/** Optimal-string-alignment distance: Levenshtein plus adjacent transposition, the commonest typo. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[] = new Array<number>(rows * cols).fill(0);
  const at = (i: number, j: number): number => d[i * cols + j] ?? 0;
  for (let i = 0; i < rows; i++) d[i * cols] = i;
  for (let j = 0; j < cols; j++) d[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      d[i * cols + j] = best;
    }
  }
  return at(a.length, b.length);
}

/** Edits tolerated for a word of this length: none for short words, where one edit is a different word. */
function typoAllowance(length: number): number {
  if (length < 5) return 0;
  return length <= 7 ? 1 : 2;
}

function canonical(raw: string): string {
  const alias = ALIASES[raw];
  if (alias !== undefined) return alias;
  if (!/^[a-z]+$/.test(raw) || PROTECTED.has(raw)) return raw;
  const allowance = typoAllowance(raw.length);
  if (allowance === 0) return raw;

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const [target, canon] of Object.entries(FUZZY_TARGETS)) {
    const distance = editDistance(raw, target);
    if (distance < bestDistance) {
      best = canon;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance && canon !== best) {
      tied = true;
    }
  }
  // An ambiguous correction is no correction: leaving the word alone can only
  // lead to a question, while a wrong guess leads to a wrong date.
  return best !== null && bestDistance <= allowance && !tied ? best : raw;
}

function tokenise(text: string): Token[] {
  const spaced = text
    .toLowerCase()
    .replace(/[‒–—―−]/g, " - ")
    .replace(/[&+]/g, " and ")
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[-/]/g, " $& ")
    .replace(/[^a-z0-9\-/| ]+/g, " ");
  return spaced
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((raw) => ({ raw, canon: canonical(raw) }));
}

/** A pattern that only matches whole tokens. */
function pat(source: string): RegExp {
  return new RegExp(`(?<![^ ])(?:${source})(?![^ ])`);
}

/**
 * Runs a pattern over the canonical text with masked tokens shown as "|", so an
 * extractor can never re-read words another extractor already claimed. The match
 * is only masked when the caller commits, after validating what it found.
 */
function find(st: State, re: RegExp): Hit | null {
  let text = "";
  const starts: number[] = [];
  st.tokens.forEach((token, i) => {
    if (i > 0) text += " ";
    starts.push(text.length);
    text += st.masked[i] === true ? "|" : token.canon;
  });
  const m = re.exec(text);
  if (m === null) return null;
  const from = m.index;
  const to = m.index + m[0].length;
  return {
    g: Array.from(m),
    commit: () => {
      starts.forEach((start, i) => {
        if (start >= from && start < to) st.masked[i] = true;
      });
    },
  };
}

function numberOf(word: string | undefined): number | null {
  if (word === undefined) return null;
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

// ---------------------------------------------------------------------------
// Calendar arithmetic on UTC day numbers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function dayNumber(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const stamp = Date.UTC(year, month - 1, day);
  const check = new Date(stamp);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return stamp / MS_PER_DAY;
}

function calendarOf(day: number): { year: number; month: number; date: number; weekday: number } {
  const d = new Date(day * MS_PER_DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, date: d.getUTCDate(), weekday: d.getUTCDay() };
}

function isoOf(day: number): IsoDate {
  const c = calendarOf(day);
  return `${String(c.year).padStart(4, "0")}-${String(c.month).padStart(2, "0")}-${String(c.date).padStart(2, "0")}`;
}

/** Today's calendar date where the traveller is — "Tuesday" means their Tuesday. */
function todayIn(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const day = dayNumber(field("year"), field("month"), field("day"));
  if (day === null) throw new RangeError(`Could not read today's date in "${timeZone}"`);
  return day;
}

function nextOnOrAfter(from: number, weekday: number): number {
  return from + ((weekday - calendarOf(from).weekday + 7) % 7);
}

/** The Monday of the week containing `day` (weeks run Monday–Sunday). */
function mondayOf(day: number): number {
  return day - ((calendarOf(day).weekday + 6) % 7);
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)";
const WD = "(mon|tue|wed|thu|fri|sat|sun)";
const D = "(\\d{1,2})";
const YR = "(?: (\\d{4}))?";
const TO = "(?:-|to)";
const NUM = "(\\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)";
/** A day number that is really a count of something else ("5 nights", "2 rooms"). */
const NOT_A_COUNT = "(?! (?:night|nights|rooms?|people|guests?|min|mins|minutes))";

interface Constraints {
  inPolicyOnly: boolean;
  workReady: boolean;
  freeCancellation: boolean;
  breakfast: boolean;
  maxCommuteMinutes: number | null;
}

function takeAll(st: State, re: RegExp, onHit: (hit: Hit) => void): void {
  for (let hit = find(st, re); hit !== null; hit = find(st, re)) {
    onHit(hit);
    hit.commit();
  }
}

function extractConstraints(st: State): Constraints {
  const c: Constraints = {
    inPolicyOnly: false,
    workReady: false,
    freeCancellation: false,
    breakfast: false,
    maxCommuteMinutes: null,
  };
  const tighten = (minutes: number): void => {
    c.maxCommuteMinutes = c.maxCommuteMinutes === null ? minutes : Math.min(c.maxCommuteMinutes, minutes);
  };

  takeAll(
    st,
    pat(
      "under (?:the |my |our )?(?:cap|budget|limit|policy)|(?:in|within) (?:the |my |our |company )?(?:policy|budget|cap|limit)|in - policy|policy compliant|compliant|as per policy|per policy",
    ),
    () => {
      c.inPolicyOnly = true;
    },
  );
  takeAll(
    st,
    pat(
      "work - ready|work ready|workready|laptop friendly|work space|workspace|(?:good |fast |strong |reliable |decent )?(?:wifi|wi - fi|internet)|(?:with )?(?:a )?(?:work )?desk",
    ),
    () => {
      c.workReady = true;
    },
  );
  // Negations are consumed first so "non-refundable" never reads as "refundable".
  takeAll(st, pat("non - refundable|nonrefundable|non refundable"), () => undefined);
  takeAll(st, pat("free cancell?ation|free to cancel|(?:fully )?flexible|flexi|(?:fully )?refundable|cancell?able"), () => {
    c.freeCancellation = true;
  });
  takeAll(st, pat("(?:no|without|skip) breakfast"), () => undefined);
  takeAll(st, pat("(?:with |incl |including |plus )?(?:free )?(?:breakfast|bfast)(?: incl| included| inclusive)?"), () => {
    c.breakfast = true;
  });
  takeAll(st, pat("(?:within )?(?:walking|walkable) distance|walkable"), () => tighten(12));
  takeAll(
    st,
    pat(
      "(?:within|under|less than|max|at most|no more than|upto|up to) (\\d{1,3}) (?:min|mins|minute|minutes)(?: (?:walk|drive|commute|away|ride))?",
    ),
    (hit) => {
      const n = numberOf(hit.g[1]);
      if (n !== null && n > 0) tighten(n);
    },
  );
  takeAll(st, pat("(\\d{1,3}) (?:min|mins|minute|minutes) (?:max|or less|away|walk|commute)"), (hit) => {
    const n = numberOf(hit.g[1]);
    if (n !== null && n > 0) tighten(n);
  });
  return c;
}

interface Dates {
  checkIn: number | null;
  checkOut: number | null;
  confidence: number;
}

const MAX_NIGHTS = 90;

function extractDates(st: State, today: number, monthFirst: boolean): Dates {
  const todayYear = calendarOf(today).year;
  const none: Dates = { checkIn: null, checkOut: null, confidence: 0 };

  /** A day and month with no year means the next one that has not passed. */
  const upcoming = (month: number | null, date: number | null, year: number | null): number | null => {
    if (month === null || date === null) return null;
    if (year !== null) return dayNumber(year, month, date);
    const thisYear = dayNumber(todayYear, month, date);
    if (thisYear !== null && thisYear >= today) return thisYear;
    return dayNumber(todayYear + 1, month, date);
  };
  /** An end date after `start`, rolling into the next year when the months wrap (30 Dec – 2 Jan). */
  const after = (start: number, month: number | null, date: number | null, year: number | null): number | null => {
    if (month === null || date === null) return null;
    if (year !== null) return dayNumber(year, month, date);
    const startYear = calendarOf(start).year;
    const same = dayNumber(startYear, month, date);
    if (same !== null && same > start) return same;
    return dayNumber(startYear + 1, month, date);
  };
  const month = (word: string | undefined): number | null => (word === undefined ? null : MONTH_INDEX[word] ?? null);
  const int = (word: string | undefined): number | null => (word === undefined ? null : Number(word));
  const year = (word: string | undefined): number | null => {
    if (word === undefined) return null;
    return word.length === 2 ? 2000 + Number(word) : Number(word);
  };
  const valid = (checkIn: number | null, checkOut: number | null): checkOut is number =>
    checkIn !== null && checkOut !== null && checkOut > checkIn && checkOut - checkIn <= MAX_NIGHTS;

  const tryRange = (re: RegExp, read: (g: readonly (string | undefined)[]) => [number | null, number | null]): Dates | null => {
    const hit = find(st, re);
    if (hit === null) return null;
    const [checkIn, checkOut] = read(hit.g);
    if (!valid(checkIn, checkOut) || checkIn === null) return null;
    hit.commit();
    return { checkIn, checkOut, confidence: 1 };
  };

  // --- 1. Explicit ranges. Most specific first, so "12 oct to 15 oct" is not read as "12 … 15 oct".
  const explicit =
    tryRange(pat(`(\\d{4}) - (\\d{1,2}) - (\\d{1,2}) ${TO} (\\d{4}) - (\\d{1,2}) - (\\d{1,2})`), (g) => [
      dayNumber(Number(g[1]), Number(g[2]), Number(g[3])),
      dayNumber(Number(g[4]), Number(g[5]), Number(g[6])),
    ]) ??
    tryRange(pat(`(?:from )?(?:the )?${D} (?:of )?${MON}${YR} ${TO} (?:the )?${D} (?:of )?${MON}${YR}`), (g) => {
      const start = upcoming(month(g[2]), int(g[1]), year(g[3]));
      return [start, start === null ? null : after(start, month(g[5]), int(g[4]), year(g[6]))];
    }) ??
    tryRange(pat(`(?:from )?(?:the )?${D} ${TO} (?:the )?${D} (?:of )?${MON}${YR}`), (g) => {
      const start = upcoming(month(g[3]), int(g[1]), year(g[4]));
      return [start, start === null ? null : after(start, month(g[3]), int(g[2]), year(g[4]))];
    }) ??
    tryRange(pat(`(?:from )?${MON} ${D}${YR} ${TO} ${MON} ${D}${YR}`), (g) => {
      const start = upcoming(month(g[1]), int(g[2]), year(g[3]));
      return [start, start === null ? null : after(start, month(g[4]), int(g[5]), year(g[6]))];
    }) ??
    tryRange(pat(`(?:from )?${MON} ${D} ${TO} ${D}${YR}`), (g) => {
      const start = upcoming(month(g[1]), int(g[2]), year(g[4]));
      return [start, start === null ? null : after(start, month(g[1]), int(g[3]), year(g[4]))];
    }) ??
    tryRange(pat(`(?:from )?(?:the )?${D} (?:of )?${MON}${YR} ${TO} (?:the )?${D}${NOT_A_COUNT}`), (g) => {
      const start = upcoming(month(g[2]), int(g[1]), year(g[3]));
      return [start, start === null ? null : after(start, month(g[2]), int(g[4]), year(g[3]))];
    }) ??
    tryRange(pat(`(?:from )?${D} / ${D}(?: / (\\d{4}|\\d{2}))? ${TO} ${D} / ${D}(?: / (\\d{4}|\\d{2}))?`), (g) => {
      // Day-first everywhere this product launches (IN, GB, AE, SG); month-first only in the Americas.
      const [d1, m1, d2, m2] = monthFirst ? [g[2], g[1], g[5], g[4]] : [g[1], g[2], g[4], g[5]];
      const start = upcoming(int(m1), int(d1), year(g[3]));
      return [start, start === null ? null : after(start, int(m2), int(d2), year(g[6]))];
    });
  if (explicit !== null) return explicit;

  // --- 2. Weekday ranges: "tue to fri", "mon-wed next week", "this week wed to fri".
  const weekdays = find(
    st,
    pat(`(?:from )?(?:(next|this) week )?(?:from )?(?:on )?(?:(?:next|this) )?${WD} ${TO} (?:(?:next|this) )?${WD}(?: (next|this) week)?`),
  );
  if (weekdays !== null) {
    const w1 = WEEKDAY_INDEX[weekdays.g[2] ?? ""];
    const w2 = WEEKDAY_INDEX[weekdays.g[3] ?? ""];
    if (w1 !== undefined && w2 !== undefined) {
      const week = weekdays.g[1] ?? weekdays.g[4];
      const span = (w2 - w1 + 7) % 7 || 7;
      let start: number;
      let confidence = 1;
      if (week === "next") start = mondayOf(today) + 7 + ((w1 + 6) % 7);
      else if (week === "this" && mondayOf(today) + ((w1 + 6) % 7) >= today) start = mondayOf(today) + ((w1 + 6) % 7);
      else {
        // No week named: the next occurrence on or after tomorrow — an inferred default.
        start = nextOnOrAfter(today + 1, w1);
        confidence = 0.7;
      }
      weekdays.commit();
      return { checkIn: start, checkOut: start + span, confidence };
    }
  }

  const relativeRange = find(st, pat(`(tomorrow|today|tonight) ${TO} ${WD}`));
  if (relativeRange !== null) {
    const w = WEEKDAY_INDEX[relativeRange.g[2] ?? ""];
    if (w !== undefined) {
      const start = relativeRange.g[1] === "tomorrow" ? today + 1 : today;
      relativeRange.commit();
      return { checkIn: start, checkOut: nextOnOrAfter(start + 1, w), confidence: 1 };
    }
  }

  const nextWeek = find(st, pat("(?:for |all of |the whole )?next week"));
  if (nextWeek !== null) {
    nextWeek.commit();
    const monday = mondayOf(today) + 7;
    return { checkIn: monday, checkOut: monday + 4, confidence: 1 };
  }

  // --- 3. A start point, a length, or both.
  let nights: number | null = null;
  const length = find(st, pat(`(?:for )?${NUM} (?:night|nights)|(?:for )?(a|one) (week)|(overnight)`));
  if (length !== null) {
    nights = length.g[3] === "week" ? 7 : length.g[4] === "overnight" ? 1 : numberOf(length.g[1]);
    if (nights !== null && nights >= 1 && nights <= MAX_NIGHTS) length.commit();
    else nights = null;
  }

  let start: number | null = null;
  let startConfidence = 0;
  let impliesOneNight = false;
  let oneNightConfidence = 0;

  const startDate =
    find(st, pat(`(?:from |on |starting |arriving )?(?:the )?${D} (?:of )?${MON}${YR}`)) ??
    find(st, pat(`(?:from |on |starting |arriving )?${MON} ${D}${YR}`));
  if (startDate !== null) {
    const dayFirst = /^\d/.test(startDate.g[1] ?? "");
    const value = dayFirst
      ? upcoming(month(startDate.g[2]), int(startDate.g[1]), year(startDate.g[3]))
      : upcoming(month(startDate.g[1]), int(startDate.g[2]), year(startDate.g[3]));
    if (value !== null) {
      startDate.commit();
      start = value;
      startConfidence = 1;
    }
  }

  if (start === null) {
    const relative = find(st, pat("(?:from |starting )?(day after tomorrow|tomorrow|tonight|today)"));
    if (relative !== null) {
      relative.commit();
      const word = relative.g[1];
      start = word === "day after tomorrow" ? today + 2 : word === "tomorrow" ? today + 1 : today;
      startConfidence = 1;
      impliesOneNight = true;
      // "Tonight" is a length as well as a date; "tomorrow" only suggests one.
      oneNightConfidence = word === "tonight" ? 1 : 0.7;
    }
  }

  if (start === null) {
    const weekday = find(st, pat(`(?:from |on |starting )?(?:(?:next|this) )?${WD}(?: (next|this) week)?( nights?)?`));
    const w = weekday === null ? undefined : WEEKDAY_INDEX[weekday.g[1] ?? ""];
    if (weekday !== null && w !== undefined) {
      weekday.commit();
      const week = weekday.g[2];
      if (week === "next") {
        start = mondayOf(today) + 7 + ((w + 6) % 7);
        startConfidence = 1;
      } else {
        start = nextOnOrAfter(today + 1, w);
        startConfidence = 0.7;
      }
      if (weekday.g[3] !== undefined) {
        impliesOneNight = true;
        oneNightConfidence = startConfidence;
      }
    }
  }

  if (start !== null && nights !== null) {
    return { checkIn: start, checkOut: start + nights, confidence: startConfidence };
  }
  if (start !== null && impliesOneNight) {
    return { checkIn: start, checkOut: start + 1, confidence: Math.min(startConfidence, oneNightConfidence) };
  }
  // A start with no length, or a length with no start: half an answer is still
  // a question, never a silently completed stay.
  if (start !== null) return { checkIn: start, checkOut: null, confidence: 0.5 };
  if (nights !== null) return { checkIn: null, checkOut: null, confidence: 0.3 };
  return none;
}

function extractGuests(st: State): { guests: number | null; rooms: number | null } {
  let guests: number | null = null;
  const companions =
    "(colleague|colleagues|coworker|coworkers|co - worker|co - workers|manager|boss|teammate|teammates|friend|friends|client|clients|wife|husband|partner)";
  const count = "(?:(a|an|my|one|two|three|four|five|\\d{1,2}) )?";

  const withMe = find(st, pat(`(?:me|myself|i) (?:and|with|plus) ${count}${companions}`));
  if (withMe !== null) {
    withMe.commit();
    guests = 1 + (numberOf(withMe.g[1]) ?? 1);
  }
  if (guests === null) {
    const accompanied = find(st, pat(`with ${count}${companions}`));
    if (accompanied !== null) {
      accompanied.commit();
      guests = 1 + (numberOf(accompanied.g[1]) ?? 1);
    }
  }
  if (guests === null) {
    const explicit = find(st, pat(`(?:for )?${NUM} (?:people|guests|guest|adults|adult|travellers|travelers|of us)`));
    const n = explicit === null ? null : numberOf(explicit.g[1]);
    if (explicit !== null && n !== null && n >= 1) {
      explicit.commit();
      guests = n;
    }
  }
  if (guests === null) {
    const solo = find(st, pat("just me|only me|solo|alone|myself"));
    if (solo !== null) {
      solo.commit();
      guests = 1;
    }
  }
  if (guests === null) {
    const trailing = find(st, pat("for (two|three|four|five|2|3|4|5)(?= \\||$)"));
    const n = trailing === null ? null : numberOf(trailing.g[1]);
    if (trailing !== null && n !== null) {
      trailing.commit();
      guests = n;
    }
  }

  let rooms: number | null = null;
  const roomCount = find(st, pat(`${NUM} (?:separate )?(?:room|rooms)`));
  const r = roomCount === null ? null : numberOf(roomCount.g[1]);
  if (roomCount !== null && r !== null && r >= 1) {
    roomCount.commit();
    rooms = r;
  }
  return { guests, rooms };
}

// ---------------------------------------------------------------------------
// Anchor
// ---------------------------------------------------------------------------

interface Candidate {
  readonly words: readonly string[];
  readonly kind: "strong" | "weak" | "bare";
}

function normaliseLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function trimFiller(words: readonly string[]): string[] {
  let from = 0;
  let to = words.length;
  while (from < to && FILLER.has(words[from] ?? "")) from++;
  while (to > from && FILLER.has(words[to - 1] ?? "")) to--;
  return words.slice(from, to);
}

function isPlaceWord(words: readonly string[]): boolean {
  return words.some((w) => /[a-z]/.test(w) && w.length >= 3 && !FILLER.has(w) && !STOP.has(w));
}

function collectCandidates(st: State): Candidate[] {
  const raw = st.tokens.map((t, i) => (st.masked[i] === true ? "|" : t.raw));
  const phraseAfter = (index: number): string[] => {
    const words: string[] = [];
    for (let j = index; j < raw.length && words.length < 5; j++) {
      const word = raw[j] ?? "|";
      if (STOP.has(word)) break;
      words.push(word);
    }
    return trimFiller(words);
  };

  const strong: Candidate[] = [];
  const weak: Candidate[] = [];
  for (let i = 0; i < raw.length; i++) {
    const matchPrep = (preps: readonly (readonly string[])[]): number => {
      for (const prep of preps) {
        if (prep.every((word, k) => raw[i + k] === word)) return prep.length;
      }
      return 0;
    };
    const strongLength = matchPrep(STRONG_PREPS);
    if (strongLength > 0) {
      const words = phraseAfter(i + strongLength);
      if (words.length > 0) strong.push({ words, kind: "strong" });
      i += strongLength - 1;
      continue;
    }
    if (matchPrep(WEAK_PREPS) > 0) {
      const words = phraseAfter(i + 1);
      if (words.length > 0) weak.push({ words, kind: "weak" });
    }
    // "the Bandra office": the words before a place noun name the place.
    if (PLACE_NOUNS.has(raw[i] ?? "")) {
      const words: string[] = [];
      for (let j = i - 1; j >= 0 && words.length < 4; j--) {
        const word = raw[j] ?? "|";
        if (STOP.has(word)) break;
        words.unshift(word);
      }
      const trimmed = trimFiller(words);
      if (trimmed.length > 0) strong.push({ words: trimmed, kind: "strong" });
    }
  }

  // Bare runs of unclaimed words, for "whitefield 12-15 oct" with no preposition at all.
  const bare: Candidate[] = [];
  let run: string[] = [];
  const flush = (): void => {
    const trimmed = trimFiller(run);
    if (trimmed.length > 0) bare.push({ words: trimmed, kind: "bare" });
    run = [];
  };
  for (const word of raw) {
    if (STOP.has(word)) flush();
    else run.push(word);
  }
  flush();

  return [...strong, ...weak, ...bare];
}

/** Every contiguous sub-phrase, longest first, so "bkc mumbai" still finds "bkc". */
function spansOf(words: readonly string[]): string[] {
  const spans: string[] = [];
  for (let size = words.length; size >= 1; size--) {
    for (let from = 0; from + size <= words.length; from++) {
      const slice = words.slice(from, from + size);
      if (size === 1 && !isPlaceWord(slice)) continue;
      spans.push(slice.join(" "));
    }
  }
  return spans;
}

function extractAnchor(
  st: State,
  ctx: IntentContext,
): { anchor: Anchor | null; anchorQuery: string | null; confidence: number } {
  const candidates = collectCandidates(st);

  for (const candidate of candidates) {
    for (const span of spansOf(candidate.words)) {
      const anchor = ctx.resolveAnchor(span);
      if (anchor !== null) return { anchor, anchorQuery: span, confidence: 1 };
    }
  }

  // Near-misses against known anchors ("whitefeild"): accepted, but as an
  // inference — the read-back shows the corrected name.
  let bestAnchor: Anchor | null = null;
  let bestSpan = "";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    for (const span of spansOf(candidate.words)) {
      for (const anchor of ctx.anchors) {
        const label = normaliseLabel(anchor.label);
        const allowance = typoAllowance(Math.min(label.length, span.length));
        const distance = editDistance(span, label);
        if (allowance > 0 && distance <= allowance && distance < bestDistance) {
          bestAnchor = anchor;
          bestSpan = span;
          bestDistance = distance;
        }
      }
    }
  }
  if (bestAnchor !== null) return { anchor: bestAnchor, anchorQuery: bestSpan, confidence: 0.7 };

  // Named but unknown: keep what they said so the question can quote it. Bare
  // runs never become a query — asking about a random word would be noise.
  const named = candidates.find((c) => c.kind !== "bare" && isPlaceWord(c.words));
  if (named !== undefined) return { anchor: null, anchorQuery: named.words.join(" "), confidence: 0.3 };

  return { anchor: null, anchorQuery: null, confidence: 0 };
}

function anchorOptions(query: string | null, anchors: readonly Anchor[]): string[] {
  const wanted = new Set(query === null ? [] : normaliseLabel(query).split(" "));
  const scored = anchors.map((anchor, index) => {
    const words = normaliseLabel(`${anchor.label} ${anchor.city}`).split(" ");
    return { anchor, index, score: words.filter((w) => wanted.has(w)).length };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, 4).map((s) => s.anchor.label);
}

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

function describeDay(day: number, withMonth: boolean, withYear: boolean): string {
  const c = calendarOf(day);
  const weekday = WEEKDAY_NAMES[c.weekday] ?? "";
  const monthName = MONTH_NAMES[c.month - 1] ?? "";
  return `${weekday} ${c.date}${withMonth ? ` ${monthName}` : ""}${withYear ? ` ${c.year}` : ""}`;
}

/** "Tue 15 – Fri 18 Sep"; months and years appear only where they change, or differ from this year. */
function describeDates(checkIn: number, checkOut: number | null, today: number): string {
  const thisYear = calendarOf(today).year;
  const a = calendarOf(checkIn);
  if (checkOut === null) return `from ${describeDay(checkIn, true, a.year !== thisYear)}`;
  const b = calendarOf(checkOut);
  if (a.year !== b.year) return `${describeDay(checkIn, true, true)} – ${describeDay(checkOut, true, true)}`;
  const showYear = a.year !== thisYear;
  if (a.month !== b.month) return `${describeDay(checkIn, true, false)} – ${describeDay(checkOut, true, showYear)}`;
  return `${describeDay(checkIn, false, false)} – ${describeDay(checkOut, true, showYear)}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const CONFIDENT = 0.6;

/**
 * Parses one sentence into a search intent. Deterministic for a given text, `now`
 * and `timeZone`; asks exactly one question when the anchor or the dates fall
 * below 0.6 confidence (anchor first), and never fills a date the text did not give.
 */
export function parseIntent(text: string, ctx: IntentContext): ParsedIntent {
  const tokens = tokenise(text);
  const st: State = { tokens, masked: tokens.map(() => false) };
  const today = todayIn(ctx.now, ctx.timeZone);

  const constraints = extractConstraints(st);
  const dates = extractDates(st, today, ctx.timeZone.startsWith("America/"));
  const people = extractGuests(st);
  const { anchor, anchorQuery, confidence: anchorConfidence } = extractAnchor(st, ctx);

  // Spec §2.2: guests default to 1 and rooms to 1; every room holds at least one guest.
  const rooms = people.rooms ?? 1;
  const guests = Math.max(people.guests ?? 1, rooms);

  let clarification: ClarifyingQuestion | null = null;
  if (anchorConfidence < CONFIDENT) {
    clarification = {
      field: "anchor",
      question:
        anchorQuery === null ? "Where is your meeting?" : `I couldn't place "${anchorQuery}" — where is your meeting?`,
      options: anchorOptions(anchorQuery, ctx.anchors),
    };
  } else if (dates.confidence < CONFIDENT) {
    clarification = { field: "dates", question: "Which dates do you need the hotel for?", options: DATE_OPTIONS };
  }

  const parts: string[] = [];
  // Most anchor labels already end in their city ("Bandra Kurla Complex, Mumbai");
  // appending it again read back as "Mumbai, Mumbai".
  if (anchor !== null) {
    parts.push(anchor.label.toLowerCase().includes(anchor.city.toLowerCase()) ? anchor.label : `${anchor.label}, ${anchor.city}`);
  }
  if (dates.checkIn !== null) parts.push(describeDates(dates.checkIn, dates.checkOut, today));
  parts.push(`${guests} ${guests === 1 ? "guest" : "guests"}`);
  if (rooms > 1) parts.push(`${rooms} rooms`);
  if (constraints.inPolicyOnly) parts.push("in policy");
  if (constraints.workReady) parts.push("work-ready");
  if (constraints.freeCancellation) parts.push("free cancellation");
  if (constraints.breakfast) parts.push("breakfast");
  if (constraints.maxCommuteMinutes !== null) parts.push(`within ${constraints.maxCommuteMinutes} min`);

  return {
    text,
    anchorQuery,
    anchor,
    checkIn: dates.checkIn === null ? null : isoOf(dates.checkIn),
    checkOut: dates.checkOut === null ? null : isoOf(dates.checkOut),
    guests,
    rooms,
    constraints: {
      inPolicyOnly: constraints.inPolicyOnly,
      workReady: constraints.workReady,
      freeCancellation: constraints.freeCancellation,
      breakfast: constraints.breakfast,
      maxCommuteMinutes: constraints.maxCommuteMinutes,
    },
    confidence: { anchor: anchorConfidence, dates: dates.confidence },
    clarification,
    readBack: parts.join(" · "),
    parser: "rules",
  };
}
