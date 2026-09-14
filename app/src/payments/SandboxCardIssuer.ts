/**
 * Sandbox virtual-card issuer. Never generates, stores or logs a PAN — not
 * even a fake one — because A13 is verified by scanning the codebase and logs
 * for card-like digit runs. The IssuedCard type carries only a tokenRef and a
 * last4 derived from a hash; nothing here can regress that by construction.
 *
 * Slice 2: honours the stay window. The card is valid from `validFrom` to
 * `validUntil` and expires at the end of `validUntil`'s month, so the card
 * cannot outlive the trip it was issued for.
 */
import { randomUUID } from "node:crypto";
import type { IssuedCard } from "../core/types.ts";
import type { CardIssuer, IssueCardRequest } from "./CardIssuer.ts";
import { CardDeclinedError } from "./CardIssuer.ts";

const FICTITIOUS_NETWORK_BRAND = "Sandbox Network";
const ISSUER_ID = "sandbox-card-issuer";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 4 digits, derived from a hash of the token — not a card number fragment. */
function last4From(tokenRef: string): string {
  const h = hashString(tokenRef) % 10_000;
  return String(h).padStart(4, "0");
}

export interface SandboxCardIssuerOptions {
  /** Fraction in [0,1]; deterministic per (reference, correlationId), not Math.random(). */
  readonly declineRate?: number;
  /**
   * References that always decline, for deterministic decline tests. The
   * literal wildcard "*" declines every issuance regardless of reference.
   */
  readonly alwaysDeclineRefs?: string[];
}

export function createSandboxCardIssuer(opts: SandboxCardIssuerOptions = {}): CardIssuer {
  const declineRate = opts.declineRate ?? 0;
  const alwaysDeclineRefs = new Set(opts.alwaysDeclineRefs ?? []);
  const declineAll = alwaysDeclineRefs.has("*");
  const voided = new Set<string>();

  return {
    id: ISSUER_ID,
    capabilities: { live: false, currencies: "any" },

    async issue(req: IssueCardRequest): Promise<IssuedCard> {
      if (!ISO_DATE.test(req.validFrom) || !ISO_DATE.test(req.validUntil) || req.validUntil < req.validFrom) {
        throw new CardDeclinedError("invalid_validity_window");
      }
      if (declineAll || alwaysDeclineRefs.has(req.reference)) {
        throw new CardDeclinedError("test_forced_decline");
      }
      if (declineRate > 0) {
        const roll = hashString(`${req.reference}|${req.correlationId}`) % 10_000;
        if (roll < Math.round(declineRate * 10_000)) {
          throw new CardDeclinedError("sandbox_random_decline");
        }
      }

      // tok_<uuid> — hyphenated, never a bare run of digits long enough to
      // read as a PAN, and never derived from or containing card data.
      const tokenRef = `tok_${randomUUID()}`;

      return {
        tokenRef,
        last4: last4From(tokenRef),
        brand: FICTITIOUS_NETWORK_BRAND,
        expMonth: Number(req.validUntil.slice(5, 7)),
        expYear: Number(req.validUntil.slice(0, 4)),
        authorisedTotal: req.exactTotal,
        incidentalsBufferMinor: req.incidentalsBufferMinor,
        issuerId: ISSUER_ID,
        validFrom: req.validFrom,
        validUntil: req.validUntil,
      };
    },

    async void(tokenRef: string): Promise<void> {
      voided.add(tokenRef);
    },
  };
}
