/**
 * The decision card. One over-cap request, everything an approver needs to say
 * yes or no, and nothing else. The inbox and the one-tap page render this same
 * card; the one-tap page simply offers only the action its token was issued for.
 *
 * - The verdict arithmetic is the stored `verdict.reason`, verbatim.
 * - The justification is quoted in serif, because a traveller wrote it.
 * - The SLA line and the escalation ladder are the clock, in machine voice.
 * - After a decision the outcome is stated honestly: an approval can win and the
 *   rate still be lost, and that is an outcome, not an error.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Booking, Money } from "../../../core/types.ts";
import { VerdictChip } from "../../components/VerdictChip.tsx";
import { Notice } from "../../components/Notice.tsx";
import { isApiError, messageOf } from "../../lib/api.ts";
import { formatDateRange, formatMoney, formatStamp, plural } from "../../lib/fmt.ts";
import { decide, type ApprovalView, type Decision, type DecisionResult } from "./api.ts";
import { firstName, formatClock, formatMonth, formatSpan } from "./format.ts";
import { useNow } from "./useLoad.tsx";

// ---------- the clock ----------

export interface SlaClock {
  readonly remainingMs: number;
  /** 1 = the whole window left, 0 = none. */
  readonly fraction: number;
  readonly tone: "calm" | "soon" | "breached";
}

/**
 * Remaining time is measured from the server's `remainingMs` at fetch time, not
 * from `dueAt` against the browser clock, so a skewed laptop clock cannot make a
 * request look more or less urgent than it is.
 */
export function slaClock(view: ApprovalView, fetchedAt: number, now: number): SlaClock {
  const remainingMs = view.sla.remainingMs - Math.max(0, now - fetchedAt);
  const current = view.levels[view.levels.length - 1];
  const start = current === undefined ? Number.NaN : Date.parse(current.startedAt);
  const due = Date.parse(view.sla.dueAt);
  const windowMs =
    Number.isFinite(start) && Number.isFinite(due) && due > start ? due - start : view.slaMinutes * 60_000;
  const fraction = windowMs > 0 ? Math.min(1, Math.max(0, remainingMs / windowMs)) : 0;
  const breached = view.sla.breached || remainingMs <= 0;
  return { remainingMs, fraction, tone: breached ? "breached" : fraction <= 0.25 ? "soon" : "calm" };
}

export function SlaLine({
  view,
  fetchedAt,
  now,
}: {
  readonly view: ApprovalView;
  readonly fetchedAt: number;
  readonly now: number;
}): JSX.Element {
  const clock = slaClock(view, fetchedAt, now);
  const due = formatClock(view.sla.dueAt, now);
  const breached = clock.tone === "breached";
  const after = breached
    ? view.sla.atTop
      ? " · top of the chain"
      : view.sla.nextApproverName !== null
        ? ` · escalates to ${view.sla.nextApproverName}`
        : ""
    : "";

  return (
    <div className={`sla sla--${clock.tone}`}>
      <p className="sla__line">
        <span className="sla__who">{view.sla.approverName}</span>
        {breached ? ` · was due ${due} · ${formatSpan(clock.remainingMs)} overdue` : ` · decides by ${due} · ${formatSpan(clock.remainingMs)} left`}
        {after}
        {clock.tone === "soon" ? <span className="sr-only"> · less than a quarter of the time is left</span> : null}
      </p>
      <div className="sla__track" aria-hidden="true">
        <span className="sla__fill" style={{ transform: `scaleX(${clock.fraction})` }} />
      </div>
    </div>
  );
}

// ---------- the ladder ----------

