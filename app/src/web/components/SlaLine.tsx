/**
 * SlaLine — `Meera Iyer · decides by 4:10 pm · 1h 42m left`, with one hairline
 * beneath it that empties as time passes.
 *
 * An approval is a race against a moving rate, so its clock is shown the same way
 * everywhere. The hairline turns `over` in the last 25% of the current level's
 * window and `blocked` once the SLA is breached, and the words change with it
 * ("overdue by 7m") so tone is never the only signal.
 *
 * It re-renders at most once a minute. The text is not a live region: a countdown
 * that announces itself every minute would be noise, and the page announces the
 * decision itself when polling brings it.
 */

import { useEffect, useState } from "react";
import type { ApprovalView } from "../lib/api.ts";
import { formatClock, formatRemaining } from "../lib/fmt.ts";

const TICK_MS = 60_000;

export type SlaTone = "neutral" | "over" | "blocked";

export function SlaLine({ approval }: { readonly approval: ApprovalView }): JSX.Element {
  const { sla } = approval;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [sla.dueAt]);

  const due = new Date(sla.dueAt).getTime();
  const current = approval.levels.find((l) => l.level === sla.level);
  const started = current === undefined ? Number.NaN : new Date(current.startedAt).getTime();

  const remaining = Number.isNaN(due) ? sla.remainingMs : due - now;
  const windowMs =
    Number.isNaN(due) || Number.isNaN(started) || due <= started
      ? approval.slaMinutes * 60_000
      : due - started;
  const breached = sla.breached || remaining <= 0;
  const fraction = breached ? 0 : Math.min(1, Math.max(0, remaining / windowMs));
  const tone: SlaTone = breached ? "blocked" : fraction <= 0.25 ? "over" : "neutral";

  const nowDate = new Date(now);
  const tail = breached
    ? sla.atTop
      ? "top of the chain"
      : sla.nextApproverName !== null
        ? `moves to ${sla.nextApproverName}`
        : null
    : null;

  return (
    <div className="sla" data-tone={tone}>
      <p className="sla__line">
        <span className="sla__who">{sla.approverName}</span>
        <span className="sla__sep" aria-hidden="true">
          &middot;
        </span>
        <span>
          {breached ? "was due" : "decides by"} {formatClock(sla.dueAt, nowDate)}
        </span>
        <span className="sla__sep" aria-hidden="true">
          &middot;
        </span>
        <span className="sla__left">{formatRemaining(remaining)}</span>
        {tail !== null ? (
          <>
            <span className="sla__sep" aria-hidden="true">
              &middot;
            </span>
            <span>{tail}</span>
          </>
        ) : null}
      </p>
      <div className="sla__track" aria-hidden="true">
        <span className="sla__fill" style={{ transform: `scaleX(${fraction})` }} />
      </div>
    </div>
  );
}
