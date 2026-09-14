import type { Currency, IsoDate, IssuedCard, Money } from "../core/types.ts";

/**
 * Central billing. The traveller never makes a payment decision and never pays
 * out of pocket (A9).
 *
 * This interface cannot return a card number. Everything above it handles a
 * tokenRef and last4 only — A13 by construction. Slice 2 adds a live issuing
 * adapter behind this line; the sandbox stays for tests and demos.
 */
export interface CardIssuer {
  readonly id: string;
  readonly capabilities: CardIssuerCapabilities;

  issue(req: IssueCardRequest): Promise<IssuedCard>;

  /** Called when a booking is cancelled or a supplier book fails after issue. */
  void(tokenRef: string): Promise<void>;
}

export interface CardIssuerCapabilities {
  readonly live: boolean;
  readonly currencies: readonly Currency[] | "any";
}

export interface IssueCardRequest {
  /** In the supplier currency. */
  readonly exactTotal: Money;
  readonly incidentalsBufferMinor: number;
  readonly entityId: string;
  readonly reference: string;
  readonly correlationId: string;
  readonly travellerName: string;
  /** The card only works inside the stay, with a day of slack either side. */
  readonly validFrom: IsoDate;
  readonly validUntil: IsoDate;
  /** Spending is locked to lodging merchants. */
  readonly merchantCategory: "lodging";
}

export class CardDeclinedError extends Error {
  constructor(readonly declineCode: string) {
    super(`card declined: ${declineCode}`);
    this.name = "CardDeclinedError";
  }
}

/** A transport-level failure talking to a live issuer. Retryable; distinct from a decline. */
export class IssuerUnavailableError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "IssuerUnavailableError";
  }
}
