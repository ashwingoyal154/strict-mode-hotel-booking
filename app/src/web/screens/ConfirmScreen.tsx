/**
 * Confirm — one number, one tap, no required input. Except over the cap.
 *
 * Guests, rooms, payment, the cancellation terms and the cost centre are all shown
 * as already decided. Only the cost centre carries an Edit, because it is the only
 * one of them the traveller legitimately owns.
 *
 * Over the cap, the screen is a request, and says so in words everywhere:
 *   · the heading is "Request approval" and the primary reads "Send for approval";
 *   · the verdict arithmetic is shown verbatim, with the verdict's own figures;
 *   · who will be asked, by when, and whether the rate can be held, before sending;
 *   · a justification — the company's reasons as square chips, plus a sentence of
 *     at least ten characters — because an approver will read it.
 *
 * Where the reasons come from. The frozen contract delivers them only in a
 * `422 justification_required`. This screen never sends a request the traveller did
 * not tap: a speculative POST on load could *book* if the policy changed between
 * search and confirm, which is exactly the consent failure this product exists to
 * prevent. So the reasons come, in order, from an earlier 422 in this browser
 * (remembered), the policy (admins can read it), or the 422 that the traveller's
 * first "Send for approval" produces — which reveals the chips with their sentence
 * kept.
 *
 * Idempotency:
 *   · One key per request body. A transient failure (402, 503, an unreachable
 *     server) retries the identical body and therefore the same key, so a booking
 *     the server may already have written can never be duplicated.
 *   · Anything that changes the body — the cost centre, a drifted price, the
 *     justification — changes the intent, and gets a fresh key.
 *
 * `acceptedTotal` is always a Money object handed over by the API verbatim — the
 * rate's own allInTotal, or the drift detail's currentTotal. It is never recomputed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  JustificationReason,
  Money,
  Policy,
  PolicyVerdict,
  PriceDriftDetail,
  RankedOffer,
  Traveller,
} from "../../core/types.ts";
import {
  asDeclineCode,
  asJustificationRequired,
  asPriceDrift,
  asVerdict,
  createBooking,
  getPolicy,
  getSearch,
  isApiError,
  messageOf,
  newIdempotencyKey,
  type CreateBookingBody,
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
import { ApprovalPreview } from "../components/ApprovalPreview.tsx";
import { DecidedLine } from "../components/DecidedLine.tsx";
import {
  JustificationForm,
  justificationReady,
} from "../components/JustificationForm.tsx";
import { Notice } from "../components/Notice.tsx";
import { TotalBlock } from "../components/TotalBlock.tsx";
import { VerdictChip, verdictVariant } from "../components/VerdictChip.tsx";

const REASONS_KEY = "verdict.justificationReasons";

function readCachedReasons(): readonly JustificationReason[] | null {
  try {
    const raw = window.localStorage.getItem(REASONS_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: JustificationReason[] = [];
    for (const r of parsed) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      const code = rec["code"];
      const label = rec["label"];
      if (typeof code === "string" && typeof label === "string") out.push({ code, label });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function writeCachedReasons(reasons: readonly JustificationReason[]): void {
  try {
    window.localStorage.setItem(REASONS_KEY, JSON.stringify(reasons));
  } catch {
    /* a convenience; the next 422 delivers them again */
  }
}

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
  | { readonly k: "no_approver"; readonly message: string }
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

  // ---- the over-cap request ----
  const [cachedReasons] = useState<readonly JustificationReason[] | null>(() => readCachedReasons());
  const [serverReasons, setServerReasons] = useState<readonly JustificationReason[] | null>(null);
  /** The server's own verdict, when a 422 or 403 carried one. It outranks the snapshot. */
  const [serverVerdict, setServerVerdict] = useState<PolicyVerdict | null>(null);
  /** A 422 said this rate needs a justification, whatever the snapshot said. */
  const [askedForJustification, setAskedForJustification] = useState(false);
  const [approverNames, setApproverNames] = useState<readonly string[]>([]);
  const [detailSla, setDetailSla] = useState<number | null>(null);
  const [justifyMessage, setJustifyMessage] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [text, setText] = useState("");

  const keyRef = useRef<{ readonly key: string; readonly sig: string } | null>(null);

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

  const policyReasons = policy?.approval?.justificationReasons;
  const reasons: readonly JustificationReason[] | null =
    serverReasons ??
    (policyReasons !== undefined && policyReasons.length > 0 ? policyReasons : null) ??
    cachedReasons;
  const slaMinutes = detailSla ?? policy?.approval?.slaMinutes ?? null;

  const submit = useCallback(
    async (total: Money, overCap: boolean): Promise<void> => {
      const body: CreateBookingBody =
        overCap && code !== null
          ? {
              searchId,
              offerId,
              costCentre,
              acceptedTotal: total,
              justification: { code, text: text.trim() },
            }
          : { searchId, offerId, costCentre, acceptedTotal: total };
      const sig = JSON.stringify(body);
      if (keyRef.current === null || keyRef.current.sig !== sig) {
        keyRef.current = { key: newIdempotencyKey(), sig };
      }
      const idempotencyKey = keyRef.current.key;

      setAttempt({ k: "submitting" });
      try {
        const res = await createBooking(body, idempotencyKey);
        const pending =
          res.booking.state === "pending_approval" ||
          (res.approval !== undefined && res.approval !== null);
        navigate(`/trip/${encodeURIComponent(res.booking.id)}`, {
          replace: true,
          state: pending
            ? { requested: true }
            : overCap
              ? { bookedWithoutApproval: true }
              : null,
        });
      } catch (err) {
        if (!isApiError(err)) {
          setAttempt({ k: "fault", code: "unexpected_error", message: messageOf(err) });
          return;
        }
        switch (err.status) {
          case 422: {
            const detail = err.code === "justification_required" ? asJustificationRequired(err.detail) : null;
            if (detail === null) {
              setAttempt({ k: "fault", code: err.code, message: err.message });
              return;
            }
            if (detail.reasons.length > 0) {
              setServerReasons(detail.reasons);
              writeCachedReasons(detail.reasons);
              if (code !== null && !detail.reasons.some((r) => r.code === code)) setCode(null);
            }
            if (detail.verdict !== null) setServerVerdict(detail.verdict);
            if (detail.approvers.length > 0) {
              setApproverNames(
                [...detail.approvers].sort((a, b) => a.level - b.level).map((a) => a.name),
              );
            }
            if (detail.slaMinutes !== null) setDetailSla(detail.slaMinutes);
            setAskedForJustification(true);
            setJustifyMessage(
              detail.message ??
                (code === null
                  ? "Pick the reason that fits, then send it."
                  : err.message),
            );
            setAttempt({ k: "idle" });
            return;
          }
          case 409: {
            if (err.code === "no_approver") {
              setAttempt({ k: "no_approver", message: err.message });
              return;
            }
            const detail = asPriceDrift(err.detail);
            if (detail === null) {
              setAttempt({ k: "fault", code: err.code, message: err.message });
              return;
            }
            setAttempt({ k: "drift", detail });
            return;
          }
          case 410:
            if (err.code === "sold_out") {
              setAttempt({ k: "sold_out", message: err.message });
            } else {
              setAttempt({ k: "fault", code: err.code, message: err.message });
            }
            return;
          case 403: {
            const verdict = asVerdict(err.detail);
            if (verdict !== null) setServerVerdict(verdict);
            setAttempt({ k: "blocked", verdict, message: err.message });
            return;
          }
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
    [code, costCentre, navigate, offerId, searchId, text],
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
  const { offer, commute } = ranked;
  const verdict = serverVerdict ?? ranked.verdict;
  const { property, rate } = offer;
  const nights = nightsBetween(rate.checkIn, rate.checkOut);
  const variant = verdictVariant(verdict);
  const overCap = variant === "over" || askedForJustification;
  const blockedByPolicy = variant === "blocked" && !askedForJustification;
  const submitting = attempt.k === "submitting";
  // One primary action, always. A drift panel carries its own explicit accept
  // action, and the stale total below it would be a second route to a 409.
  const suppressPrimary =
    attempt.k === "sold_out" ||
    attempt.k === "blocked" ||
    attempt.k === "drift" ||
    attempt.k === "no_approver";
  const shownTotal = acceptedTotal ?? rate.allInTotal;
  const ready = !overCap || justificationReady(reasons, code, text);

  const costCentres: readonly string[] = policy?.costCentres ?? [];
  const resultsHref = `/results/${encodeURIComponent(searchId)}`;
  const advisory = verdict.advisory ?? null;

  return (
    <div className="confirm">
      <div className="screen__head">
        <h1 className="h1">{overCap ? "Request approval" : "Confirm"}</h1>
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

      {overCap ? (
        <section className="arith" aria-label="Over-cap arithmetic">
          <div className="kv">
            <div className="kv__row">
              <span className="kv__key">rate per night</span>
              <span className="kv__val">{formatMoney(rate.perNight)}</span>
            </div>
            {verdict.capPerNight !== null ? (
              <div className="kv__row">
                <span className="kv__key">your cap per night</span>
                <span className="kv__val">{formatMoney(verdict.capPerNight)}</span>
              </div>
            ) : null}
            {verdict.overage !== undefined && verdict.overage !== null ? (
              <div className="kv__row">
                <span className="kv__key">over per night</span>
                <span className="kv__val arith__over">{formatMoney(verdict.overage)}</span>
              </div>
            ) : null}
            <div className="kv__row">
              <span className="kv__key">policy</span>
              <span className="kv__val">version {verdict.policyVersion}</span>
            </div>
          </div>
          <p className="prose">
            This rate is over your cap, so it is a request, not a booking. Nothing is booked
            and no card is issued until an approver says yes.
          </p>
        </section>
      ) : null}

      {advisory !== null ? (
        <Notice
          tone={advisory.level === "high" ? "blocked" : "over"}
          code={`advisory · ${advisory.level}`}
          title={`Travel advisory for ${advisory.city ?? advisory.countryCode}`}
        >
          <p className="prose">{advisory.note}</p>
        </Notice>
      ) : null}

      <TotalBlock rate={rate} display={ranked.display} />

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
          value={
            overCap
              ? "single-use virtual card, issued only once approved"
              : "single-use virtual card, issued at confirmation"
          }
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
                  onChange={(e) => setCostCentre(e.target.value)}
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
                  onChange={(e) => setCostCentre(e.target.value.toUpperCase())}
                />
              )}
              <button type="button" className="btn-text" onClick={close}>
                Done
              </button>
            </>
          )}
        />
      </div>

      {overCap ? (
        <>
          <ApprovalPreview
            approverNames={approverNames}
            slaMinutes={slaMinutes}
            holdable={rate.holdable}
            serverMessage={null}
          />
          <JustificationForm
            reasons={reasons}
            code={code}
            onCode={setCode}
            text={text}
            onText={setText}
            serverMessage={justifyMessage}
            disabled={submitting}
          />
        </>
      ) : null}

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
              Nothing has been {overCap ? "requested" : "booked"}. We will not accept the new
              price for you &mdash; {overCap ? "send it" : "confirm it"} yourself, or go back and
              pick something else.
            </p>
            <div className="notice__actions">
              <button
                type="button"
                className="btn"
                disabled={submitting || !ready}
                onClick={() => {
                  setAcceptedTotal(attempt.detail.currentTotal);
                  void submit(attempt.detail.currentTotal, overCap);
                }}
              >
                {overCap ? "Send for approval at the new price" : "Confirm at the new price"}
              </button>
              <Link to={resultsHref} className="btn">
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
            No booking was made, no request was sent and no card was issued.
          </p>
          <div className="notice__actions">
            <Link to={resultsHref} className="btn">
              Back to results
            </Link>
          </div>
        </Notice>
      ) : null}

      {attempt.k === "blocked" ? (
        <Notice tone="blocked" code="403 blocked_by_policy" title="Your policy refuses this rate">
          <p className="mono">{attempt.verdict?.reason ?? attempt.message}</p>
          {attempt.verdict !== null ? (
            <p className="mono mono--muted">policy version {attempt.verdict.policyVersion}</p>
          ) : null}
          <p className="prose prose--quiet">
            Blocked is not over cap: no approver can say yes to it.
          </p>
          <div className="notice__actions">
            <Link to={resultsHref} className="btn">
              Back to results
            </Link>
          </div>
        </Notice>
      ) : null}

      {attempt.k === "no_approver" ? (
        <Notice tone="blocked" code="409 no_approver" title="There is nobody to ask">
          <p className="prose">{attempt.message}</p>
          <p className="prose prose--quiet">
            Your company directory has no manager or fallback approver for you, so this
            request cannot be sent. Nothing was booked. Your travel admin can fix the
            directory; meanwhile an in-policy rate books straight away.
          </p>
          <div className="notice__actions">
            <Link to={resultsHref} className="btn">
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
              onClick={() => void submit(shownTotal, overCap)}
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
            Nothing was booked. Retrying reuses the same request, so if it did land we will
            show you that one rather than make a second.
          </p>
          <div className="notice__actions">
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => void submit(shownTotal, overCap)}
            >
              Try again
            </button>
            <Link to={resultsHref} className="btn">
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
              onClick={() => void submit(shownTotal, overCap)}
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
            <Link to={resultsHref} className="btn">
              Back to results
            </Link>
          </div>
        </Notice>
      ) : suppressPrimary ? null : (
        <div className="confirm__action">
          <button
            type="button"
            className="btn btn--primary"
            disabled={submitting || !ready}
            onClick={() => void submit(shownTotal, overCap)}
          >
            {overCap
              ? submitting
                ? "Sending…"
                : "Send for approval"
              : submitting
                ? "Confirming…"
                : `Confirm · ${formatMoney(shownTotal)}`}
          </button>
          <p className="confirm__footnote">
            {overCap
              ? "Nothing is booked and no card is issued until it is approved."
              : "Billed to your company. You pay nothing and file nothing."}
          </p>
        </div>
      )}
    </div>
  );
}