export function EscalationLadder({ view, now }: { readonly view: ApprovalView; readonly now: number }): JSX.Element {
  const currentLevel = view.levels[view.levels.length - 1]?.level ?? view.sla.level;
  const approvers = [...view.approvers].sort((a, b) => a.level - b.level);
  const decided = view.state !== "pending";

  return (
    <div className="ladder-wrap">
      <span className="label">Escalation ladder</span>
      <ol className="ladder">
        {approvers.map((a) => {
          const own = view.levels.find((l) => l.level === a.level);
          const next = view.levels.find((l) => l.level === a.level + 1);
          const isDecider = decided && view.decidedBy === a.id;

          if (isDecider) {
            return (
              <li key={a.id} className="ladder__step ladder__step--current">
                <span className="ladder__lvl">L{a.level + 1}</span>
                <span className="ladder__name">{a.name}</span>
                <span className="ladder__when">
                  {view.state} {view.decidedAt !== null ? formatClock(view.decidedAt, now) : ""}
                </span>
              </li>
            );
          }

          if (a.level < currentLevel) {
            const passed = next?.startedAt ?? own?.dueAt ?? null;
            return (
              <li key={a.id} className="ladder__step ladder__step--past">
                <span className="ladder__lvl">L{a.level + 1}</span>
                <s className="ladder__name">{a.name}</s>
                <span className="ladder__when">
                  passed over{passed !== null ? ` ${formatClock(passed, now)}` : ""}
                </span>
              </li>
            );
          }

          if (a.level === currentLevel) {
            return (
              <li key={a.id} className="ladder__step ladder__step--current" aria-current="step">
                <span className="ladder__lvl">L{a.level + 1}</span>
                <span className="ladder__name">{a.name}</span>
                <span className="ladder__when">
                  {decided ? "current level" : `deciding · due ${formatClock(view.sla.dueAt, now)}`}
                </span>
              </li>
            );
          }

          return (
            <li key={a.id} className="ladder__step ladder__step--future">
              <span className="ladder__lvl">L{a.level + 1}</span>
              <span className="ladder__name">{a.name}</span>
              <span className="ladder__when">
                {a.level === currentLevel + 1 && !decided ? "next, if time runs out" : "later in the chain"}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------- the arithmetic ----------

function supplierTotal(b: Booking): Money {
  return b.amounts?.supplier ?? b.offer.rate.allInTotal;
}

function HoldLine({ booking }: { readonly booking: Booking }): JSX.Element | null {
  const hold = booking.hold;
  if (hold === null || hold === undefined) return null;
  if (hold.held) {
    return (
      <p className="dcard__hold">
        {hold.heldUntil !== null ? `Held until ${formatClock(hold.heldUntil)}` : "Held"} · the price above is
        guaranteed until then
      </p>
    );
  }
  return (
    <p className="dcard__hold dcard__hold--over">
      Not held · this hotel can&rsquo;t hold rates, so the price may move before approval
    </p>
  );
}

function Figures({ view }: { readonly view: ApprovalView }): JSX.Element {
  const b = view.booking;
  const total = supplierTotal(b);
  const display = b.amounts?.display;
  const converted = display !== undefined && display.fx !== null && display.to.currency !== total.currency;

  return (
    <div className="dcard__figures">
      <p className="dcard__reason">{view.verdict.reason}</p>
      <dl className="dcard__rows">
        <div className="dcard__row">
          <dt>over per night</dt>
          <dd>{formatMoney(view.overagePerNight)}</dd>
        </div>
        <div className="dcard__row">
          <dt>over for {plural(b.offer.rate.nights, "night")}</dt>
          <dd>{formatMoney(view.overageStay)}</dd>
        </div>
        <div className="dcard__row dcard__row--total">
          <dt>all-in total</dt>
          <dd>
            {formatMoney(total)}
            {converted && display !== undefined ? (
              <span className="dcard__approx">
                <span aria-hidden="true"> ≈ </span>
                <span className="sr-only"> approximately </span>
                {formatMoney(display.to)}
                {display.fx?.pinMonth != null ? ` · ${formatMonth(display.fx.pinMonth)} pinned rate` : ""}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      {view.state === "pending" ? <HoldLine booking={b} /> : null}
    </div>
  );
}

// ---------- the outcome ----------

export function DecisionOutcome({
  result,
  decision,
  before,
}: {
  readonly result: DecisionResult;
  readonly decision: Decision;
  readonly before: Booking;
}): JSX.Element {
  const { approval, booking } = result;
  const who = firstName(approval.traveller.name);
  const accepted = supplierTotal(before);

  if (decision === "reject" || approval.state === "rejected") {
    return (
      <Notice tone="neutral" code="rejected" title="Rejected">
        <p className="prose">Nothing was booked for {who}.</p>
        {approval.decisionNote !== null ? (
          <blockquote className="dcard__quote dcard__quote--small">
            <p>&ldquo;{approval.decisionNote}&rdquo;</p>
          </blockquote>
        ) : null}
      </Notice>
    );
  }

  const outcome = approval.outcome ?? (booking.state === "confirmed" ? "confirmed" : null);

  if (outcome === "confirmed") {
    return (
      <Notice tone="in" code="approved · confirmed" title="Approved and booked">
        <p className="mono">
          {booking.confirmationCode} · {formatMoney(supplierTotal(booking))}
          {booking.card !== null ? ` · card •••• ${booking.card.last4}` : ""}
        </p>
        <p className="prose">
          {who} is booked at {booking.offer.property.name}.
        </p>
      </Notice>
    );
  }

  if (outcome === "rate_lost") {
    const candidates = [booking.amounts?.supplier, booking.offer.rate.allInTotal];
    const moved = candidates.find(
      (m): m is Money => m !== undefined && m.currency === accepted.currency && m.minor !== accepted.minor,
    );
    return (
      <Notice tone="over" code="approved · rate_lost" title="Approved, but the rate moved">
        <p className="prose">
          {moved !== undefined
            ? `Approved — but the rate moved from ${formatMoney(accepted)} to ${formatMoney(moved)}. Nothing was booked.`
            : `Approved — but the rate moved away from ${formatMoney(accepted)} before it could be booked. Nothing was booked.`}
        </p>
        <dl className="dcard__rows">
          <div className="dcard__row">
            <dt>approved at</dt>
            <dd>{formatMoney(accepted)}</dd>
          </div>
          <div className="dcard__row">
            <dt>hotel now asks</dt>
            <dd>{moved !== undefined ? formatMoney(moved) : "not reported"}</dd>
          </div>
          <div className="dcard__row">
            <dt>card issued</dt>
            <dd>none</dd>
          </div>
        </dl>
      </Notice>
    );
  }

  if (outcome === "sold_out") {
    return (
      <Notice tone="over" code="approved · sold_out" title="Approved, but the room sold out">
        <p className="prose">
          Approved — but {booking.offer.property.name} sold out before it could be booked at{" "}
          {formatMoney(accepted)}. Nothing was booked.
        </p>
      </Notice>
    );
  }

  if (outcome === "card_declined") {
    return (
      <Notice tone="over" code="approved · card_declined" title="Approved, but no card could be issued">
        <p className="prose">
          Approved — but the card issuer declined to issue a card for {formatMoney(accepted)}. Nothing was
          booked and nothing was charged.
        </p>
      </Notice>
    );
  }

  return (
    <Notice tone="neutral" code={`approved · ${booking.state}`} title="Approved">
      <p className="prose">The decision was recorded. The booking is {booking.state.replace(/_/g, " ")}.</p>
    </Notice>
  );
}

// ---------- the card ----------

export type CardActions = "both" | "approve" | "reject";

type Act =
  | { readonly k: "idle" }
  | { readonly k: "rejecting" }
  | { readonly k: "busy"; readonly decision: Decision }
  | { readonly k: "done"; readonly decision: Decision; readonly result: DecisionResult }
  | {
      readonly k: "failed";
      readonly decision: Decision;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

interface DecisionCardProps {
  readonly view: ApprovalView;
  /** `Date.now()` when `view` was fetched; anchors the SLA countdown. */
  readonly fetchedAt: number;
  readonly actions: CardActions;
  readonly actionToken?: string;
  readonly onDecided?: (result: DecisionResult) => void;
  /** The request changed underneath the card (already decided, escalated past). */
  readonly onStale?: () => void;
  /** Heading level for the traveller's name. */
  readonly headingLevel?: 2 | 3;
}

export function DecisionCard({
  view,
  fetchedAt,
  actions,
  actionToken,
  onDecided,
  onStale,
  headingLevel = 2,
}: DecisionCardProps): JSX.Element {
  const now = useNow(60_000);
  const [act, setAct] = useState<Act>(actions === "reject" ? { k: "rejecting" } : { k: "idle" });
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();
  const titleId = useId();
  const b = view.booking;
  const p = b.offer.property;
  const H = headingLevel === 2 ? "h2" : "h3";

  useEffect(() => {
    if (act.k === "rejecting" && actions !== "reject") noteRef.current?.focus();
  }, [act.k, actions]);

  const submit = (decision: Decision): void => {
    if (decision === "reject" && note.trim().length === 0) {
      setNoteError("Write a note. The traveller reads it, so say what would change your answer.");
      noteRef.current?.focus();
      return;
    }
    setNoteError(null);
    setAct({ k: "busy", decision });
    void decide(view.id, decision, decision === "reject" ? note : null, actionToken)
      .then((result) => {
        setAct({ k: "done", decision, result });
        onDecided?.(result);
      })
      .catch((err: unknown) => {
        if (isApiError(err) && err.code === "note_required") {
          setAct({ k: "rejecting" });
          setNoteError(err.message);
          return;
        }
        setAct({
          k: "failed",
          decision,
          status: isApiError(err) ? err.status : 0,
          code: isApiError(err) ? err.code : "unexpected_error",
          message: messageOf(err),
        });
      });
  };

  const busy = act.k === "busy";
  const pending = view.state === "pending";

  return (
    <article className={`dcard${act.k === "done" ? " dcard--decided" : ""}`} aria-labelledby={titleId}>
      <header className="dcard__head">
        <div className="dcard__meta">
          <VerdictChip verdict={view.verdict} />
          <span className="mono mono--muted">requested {formatStamp(view.createdAt)}</span>
        </div>
        <H className="dcard__who" id={titleId}>
          {view.traveller.name}
        </H>
        <p className="mono mono--muted dcard__email">{view.traveller.email}</p>
      </header>

      <section className="dcard__stay" aria-label="The stay">
        <p className="dcard__hotel">{p.name}</p>
        <p className="dcard__addr">{p.addressLine}</p>
        <p className="mono mono--muted">
          {p.city} · {formatDateRange(b.offer.rate.checkIn, b.offer.rate.checkOut)} ·{" "}
          {plural(b.offer.rate.nights, "night")} · {b.costCentre}
        </p>
      </section>

      <Figures view={view} />

      <section className="dcard__why" aria-label="Justification">
        <span className="label">
          Why · <span className="dcard__code">{view.justificationCode.replace(/_/g, " ")}</span>
        </span>
        <blockquote className="dcard__quote">
          <p>&ldquo;{view.justificationText}&rdquo;</p>
        </blockquote>
        <p className="mono mono--muted">— {view.traveller.name}</p>
      </section>

      {pending && act.k !== "done" ? (
        <section className="dcard__clock" aria-label="Time to decide">
          <SlaLine view={view} fetchedAt={fetchedAt} now={now} />
          <EscalationLadder view={view} now={now} />
        </section>
      ) : null}

      {act.k === "done" ? (
        <DecisionOutcome result={act.result} decision={act.decision} before={b} />
      ) : null}

      {act.k === "failed" ? (
        <DecisionFailure
          failure={act}
          view={view}
          onRetry={() => setAct(act.decision === "reject" ? { k: "rejecting" } : { k: "idle" })}
          onStale={onStale}
        />
      ) : null}

      {pending && (act.k === "idle" || act.k === "rejecting" || act.k === "busy") ? (
        <div className="dcard__actions">
          {act.k === "rejecting" || (act.k === "busy" && act.decision === "reject") ? (
            <form
              className="dcard__reject"
              onSubmit={(e) => {
                e.preventDefault();
                submit("reject");
              }}
            >
              <label className="afield__label" htmlFor={noteId}>
                Why you are rejecting · required
              </label>
              <textarea
                ref={noteRef}
                id={noteId}
                className="atextarea"
                rows={3}
                value={note}
                required
                aria-required="true"
                aria-invalid={noteError !== null}
                aria-describedby={noteError !== null ? `${noteId}-err` : undefined}
                onChange={(e) => {
                  setNote(e.target.value);
                  if (noteError !== null && e.target.value.trim().length > 0) setNoteError(null);
                }}
                placeholder="The workshop can run from the Andheri office; the in-policy hotel is 12 minutes away."
                disabled={busy}
              />
              {noteError !== null ? (
                <p className="aerror" id={`${noteId}-err`} role="alert">
                  {noteError}
                </p>
              ) : null}
              <div className="dcard__buttons">
                <button
                  type="submit"
                  className="btn-quiet-danger"
                  disabled={busy || note.trim().length === 0}
                >
                  {busy ? "Rejecting…" : "Send rejection"}
                </button>
                {actions === "both" ? (
                  <button
                    type="button"
                    className="btn-text"
                    disabled={busy}
                    onClick={() => {
                      setNoteError(null);
                      setAct({ k: "idle" });
                    }}
                  >
                    Back
                  </button>
                ) : null}
              </div>
            </form>
          ) : (
            <div className="dcard__buttons">
              {actions !== "reject" ? (
                <button
                  type="button"
                  className="btn btn--primary dcard__approve"
                  disabled={busy}
                  onClick={() => submit("approve")}
                >
                  {busy ? "Approving · re-pricing with the hotel…" : "Approve"}
                </button>
              ) : null}
              {actions === "both" ? (
                <button type="button" className="btn-text" disabled={busy} onClick={() => setAct({ k: "rejecting" })}>
                  Reject
                </button>
              ) : null}
            </div>
          )}
          {busy ? (
            <p className="sr-only" role="status">
              {act.decision === "approve" ? "Approving, re-pricing with the hotel" : "Sending the rejection"}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function DecisionFailure({
  failure,
  view,
  onRetry,
  onStale,
}: {
  readonly failure: Extract<Act, { k: "failed" }>;
  readonly view: ApprovalView;
  readonly onRetry: () => void;
  readonly onStale: (() => void) | undefined;
}): JSX.Element {
  const code = failure.status === 0 ? failure.code : `${failure.status} ${failure.code}`;
  const refresh =
    onStale !== undefined ? (
      <button type="button" className="btn" onClick={onStale}>
        Refresh
      </button>
    ) : undefined;

  if (failure.code === "already_decided") {
    return (
      <Notice tone="neutral" code={code} title="Someone already decided this" actions={refresh}>
        <p className="prose">
          This request was decided before your answer arrived, so nothing you did here changed it.
        </p>
      </Notice>
    );
  }
  if (failure.code === "not_current_approver") {
    return (
      <Notice tone="neutral" code={code} title="This request has moved past you" actions={refresh}>
        <p className="prose">
          It escalated
          {view.sla.nextApproverName !== null ? ` to ${view.sla.nextApproverName}` : " to the next approver"} when
          the time ran out, so your decision was not recorded.
        </p>
      </Notice>
    );
  }
  if (failure.code === "invalid_action_token") {
    return (
      <Notice
        tone="neutral"
        code={code}
        title="This link can no longer decide"
        actions={
          <Link className="btn" to="/approvals">
            Open approvals
          </Link>
        }
      >
        <p className="prose">
          It expired, was already used, or was altered on the way. Nothing was recorded. You can still decide from
          your approvals.
        </p>
      </Notice>
    );
  }
  return (
    <Notice
      tone="blocked"
      code={code}
      title={failure.decision === "approve" ? "The approval did not go through" : "The rejection did not go through"}
      actions={
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      }
    >
      <p className="prose">{failure.message} Nothing was recorded.</p>
    </Notice>
  );
}
