import type { IssuedCard, Money } from "../core/types.ts";

/**
 * Central billing. The traveller never makes a payment decision and never pays
 * out of pocket (A9).
 *
 * This interface cannot return a card number. Everything above it handles a
 * tokenRef and last4 only, which is how A13 ("no PAN in any database, log or
 * trace") is achieved by construction rather than by discipline.
 */
export interface CardIssuer {
  readonly id: string;

  issue(req: IssueCardRequest): Promise<IssuedCard>;

  /** Called when a booking is cancelled or a supplier book fails after issue. */
  void(tokenRef: string): Promise<void>;
}

export interface IssueCardRequest {
  readonly exactTotal: Money;
  readonly incidentalsBufferMinor: number;
  readonly entityId: string;
  /** Booking reference, for reconciliation. */
  readonly reference: string;
  readonly correlationId: string;
}

export class CardDeclinedError extends Error {
  constructor(readonly declineCode: string) {
    super(`card declined: ${declineCode}`);
    this.name = "CardDeclinedError";
  }
}
