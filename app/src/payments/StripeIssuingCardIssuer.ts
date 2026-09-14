/**
 * Stripe Issuing, behind the CardIssuer port. Spec §3.2 names Stripe Issuing as the
 * tokenising processor.
 *
 * Verified against Stripe's API reference: `POST /v1/issuing/cards` with
 * `cardholder`, `currency`, `type=virtual`, `status`, `exp_month`/`exp_year`,
 * `metadata`, and `spending_controls[spending_limits][][amount|interval]` with
 * interval `all_time`; the response's `id`, `last4`, `exp_month`, `exp_year`,
 * `brand`. The card number and CVC are never requested or expanded, so they
 * never reach this process (A13).
 *
 * UNVERIFIED: the lodging merchant-category slug (Stripe's category list did not
 * render for verification) and cancellation via `status=canceled`.
 */
import type { IssuedCard } from "../core/types.ts";
import type { CardIssuer, IssueCardRequest } from "./CardIssuer.ts";
import { CardDeclinedError, IssuerUnavailableError } from "./CardIssuer.ts";

export const STRIPE_ISSUER_ID = "stripe-issuing";
/** UNVERIFIED: Stripe's merchant category for MCC 7011 (hotels, motels, resorts). */
export const LODGING_CATEGORY = "hotels_motels_and_resorts";

export interface StripeIssuingConfig {
  readonly secretKey: string;
  readonly cardholderId: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

interface StripeCard {
  readonly id?: string;
  readonly last4?: string;
  readonly exp_month?: number;
  readonly exp_year?: number;
  readonly brand?: string;
  readonly error?: { readonly code?: string; readonly decline_code?: string; readonly type?: string; readonly message?: string };
}

export function createStripeIssuingCardIssuer(cfg: StripeIssuingConfig): CardIssuer {
  const baseUrl = cfg.baseUrl ?? "https://api.stripe.com";
  const doFetch = cfg.fetch ?? fetch;
  const auth = `Basic ${Buffer.from(`${cfg.secretKey}:`).toString("base64")}`;

  async function post(path: string, form: URLSearchParams): Promise<{ status: number; body: StripeCard }> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch (err) {
      throw new IssuerUnavailableError(`Stripe request failed: ${(err as Error).message}`);
    }
    return { status: res.status, body: (await res.json()) as StripeCard };
  }

  return {
    id: STRIPE_ISSUER_ID,
    capabilities: { live: true, currencies: "any" },

    async issue(req: IssueCardRequest): Promise<IssuedCard> {
      const limit = req.exactTotal.minor + req.incidentalsBufferMinor;
      const form = new URLSearchParams({
        cardholder: cfg.cardholderId,
        currency: req.exactTotal.currency.toLowerCase(),
        type: "virtual",
        status: "active",
        exp_month: String(Number(req.validUntil.slice(5, 7))),
        exp_year: req.validUntil.slice(0, 4),
        "spending_controls[spending_limits][0][amount]": String(limit),
        "spending_controls[spending_limits][0][interval]": "all_time",
        "spending_controls[allowed_categories][0]": LODGING_CATEGORY,
        "metadata[booking_reference]": req.reference,
        "metadata[entity_id]": req.entityId,
        "metadata[valid_from]": req.validFrom,
        "metadata[valid_until]": req.validUntil,
      });
      const { status, body } = await post("/v1/issuing/cards", form);
      if (status === 402 || body.error?.type === "card_error") {
        throw new CardDeclinedError(body.error?.decline_code ?? body.error?.code ?? "card_declined");
      }
      if (status >= 400 || body.id === undefined || body.last4 === undefined) {
        throw new IssuerUnavailableError(`Stripe answered ${status}: ${body.error?.message ?? "no card returned"}`, status);
      }
      return {
        tokenRef: body.id,
        last4: body.last4,
        brand: body.brand ?? "Visa",
        expMonth: body.exp_month ?? Number(req.validUntil.slice(5, 7)),
        expYear: body.exp_year ?? Number(req.validUntil.slice(0, 4)),
        authorisedTotal: req.exactTotal,
        incidentalsBufferMinor: req.incidentalsBufferMinor,
        issuerId: STRIPE_ISSUER_ID,
        validFrom: req.validFrom,
        validUntil: req.validUntil,
      };
    },

    async void(tokenRef: string): Promise<void> {
      // UNVERIFIED: cancelling an Issuing card is an update with status=canceled.
      const { status, body } = await post(`/v1/issuing/cards/${encodeURIComponent(tokenRef)}`, new URLSearchParams({ status: "canceled" }));
      if (status >= 400) throw new IssuerUnavailableError(`Stripe cancel answered ${status}: ${body.error?.message ?? ""}`, status);
    },
  };
}
