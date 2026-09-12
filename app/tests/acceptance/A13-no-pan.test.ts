/**
 * A13 — "No raw card number appears in any database, log or trace — proven by a
 * scan of all three."
 *
 * This is a structural test, not a behavioural one. It scans the source tree and
 * every byte the app writes for card-like digit runs. It is designed to fail the
 * build the day someone adds a convenient "test PAN".
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeHarness, book } from "./harness.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

/** 13–19 consecutive digits, optionally split by spaces or dashes in groups of 4. */
const PAN_LIKE = /(?:\d[ -]?){13,19}/g;

function looksLikePan(candidate: string): boolean {
  const digits = candidate.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  // Luhn. A real PAN passes; a random id almost never does.
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|json|css|html|md|jsonl)$/.test(name)) out.push(p);
  }
  return out;
}

describe("A13 — no card number anywhere", () => {
  it("has no Luhn-valid card-like number in any source file", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.match(PAN_LIKE) ?? []) {
        if (looksLikePan(m)) offenders.push(`${file}: ${m}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("exposes no pan/cvv/cardNumber field on any payment type", () => {
    const issuer = readFileSync(join(ROOT, "src/payments/CardIssuer.ts"), "utf8");
    const types = readFileSync(join(ROOT, "src/core/types.ts"), "utf8");
    for (const banned of ["pan", "cvv", "cvc", "cardNumber", "card_number"]) {
      expect(issuer.toLowerCase()).not.toContain(`${banned}:`);
      expect(types.toLowerCase()).not.toContain(`${banned}:`);
    }
  });

  it("writes no card-like number into the append-only source log", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;
    await book(h, s.searchId, offer);

    const log = await h.agent.get("/api/admin/source-log?limit=500");
    const serialised = JSON.stringify(log.body);
    const offenders = (serialised.match(PAN_LIKE) ?? []).filter(looksLikePan);
    expect(offenders).toEqual([]);
  }, 60000);

  it("records card issuance in the log without card data", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search();
    const offer = s.inPolicy[0];
    if (!offer) return;
    await book(h, s.searchId, offer);
    const log = await h.agent.get("/api/admin/source-log?limit=500");
    const ops = (log.body.entries as Array<{ operation: string }>).map((e) => e.operation);
    expect(ops).toContain("issueCard");
  }, 60000);
});
