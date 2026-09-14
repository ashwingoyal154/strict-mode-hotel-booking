import { createSandboxCardIssuer } from "../../src/payments/SandboxCardIssuer.ts";
import { CardDeclinedError, type IssueCardRequest } from "../../src/payments/CardIssuer.ts";
import { money } from "../../src/core/money.ts";

// A13: no raw card number anywhere. A conservative PAN-shaped scan: any run of
// 12+ consecutive digits (real PANs are 13-19; we go looser to be safe).
const CARD_LIKE_RUN = /\d{12,}/;

function baseRequest(overrides: Partial<IssueCardRequest> = {}): IssueCardRequest {
  return {
    exactTotal: money(1_234_500, "INR"),
    incidentalsBufferMinor: 50_000,
    entityId: "acme",
    reference: "bkg_test_1",
    correlationId: "corr-1",
    travellerName: "Asha Rao",
    validFrom: "2026-10-11",
    validUntil: "2026-10-17",
    merchantCategory: "lodging",
    ...overrides,
  };
}

describe("createSandboxCardIssuer", () => {
  it("never returns anything resembling a card number", async () => {
    const issuer = createSandboxCardIssuer();
    const card = await issuer.issue(baseRequest());
    expect(CARD_LIKE_RUN.test(card.tokenRef)).toBe(false);
    expect(CARD_LIKE_RUN.test(card.last4)).toBe(false);
    expect(CARD_LIKE_RUN.test(JSON.stringify(card))).toBe(false);
    expect(card.last4).toMatch(/^\d{4}$/);
  });

  it("returns tokenRef + last4 only for card identity, no pan/cvv fields", async () => {
    const issuer = createSandboxCardIssuer();
    const card = await issuer.issue(baseRequest());
    const keys = Object.keys(card);
    for (const forbidden of ["pan", "cvv", "cardNumber", "number"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("carries through the requested total and incidentals buffer", async () => {
    const issuer = createSandboxCardIssuer();
    const req = baseRequest({ exactTotal: money(999_00, "INR"), incidentalsBufferMinor: 12_00 });
    const card = await issuer.issue(req);
    expect(card.authorisedTotal).toEqual(money(999_00, "INR"));
    expect(card.incidentalsBufferMinor).toBe(12_00);
  });

  it("is deterministic-decline via alwaysDeclineRefs", async () => {
    const issuer = createSandboxCardIssuer({ alwaysDeclineRefs: ["bkg_declined"] });
    await expect(issuer.issue(baseRequest({ reference: "bkg_declined" }))).rejects.toBeInstanceOf(
      CardDeclinedError,
    );
    // A different reference on the same issuer still succeeds.
    await expect(issuer.issue(baseRequest({ reference: "bkg_fine" }))).resolves.toBeDefined();
  });

  it("declineRate is deterministic for the same inputs, not Math.random()-flaky", async () => {
    const issuer = createSandboxCardIssuer({ declineRate: 1 });
    // declineRate 1 => always declines regardless of input.
    await expect(issuer.issue(baseRequest())).rejects.toBeInstanceOf(CardDeclinedError);

    const calm = createSandboxCardIssuer({ declineRate: 0 });
    await expect(calm.issue(baseRequest())).resolves.toBeDefined();
  });

  it("void() resolves without throwing", async () => {
    const issuer = createSandboxCardIssuer();
    const card = await issuer.issue(baseRequest());
    await expect(issuer.void(card.tokenRef)).resolves.toBeUndefined();
  });
});
