/**
 * Confirm — one number, one tap, no required input.
 *
 * Guests, rooms, payment, the cancellation terms and the cost centre are all shown
 * as already decided. Only the cost centre carries an Edit, because it is the only
 * one of them the traveller legitimately owns.
 *
 * Idempotency:
 *   · One key per confirm intent, generated with crypto.randomUUID().
 *   · A transient failure (402 card_declined, 503 source_unavailable, an
 *     unreachable server) retries with the *same* key, so a booking the server may
 *     already have written can never be duplicated.
 *   · Accepting a drifted price, or changing the cost centre, changes the body and
 *     therefore the intent, so the key is regenerated.
 *
 * `acceptedTotal` is always a Money object handed over by the API verbatim — the
 * rate's own allInTotal, or the drift detail's currentTotal. It is never recomputed
 * here, because a total that differs by one paise from what the server priced is
 * exactly the failure A3 exists to prevent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Money, Policy, PolicyVerdict, PriceDriftDetail, RankedOffer, Traveller } from "../../core/types.ts";
import {
  asCancellationDeadline,
  asDeclineCode,
  asPriceDrift,
  asVerdict,
  createBooking,
  getPolicy,
  getSearch,
  isApiError,
  messageOf,
  newIdempotencyKey,
  type SearchSnapshot,
} from "../lib/api.ts";
import {
  describeCommute,
  formatDateRange,
  formatDeadline,
  formatMoney,
  formatSignedMinor,
  nightsBetween,
  plural,
} from "../lib/fmt.ts";
import { DecidedLine } from "../components/DecidedLine.tsx";
import { Notice } from "../components/Notice.tsx";
import { TotalBlock } from "../components/TotalBlock.tsx";
import { VerdictChip } from "../components/VerdictChip.tsx";

type LoadPhase =
  | { readonly k: "loading" }
  | { readonly k: "ready"; readonly snapshot: SearchSnapshot; readonly ranked: RankedOffer }
  | { readonly k: "gone"; readonly searchAlive: boolean }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

type Attempt =
  | { readonly k: "idle" }
  | { readonly k: "submitting" }
  | { readonly k: "drift"; readonly detail: PriceDriftDetail }
  | { readonly k: "sold_out"; readonly message: string }
  | { readonly k: "blocked"; readonly verdict: PolicyVerdict | null; readonly message: string }
  | { readonly k: "declined"; readonly declineCode: string | null; readonly message: string }
  | { readonly k: "unavailable"; readonly message: string }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

export function ConfirmScreen({ traveller }: { readonly traveller: Traveller }): JSX.Element {
  const { searchId = "", offerId = "" } = useParams<{ searchId: string; offerId: string }>();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<LoadPhase>({ k: "loading" });
  const [attempt, setAttempt] = useState<Attempt>({ k: "idle" });
  const [costCentre, setCostCentre] = useState(traveller.defaultCostCentre);
  const [policy, setPolicy] = useState<Policy | null>(null);
  /** The number the traveller is accepting, exactly as the API sent it. */
  const [acceptedTotal, setAcceptedTotal] = useState<Money | null>(null);

  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setPhase({ k: "loading" });
    void getSearch(searchId)
      .then((snapshot) => {
        if (!live) return;
        const ranked = snapshot.results.find((r) => r.offer.rate.id === offerId);
        if (ranked === undefined) {
          setPhase({ k: "gone", searchAlive: true });
          return;
        }
        setAcceptedTotal(ranked.offer.rate.allInTotal);
        setPhase({ k: "ready", snapshot, ranked });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPhase({
          k: "fault",
          code: isApiError(err) ? err.code : "unexpected_error",
          message: messageOf(err),
        });
      });
    return () => {
      live = false;
    };
  }, [searchId, offerId]);

  useEffect(() => {
    if (!traveller.isAdmin) return undefined;
    let live = true;
    void getPolicy()
      .then((res) => {
        if (live) setPolicy(res.policy);
      })
      .catch(() => {
        /* the cost centre falls back to free text; not worth a state */
      });
    return () => {
      live = false;
    };
  }, [traveller.isAdmin]);

  const confirm = useCallback(
    async (total: Money, freshKey: boolean): Promise<void> => {
      if (keyRef.current === null || freshKey) keyRef.current = newIdempotencyKey();
      const idempotencyKey = keyRef.current;
      setAttempt({ k: "submitting" });
      try {
        const { booking } = await createBooking(
          { searchId, offerId, costCentre, acceptedTotal: total },
          idempotencyKey,
        );
        navigate(`/trip/${encodeURIComponent(booking.id)}`, { replace: true });
      } catch (err) {
        if (!isApiError(err)) {
          setAttempt({ k: "fault", code: "unexpected_error", message: messageOf(err) });
          return;
        }
        switch (err.status) {
          case 409: {
            const detail = asPriceDrift(err.detail);
            if (detail === null) {
              setAttempt({ k: "fault", code: err.code, message: err.message });
              return;
            }
            setAttempt({ k: "drift", detail });
            return;
          }
          case 410:
            setAttempt({ k: "sold_out", message: err.message });
            return;
          case 403:
            setAttempt({ k: "blocked", verdict: asVerdict(err.detail), message: err.message });
            return;
          case 402:
            setAttempt({
              k: "declined",
              declineCode: asDeclineCode(err.detail),
              message: err.message,
            });
            return;
          case 503:
          case 0:
            setAttempt({ k: "unavailable", message: err.message });
            return;
          default:
            setAttempt({ k: "fault", code: err.code, message: err.message });
        }
      }
    },
    [costCentre, navigate, offerId, searchId],
  );

  if (phase.k === "loading") {
    return (
      <div className="screen">
        <h1 className="h1">Confirm</h1>
        <p className="mono mono--muted">loading the rate you were shown&hellip;</p>
      </div>
    );
  }

  if (phase.k === "fault") {
    return (
      <div className="screen">
        <h1 className="h1">Confirm</h1>
        <Notice tone="blocked" code={phase.code} title="We could not reload that rate">
          <p className="prose">{phase.message}</p>
        </Notice>
        <Link to="/" className="btn">
          Start a new search
        </Link>
      </div>
    );
  }

  if (phase.k === "gone") {
    return (
      <div className="screen">
        <h1 className="h1">That rate is gone</h1>
        <Notice tone="blocked" code="offer not in search" title="It is no longer on offer">
          <p className="prose">
            The rate you tapped is not in this search any more. Nothing was booked and
            nothing was charged.
          </p>
        </Notice>
        <Link to={`/results/${encodeURIComponent(searchId)}`} className="btn">
          Back to results
        </Link>
      </div>
    );
  }

  const { snapshot, ranked } = phase;
  const { offer, commute, verdict } = ranked;
  const { property, rate } = offer;
  const nights = nightsBetween(rate.checkIn, rate.checkOut);
  const blockedByPolicy = verdict.state === "blocked";
  const submitting = attempt.k === "submitting";
  // One primary action, always. A drift panel carries its own explicit
  // "Confirm at the new price", and the stale total below it would be a second
  // route to a 409 — so the standing action stands down while it is open.
  const suppressPrimary =
    attempt.k === "sold_out" || attempt.k === "blocked" || attempt.k === "drift";
  const shownTotal = acceptedTotal ?? rate.allInTotal;

  const costCentres: readonly string[] = policy?.costCentres ?? [];

  return (
    <div className="confirm">
      <div className="screen__head">
        <h1 className="h1">Confirm</h1>
        <p className="mono mono--muted">
          {snapshot.anchor.label} &middot; {describeCommute(commute)}
        </p>
      </div>

      <div className="confirm__property">
        <h2 className="confirm__name">{property.name}</h2>
        <p className="confirm__addr">{property.addressLine}</p>
      </div>

      <div className="confirm__facts">
        <VerdictChip verdict={verdict} />
        <span className="mono">{verdict.reason}</span>
      </div>

      <TotalBlock rate={rate} />

      <div className="confirm__decided">
        <DecidedLine label="Traveller" value={`${traveller.name} · ${traveller.email}`} />
        <DecidedLine
          label="Dates"
          value={`${formatDateRange(rate.checkIn, rate.checkOut)} · ${plural(nights, "night")}`}
        />
        <DecidedLine
          label="Guests / rooms"
          value={`${plural(snapshot.query.guests, "guest")} · ${plural(snapshot.query.rooms, "room")}`}
        />
        <DecidedLine
          label="Payment"
          value="single-use virtual card, issued at confirmation"
        />
        <DecidedLine
          label="Cancellation"
          value={
            rate.refundableUntil === null
              ? "non-refundable"
              : `free until ${formatDeadline(rate.refundableUntil)}`
          }
        />
        <DecidedLine
          label="Cost centre"
          value={costCentre}
          editor={(close) => (
            <>
              <label className="label" htmlFor="cost-centre">
                Charge to
              </label>
              {costCentres.length > 0 ? (
                <select
                  id="cost-centre"
                  className="select"
                  value={costCentre}
                  onChange={(e) => {
                    setCostCentre(e.target.value);
                    keyRef.current = null;
                  }}
                >
                  {costCentres.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="cost-centre"
                  className="input input--narrow"
                  type="text"
                  value={costCentre}
                  onChange={(e) => {
                    setCostCentre(e.target.value.toUpperCase());
                    keyRef.current = null;
                  }}
                />
              )}
              <button type="button" className="btn-text" onClick={close}>
                Done
              </button>
            </>
          )}
        />
      </div>

      {attempt.k === "drift" ? (
        <Notice tone="over" code="409 price_drift" title="The source re-priced this stay">
          <div className="drift">
            <div className="drift__rows">
              <div className="drift__row drift__row--was">
                <span className="drift__row-label">total you accepted</span>
                <span className="drift__row-value">
                  {formatMoney(attempt.detail.acceptedTotal, { decimals: true })}
                </span>
              </div>
              <div className="drift__row">
                <span className="drift__row-label">total now</span>
                <span className="drift__row-value">
                  {formatMoney(attempt.detail.currentTotal, { decimals: true })}
                </span>
              </div>
              <div className="drift__row drift__row--delta">
                <span className="drift__row-label">delta</span>
                <span className="drift__row-value">
                  {formatSignedMinor(attempt.detail.deltaMinor, attempt.detail.currentTotal.currency)}
                </span>
              </div>
            </div>
            {attempt.detail.message.length > 0 ? (
              <p className="mono">{attempt.detail.message}</p>
            ) : null}
            <p className="prose">
              Nothing has been booked. We will not accept the new price for you &mdash; confirm
              it yourself, or go back and pick something else.
            </p>
            <div className="notice__actions">
              <button
                type="button"
                className="btn"
                disabled={submitting}
                onClick={() => {
                  setAcceptedTotal(attempt.detail.currentTotal);
                  void confirm(attempt.detail.currentTotal, true);
                }}
              >
                Confirm at the new price
              </button>
              <Link to={`/results/${encodeURIComponent(searchId)}`} className="btn">
                Back to results
              </Link>
            </div>
          </div>
        </Notice>
      ) : null}

      {attempt.k === "sold_out" ? (
        <Notice tone="blocked" code="410 sold_out" title="Taken while you were reading">
          <p className="prose">{attempt.message}</p>
          <p className="prose prose--quiet">
            No booking was made and no card was issued.
          </p>
          <div className="notice__actions">
            <Link to={`/results/${encodeURIComponent(searchId)}`} className="btn">
              Back to results
            </Link>
          </div>
        </Notice>
      ) : null}

      {attempt.k === "blocked" ? (
        <Notice tone="blocked" code="403 blocked_by_policy" title="Your policy refuses this rate">
          <p className="mono">{attempt.verdict?.reason ?? attempt.message}</p>
          {attempt.verdict !== null ? (
            <p className="mono mono--muted">
              policy version {attempt.verdict.policyVersion}
            </p>
          ) : null}
          <div className="notice__actions">
            <Link to={`/results/${encodeURIComponent(searchId)}`} className="btn">
              Back to results
            </Link>
          </div>
        </Notice>
      ) : null}

      {attempt.k === "declined" ? (
        <Notice tone="blocked" code="402 card_declined" title="The virtual card was declined">
          <p className="prose">{attempt.message}</p>
          {attempt.declineCode !== null ? (
            <p className="mono mono--muted">decline code {attempt.declineCode}</p>
          ) : null}
          <p className="prose prose--quiet">
            You have not been charged and there is nothing for you to pay. Retrying reuses
            the same request, so it cannot produce two bookings.
          </p>
          <div className="notice__actions">
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => void confirm(shownTotal, false)}
            >
              Try the card again
            </button>
          </div>
        </Notice>
      ) : null}

      {attempt.k === "unavailable" ? (
        <Notice tone="over" code="503 source_unavailable" title="The source did not answer">
          <p className="prose">{attempt.message}</p>
          <p className="prose prose--quiet">
            Nothing was booked. Retrying reuses the same request, so if the booking did
            land we will show you that one rather than make a second.
          </p>
          <div className="notice__actions">
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => void confirm(shownTotal, false)}
            >
              Try again
            </button>
            <Link to={`/results/${encodeURIComponent(searchId)}`} className="btn">
              Back to results
            </Link>
          </div>
        </Notice>
      ) : null}

      {attempt.k === "fault" ? (
        <Notice tone="blocked" code={attempt.code} title="That did not go through">
          <p className="prose">{attempt.message}</p>
          <div className="notice__actions">
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => void confirm(shownTotal, false)}
            >
              Try again
            </button>
          </div>
        </Notice>
      ) : null}

      {blockedByPolicy ? (
        <Notice tone="blocked" code="blocked_by_policy" title="This one cannot be booked">
          <p className="mono">{verdict.reason}</p>
          <div className="notice__actions">
            <Link to={`/results/${encodeURIComponent(searchId)}`} className="btn">
              Back to results
            </Link>
          </div>
        </Notice>
      ) : suppressPrimary ? null : (
        <div className="confirm__action">
          <button
            type="button"
            className="btn btn--primary"
            disabled={submitting}
            onClick={() => void confirm(shownTotal, false)}
          >
            {submitting ? "Confirming…" : `Confirm · ${formatMoney(shownTotal)}`}
          </button>
          <p className="confirm__footnote">
            Billed to your company. You pay nothing and file nothing.
          </p>
        </div>
      )}
    </div>
  );
}
