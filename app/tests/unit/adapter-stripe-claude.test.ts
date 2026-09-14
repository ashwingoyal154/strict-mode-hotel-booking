import { createStripeIssuingCardIssuer, LODGING_CATEGORY } from "../../src/payments/StripeIssuingCardIssuer.ts";
import { CardDeclinedError } from "../../src/payments/CardIssuer.ts";
import { createClaudeIntentParser, type IntentClient } from "../../src/intent/ClaudeIntentParser.ts";
import { createRuleIntentParser } from "../../src/intent/RuleIntentParser.ts";
import { FIXTURE_ANCHORS, resolveAnchor } from "../../src/supply/fixtures/anchors.ts";
import { money } from "../../src/core/money.ts";

const request = {
  exactTotal: money(2_632_800, "INR"),
  incidentalsBufferMinor: 200_000,
  entityId: "acme",
  reference: "bkg_1",
  correlationId: "corr_1",
  travellerName: "Asha Rao",
  validFrom: "2026-10-11",
  validUntil: "2026-10-17",
  merchantCategory: "lodging" as const,
};

describe("Stripe Issuing adapter", () => {
  it("creates a lodging-locked, all-time-limited virtual card and never asks for the number", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const issuer = createStripeIssuingCardIssuer({
      secretKey: "sk_test_x",
      cardholderId: "ich_1",
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ id: "ic_abc", last4: "4242", exp_month: 10, exp_year: 2026, brand: "Visa" }), { status: 200 });
      }) as typeof fetch,
    });
    const card = await issuer.issue(request);
    expect(card).toMatchObject({ tokenRef: "ic_abc", last4: "4242", issuerId: "stripe-issuing" });
    const form = new URLSearchParams(calls[0]?.body);
    expect(calls[0]?.url).toMatch(/\/v1\/issuing\/cards$/);
    expect(form.get("type")).toBe("virtual");
    expect(form.get("currency")).toBe("inr");
    expect(form.get("spending_controls[spending_limits][0][amount]")).toBe(String(2_632_800 + 200_000));
    expect(form.get("spending_controls[spending_limits][0][interval]")).toBe("all_time");
    expect(form.get("spending_controls[allowed_categories][0]")).toBe(LODGING_CATEGORY);
    expect(calls.map((c) => c.body).join("&")).not.toMatch(/expand|number|cvc/);
    expect(Object.keys(card)).not.toContain("number");
  });

  it("maps a card_error to CardDeclinedError", async () => {
    const issuer = createStripeIssuingCardIssuer({
      secretKey: "sk_test_x",
      cardholderId: "ich_1",
      fetch: (async () =>
        new Response(JSON.stringify({ error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds" } }), { status: 402 })) as typeof fetch,
    });
    await expect(issuer.issue(request)).rejects.toBeInstanceOf(CardDeclinedError);
  });
});

describe("Claude intent parser", () => {
  const ctx = { now: new Date("2026-09-14T03:30:00Z"), timeZone: "Asia/Kolkata", anchors: FIXTURE_ANCHORS, resolveAnchor };
  const fake = (out: unknown, stop = "end_turn"): IntentClient => ({
    messages: { parse: async () => ({ stop_reason: stop, parsed_output: out as never }) },
  });

  it("turns a structured extraction into a resolved intent and never books", async () => {
    const parser = createClaudeIntentParser({
      fallback: createRuleIntentParser(),
      client: fake({
        anchorQuery: "BKC", checkIn: "2026-09-15", checkOut: "2026-09-18", guests: 1, rooms: 1,
        inPolicyOnly: true, workReady: false, freeCancellation: false, breakfast: false, maxCommuteMinutes: null,
      }),
    });
    const intent = await parser.parse("hotel near bkc tue to fri, in policy", ctx);
    expect(intent.parser).toBe("claude");
    expect(intent.anchor?.city).toBe("Mumbai");
    expect(intent.clarification).toBeNull();
    expect(intent.readBack).toMatch(/Tue 15 Sep – Fri 18 Sep/);
  });

  it("asks rather than guesses when the model leaves dates out", async () => {
    const parser = createClaudeIntentParser({
      fallback: createRuleIntentParser(),
      client: fake({
        anchorQuery: "BKC", checkIn: null, checkOut: null, guests: null, rooms: null,
        inPolicyOnly: false, workReady: false, freeCancellation: false, breakfast: false, maxCommuteMinutes: null,
      }),
    });
    expect((await parser.parse("hotel near bkc", ctx)).clarification?.field).toBe("dates");
  });

  it("falls back to the rules parser on refusal and on error", async () => {
    const refused = createClaudeIntentParser({ fallback: createRuleIntentParser(), client: fake(null, "refusal") });
    expect((await refused.parse("hotel near bkc tue to fri", ctx)).parser).toBe("rules");
    const broken = createClaudeIntentParser({
      fallback: createRuleIntentParser(),
      client: { messages: { parse: async () => { throw new Error("timeout"); } } },
    });
    expect((await broken.parse("hotel near bkc tue to fri", ctx)).parser).toBe("rules");
  });
});
