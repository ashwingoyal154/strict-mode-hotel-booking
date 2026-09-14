/**
 * Modify — change a confirmed stay without ever leaving the traveller roomless.
 *
 * Three steps, the first two reusing what already exists:
 *   1. `/trip/:id/modify` — the search form, pre-filled with this booking's anchor
 *      and dates. Submitting streams results on the ordinary Results screen with
 *      `?modify=:id`, whose cards then lead here instead of to Confirm.
 *   2. `/trip/:id/modify/:searchId/:offerId` — the quote: current and new totals,
 *      the signed difference, what cancelling the current stay costs, and the
 *      server's exact message, verbatim.
 *   3. Confirm the change with a fresh idempotency key. The server books the new
 *      stay first, then cancels the old one; any `warnings` are shown plainly with
 *      links to both bookings.
 *
 * Over-cap rates are not modifiable in Slice 2 (`422 modify_over_cap`) — that is a
 * new request, and the screen routes to one rather than dead-ending.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  Booking,
  ModifyQuote,
  Money,
  PriceDriftDetail,
  RankedOffer,
} from "../../core/types.ts";
import {
  asDeclineCode,
  asPriceDrift,
  createSearch,
  getBooking,
  getSearch,
  isApiError,
  messageOf,
  modifyBooking,
  newIdempotencyKey,
  quoteModify,
  type ModifyResult,
} from "../lib/api.ts";
import {
  formatDateRange,
  formatMoney,
  formatSignedMinor,
  formatSignedMoney,
  nightsBetween,
  plural,
} from "../lib/fmt.ts";
import { AnchorInput, type AnchorDraft } from "../components/AnchorInput.tsx";
import { DecidedLine } from "../components/DecidedLine.tsx";
import { FxEquivalent } from "../components/FxEquivalent.tsx";
import { Notice } from "../components/Notice.tsx";
import { TotalBlock } from "../components/TotalBlock.tsx";
import { VerdictChip } from "../components/VerdictChip.tsx";

export function ModifyScreen(): JSX.Element {
  const { bookingId = "", searchId, offerId } = useParams<{
    bookingId: string;
    searchId?: string;
    offerId?: string;
  }>();
  if (searchId !== undefined && offerId !== undefined) {
    return <ModifyQuoteStep bookingId={bookingId} searchId={searchId} offerId={offerId} />;
  }
  return <ModifySearchStep bookingId={bookingId} />;
}

// ---------------------------------------------------------------- step 1

type LoadBooking =
  | { readonly k: "loading" }
  | { readonly k: "ready"; readonly booking: Booking }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

function ModifySearchStep({ bookingId }: { readonly bookingId: string }): JSX.Element {
  const navigate = useNavigate();
  const [load, setLoad] = useState<LoadBooking>({ k: "loading" });
  const [draft, setDraft] = useState<AnchorDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [anchorError, setAnchorError] = useState<string | null>(null);
  const [fault, setFault] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    void getBooking(bookingId)
      .then((res) => {
        if (!live) return;
        const { rate } = res.booking.offer;
        setLoad({ k: "ready", booking: res.booking });
        setDraft({
          anchorQuery: res.booking.anchor.label,
          checkIn: rate.checkIn,
          checkOut: rate.checkOut,
          guests: 1,
          rooms: 1,
        });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoad({
          k: "fault",
          code: isApiError(err) ? err.code : "unexpected_error",
          message: messageOf(err),
        });
      });
    return () => {
      live = false;
    };
  }, [bookingId]);

  const tripHref = `/trip/${encodeURIComponent(bookingId)}`;

  if (load.k === "loading" || draft === null) {
    return (
      <div className="screen">
        <h1 className="h1">Change this stay</h1>
        {load.k === "fault" ? (
          <Notice tone="blocked" code={load.code} title="We could not open that booking">
            <p className="prose">{load.message}</p>
          </Notice>
        ) : (
          <p className="mono mono--muted">loading the booking record&hellip;</p>
        )}
        <Link to={tripHref} className="btn-text">
          Back to the trip
        </Link>
      </div>
    );
  }

  if (load.k !== "ready") return <div className="screen" />;
  const { booking } = load;
  const { property, rate } = booking.offer;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || draft.anchorQuery.trim().length < 2) return;
    setBusy(true);
    setAnchorError(null);
    setFault(null);
    try {
      const created = await createSearch({
        anchorQuery: draft.anchorQuery.trim(),
        checkIn: draft.checkIn,
        checkOut: draft.checkOut,
        guests: draft.guests,
        rooms: draft.rooms,
      });
      navigate(
        `/results/${encodeURIComponent(created.searchId)}?modify=${encodeURIComponent(bookingId)}`,
        { state: { sources: created.sources, anchor: created.anchor, query: created.query } },
      );
    } catch (err) {
      if (isApiError(err) && err.code === "anchor_not_found") setAnchorError(err.message);
      else setFault({ code: isApiError(err) ? err.code : "unexpected_error", message: messageOf(err) });
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="screen__head">
        <h1 className="h1">Change this stay</h1>
        <p className="prose">
          Search again with the anchor and dates you want. The new stay is booked first and
          only then is this one cancelled, so you are never left without a room.
        </p>
      </div>

      <div className="confirm__decided">
        <DecidedLine label="Current" value={`${booking.confirmationCode} · ${property.name}`} />
        <DecidedLine
          label="Dates"
          value={`${formatDateRange(rate.checkIn, rate.checkOut)} · ${plural(nightsBetween(rate.checkIn, rate.checkOut), "night")}`}
        />
        <DecidedLine label="Total" value={formatMoney(rate.allInTotal)} />
      </div>

      {booking.state !== "confirmed" ? (
        <Notice tone="neutral" code="not_confirmed" title="Only a confirmed booking can be changed">
          <p className="prose">
            This one is {booking.state.replace(/_/g, " ")}, so there is nothing to change.
          </p>
          <div className="notice__actions">
            <Link to={tripHref} className="btn">
              Back to the trip
            </Link>
          </div>
        </Notice>
      ) : (
        <>
          {fault !== null ? (
            <Notice tone="blocked" code={fault.code}>
              <p className="prose">{fault.message}</p>
            </Notice>
          ) : null}
          <form className="search__form" onSubmit={submit}>
            <AnchorInput
              draft={draft}
              onChange={(patch) => setDraft((d) => (d === null ? d : { ...d, ...patch }))}
              recent={[]}
              onPickRecent={() => undefined}
              invalid={anchorError !== null}
              describedBy={anchorError !== null ? "modify-anchor-error" : undefined}
            />
            {anchorError !== null ? (
              <div className="search__error" id="modify-anchor-error">
                <span className="label label--blocked">anchor_not_found</span>
                <p className="prose">{anchorError}</p>
              </div>
            ) : null}
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? "Searching…" : "Find the replacement"}
            </button>
          </form>
          <Link to={tripHref} className="btn-text">
            Keep the current booking
          </Link>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- steps 2–3

type QuotePhase =
  | { readonly k: "loading" }
  | {
      readonly k: "ready";
      readonly booking: Booking;
      readonly ranked: RankedOffer | null;
      readonly quote: ModifyQuote;
    }
  | { readonly k: "refused"; readonly code: string; readonly message: string }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

type ModifyAttempt =
  | { readonly k: "idle" }
  | { readonly k: "submitting" }
  | { readonly k: "drift"; readonly detail: PriceDriftDetail }
  | { readonly k: "sold_out"; readonly message: string }
  | { readonly k: "declined"; readonly declineCode: string | null; readonly message: string }
  | { readonly k: "unavailable"; readonly message: string }
  | { readonly k: "warned"; readonly result: ModifyResult }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

const REFUSALS = new Set(["outside_free_window", "not_confirmed", "modify_over_cap"]);

function ModifyQuoteStep({
  bookingId,
  searchId,
  offerId,
}: {
  readonly bookingId: string;
  readonly searchId: string;
  readonly offerId: string;
}): JSX.Element {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<QuotePhase>({ k: "loading" });
  const [attempt, setAttempt] = useState<ModifyAttempt>({ k: "idle" });
  const [accepted, setAccepted] = useState<Money | null>(null);
  const keyRef = useRef<{ readonly key: string; readonly sig: string } | null>(null);

  useEffect(() => {
    let live = true;
    setPhase({ k: "loading" });
    void Promise.allSettled([
      getBooking(bookingId),
      getSearch(searchId),
      quoteModify(bookingId, { searchId, offerId }),
    ]).then(([b, s, q]) => {
      if (!live) return;
      if (q.status === "rejected") {
        const err: unknown = q.reason;
        if (isApiError(err) && REFUSALS.has(err.code)) {
          setPhase({ k: "refused", code: err.code, message: err.message });
        } else {
          setPhase({
            k: "fault",
            code: isApiError(err) ? err.code : "unexpected_error",
            message: messageOf(err),
          });
        }
        return;
      }
      if (b.status === "rejected") {
        const err: unknown = b.reason;
        setPhase({
          k: "fault",
          code: isApiError(err) ? err.code : "unexpected_error",
          message: messageOf(err),
        });
        return;
      }
      const ranked =
        s.status === "fulfilled"
          ? s.value.results.find((r) => r.offer.rate.id === offerId) ?? null
          : null;
      setAccepted(q.value.quote.newTotal);
      setPhase({ k: "ready", booking: b.value.booking, ranked, quote: q.value.quote });
    });
    return () => {
      live = false;
    };
  }, [bookingId, searchId, offerId]);

  const submit = useCallback(
    async (total: Money): Promise<void> => {
      const body = { searchId, offerId, acceptedNewTotal: total };
      const sig = JSON.stringify(body);
      if (keyRef.current === null || keyRef.current.sig !== sig) {
        keyRef.current = { key: newIdempotencyKey(), sig };
      }
      setAttempt({ k: "submitting" });
      try {
        const res = await modifyBooking(bookingId, body, keyRef.current.key);
        if (res.warnings.length === 0) {
          navigate(`/trip/${encodeURIComponent(res.booking.id)}`, {
            replace: true,
            state: { modifiedFrom: res.replaced.confirmationCode },
          });
          return;
        }
        setAttempt({ k: "warned", result: res });
      } catch (err) {
        if (!isApiError(err)) {
          setAttempt({ k: "fault", code: "unexpected_error", message: messageOf(err) });
          return;
        }
        if (err.status === 409 && err.code === "price_drift") {
          const detail = asPriceDrift(err.detail);
          if (detail !== null) {
            setAttempt({ k: "drift", detail });
            return;
          }
        }
        if (err.status === 410 && err.code === "sold_out") {
          setAttempt({ k: "sold_out", message: err.message });
          return;
        }
        if (err.status === 402) {
          setAttempt({ k: "declined", declineCode: asDeclineCode(err.detail), message: err.message });
          return;
        }
        if (err.status === 503 || err.status === 0) {
          setAttempt({ k: "unavailable", message: err.message });
          return;
        }
        setAttempt({ k: "fault", code: err.code, message: err.message });
      }
    },
    [bookingId, navigate, offerId, searchId],
  );

  const tripHref = `/trip/${encodeURIComponent(bookingId)}`;
  const resultsHref = `/results/${encodeURIComponent(searchId)}?modify=${encodeURIComponent(bookingId)}`;

  if (phase.k === "loading") {
    return (
      <div className="screen">
        <h1 className="h1">Confirm the change</h1>
        <p className="mono mono--muted">pricing the change&hellip;</p>
      </div>
    );
  }

  if (phase.k === "refused") {
    const overCap = phase.code === "modify_over_cap";
    return (
      <div className="screen">
        <h1 className="h1">
          {overCap
            ? "This change needs approval"
            : phase.code === "outside_free_window"
              ? "This booking can no longer be changed here"
              : "Only a confirmed booking can be changed"}
        </h1>
        <Notice tone={overCap ? "over" : "blocked"} code={phase.code}>
          <p className="prose">{phase.message}</p>
          {overCap ? (
            <p className="prose prose--quiet">
              A change can only move to an in-policy rate. An over-cap stay is a new request:
              it goes to your approver, and your current booking stays exactly as it is.
            </p>
          ) : null}
          <div className="notice__actions">
            {overCap ? (
              <Link
                to={`/confirm/${encodeURIComponent(searchId)}/${encodeURIComponent(offerId)}`}
                className="btn"
              >
                Request approval for it instead
              </Link>
            ) : null}
            <Link to={resultsHref} className="btn">
              Back to results
            </Link>
            <Link to={tripHref} className="btn">
              Keep the current booking
            </Link>
          </div>
        </Notice>
      </div>
    );
  }

  if (phase.k === "fault") {
    return (
      <div className="screen">
        <h1 className="h1">Confirm the change</h1>
        <Notice tone="blocked" code={phase.code} title="We could not price that change">
          <p className="prose">{phase.message}</p>
          <div className="notice__actions">
            <Link to={`${tripHref}/modify`} className="btn">
              Search again
            </Link>
            <Link to={tripHref} className="btn">
              Keep the current booking
            </Link>
          </div>
        </Notice>
      </div>
    );
  }

  const { booking, ranked, quote } = phase;
  const shown = accepted ?? quote.newTotal;
  const submitting = attempt.k === "submitting";
  const suppressPrimary =
    attempt.k === "warned" || attempt.k === "sold_out" || attempt.k === "drift";
  const cancelFree = quote.cancellationCost.minor === 0;

  return (
    <div className="confirm">
      <div className="screen__head">
        <h1 className="h1">Confirm the change</h1>
        <p className="mono mono--muted">
          replaces {booking.confirmationCode} &middot; {booking.offer.property.name}
        </p>
      </div>

      {ranked !== null ? (
        <div className="confirm__property">
          <h2 className="confirm__name">{ranked.offer.property.name}</h2>
          <p className="confirm__addr">{ranked.offer.property.addressLine}</p>
        </div>
      ) : null}

      <section className="quote-rows" aria-label="What the change costs">
        <div className="kv">
          <div className="kv__row">
            <span className="kv__key">current booking</span>
            <span className="kv__val">{formatMoney(quote.currentTotal)}</span>
          </div>
          <div className="kv__row">
            <span className="kv__key">new stay</span>
            <span className="kv__val">
              {formatMoney(shown)}
              {ranked !== null ? (
                <>
                  {" "}
                  <FxEquivalent conversion={ranked.display} />
                </>
              ) : null}
            </span>
          </div>
          <div className="kv__row">
            <span className="kv__key">difference</span>
            <span className="kv__val quote-rows__delta">
              {quote.delta !== null
                ? formatSignedMoney(quote.delta)
                : "different currencies · compare the totals"}
            </span>
          </div>
          <div className="kv__row">
            <span className="kv__key">cancelling the current stay</span>
            <span className="kv__val">
              {formatMoney(quote.cancellationCost)}
              {cancelFree ? " · inside the free window" : ""}
            </span>
          </div>
        </div>
        <p className="quote-rows__message">{quote.message}</p>
      </section>

      <div className="confirm__facts">
        <VerdictChip verdict={quote.verdict} />
        <span className="mono">{quote.verdict.reason}</span>
      </div>

      {ranked !== null ? (
        <TotalBlock rate={ranked.offer.rate} label="New all-in total" flat display={ranked.display} />
      ) : null}

      <div className="confirm__decided">
        {ranked !== null ? (
          <DecidedLine
            label="New dates"
            value={`${formatDateRange(ranked.offer.rate.checkIn, ranked.offer.rate.checkOut)} · ${plural(ranked.offer.rate.nights, "night")}`}
          />
        ) : null}
        <DecidedLine
          label="Order"
          value={`new stay booked first · then ${booking.confirmationCode} is cancelled`}
        />
        <DecidedLine label="Payment" value="a new single-use virtual card for the new stay" />
      </div>

      {attempt.k === "warned" ? (
        <Notice tone="over" code="201 · with warnings" title="The change went through, with something to check">
          <ul className="warnings">
            {attempt.result.warnings.map((w, i) => (
              <li key={`${i}-${w}`} className="prose">
                {w}
              </li>
            ))}
          </ul>
          <p className="mono mono--muted">
            new {attempt.result.booking.confirmationCode} &middot; {attempt.result.booking.state}{" "}
            &middot; old {attempt.result.replaced.confirmationCode} &middot;{" "}
            {attempt.result.replaced.state}
          </p>
          <div className="notice__actions">
            <Link to={`/trip/${encodeURIComponent(attempt.result.booking.id)}`} className="btn">
              Open the new booking
            </Link>
            <Link to={`/trip/${encodeURIComponent(attempt.result.replaced.id)}`} className="btn">
              Open the old booking
            </Link>
          </div>
        </Notice>
      ) : null}

      {attempt.k === "drift" ? (
        <Notice tone="over" code="409 price_drift" title="The new stay re-priced">
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
            <p className="prose">
              Nothing changed. Your current booking is untouched.
            </p>
            <div className="notice__actions">
              <button
                type="button"
                className="btn"
                disabled={submitting}
                onClick={() => {
                  setAccepted(attempt.detail.currentTotal);
                  void submit(attempt.detail.currentTotal);
                }}
              >
                Change at the new price
              </button>
              <Link to={resultsHref} className="btn">
                Back to results
              </Link>
            </div>
          </div>
        </Notice>
      ) : null}

      {attempt.k === "sold_out" ? (
        <Notice tone="blocked" code="410 sold_out" title="The new stay sold out">
          <p className="prose">{attempt.message}</p>
          <p className="prose prose--quiet">Nothing changed. Your current booking is untouched.</p>
          <div className="notice__actions">
            <Link to={resultsHref} className="btn">
              Back to results
            </Link>
          </div>
        </Notice>
      ) : null}

      {attempt.k === "declined" ? (
        <Notice tone="blocked" code="402 card_declined" title="The new card was declined">
          <p className="prose">{attempt.message}</p>
          {attempt.declineCode !== null ? (
            <p className="mono mono--muted">decline code {attempt.declineCode}</p>
          ) : null}
          <p className="prose prose--quiet">
            Nothing changed and nothing is charged. Retrying reuses the same request.
          </p>
        </Notice>
      ) : null}

      {attempt.k === "unavailable" ? (
        <Notice tone="over" code="503 source_unavailable" title="The source did not answer">
          <p className="prose">{attempt.message}</p>
          <p className="prose prose--quiet">
            Retrying reuses the same request, so a change that did land is shown rather than
            made twice.
          </p>
        </Notice>
      ) : null}

      {attempt.k === "fault" ? (
        <Notice tone="blocked" code={attempt.code} title="The change did not go through">
          <p className="prose">{attempt.message}</p>
          <p className="prose prose--quiet">Your current booking is untouched.</p>
        </Notice>
      ) : null}

      {suppressPrimary ? null : (
        <div className="confirm__action">
          <button
            type="button"
            className="btn btn--primary"
            disabled={submitting}
            onClick={() => void submit(shown)}
          >
            {submitting ? "Changing…" : `Change to this stay · ${formatMoney(shown)}`}
          </button>
          <Link to={tripHref} className="btn-text confirm__keep">
            Keep the current booking
          </Link>
        </div>
      )}
    </div>
  );
}
