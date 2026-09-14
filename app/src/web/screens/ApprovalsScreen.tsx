/**
 * Approvals — decisions, not a dashboard.
 *
 * One card per pending request where the caller is in the chain, then a short
 * record of what was recently decided. No counts-as-hero, no charts: the only
 * number that leads is the arithmetic on each card.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalView } from "./admin/api.ts";
import { listApprovals } from "./admin/api.ts";
import { DecisionCard, slaClock } from "./admin/DecisionCard.tsx";
import { ApprovalStateChip, outcomeWord } from "./admin/chips.tsx";
import { firstName, formatClock } from "./admin/format.ts";
import { Loading, LoadFault, useLoad, useNow } from "./admin/useLoad.tsx";
import { Notice } from "../components/Notice.tsx";
import { formatMoney, plural } from "../lib/fmt.ts";
import "../design/admin.css";

const REFRESH_MS = 5 * 60_000;

async function loadDecided(): Promise<readonly ApprovalView[]> {
  const [approved, rejected] = await Promise.all([
    listApprovals("mine", "approved"),
    listApprovals("mine", "rejected"),
  ]);
  return [...approved.approvals, ...rejected.approvals]
    .sort((a, b) => Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt))
    .slice(0, 12);
}

export function ApprovalsScreen(): JSX.Element {
  const pending = useLoad(() => listApprovals("mine", "pending"), []);
  const decided = useLoad(loadDecided, []);
  const now = useNow(60_000);

  /** Cards decided on this page stay put, showing their outcome, across refreshes. */
  const [decidedHere, setDecidedHere] = useState<ReadonlyMap<string, { view: ApprovalView; fetchedAt: number }>>(
    new Map(),
  );
  const crossed = useRef<Set<string>>(new Set());

  const { reload: reloadPending } = pending;
  const { reload: reloadDecided } = decided;

  useEffect(() => {
    const id = window.setInterval(() => reloadPending(true), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [reloadPending]);

  // When a card's time runs out, re-read once: the server materialises the
  // escalation on read, so the ladder then shows the real next level.
  useEffect(() => {
    if (pending.load.k !== "ready") return;
    const { fetchedAt } = pending.load;
    const due = pending.load.data.approvals.filter(
      (v) => !v.sla.breached && slaClock(v, fetchedAt, now).tone === "breached" && !crossed.current.has(v.id),
    );
    if (due.length === 0) return;
    for (const v of due) crossed.current.add(v.id);
    reloadPending(true);
  }, [now, pending.load, reloadPending]);

  const onDecided = useCallback(
    (view: ApprovalView, fetchedAt: number) => (): void => {
      setDecidedHere((m) => new Map(m).set(view.id, { view, fetchedAt }));
      reloadDecided(true);
    },
    [reloadDecided],
  );

  return (
    <div className="appr">
      <div className="screen__head">
        <h1 className="h1">Approvals</h1>
        {pending.load.k === "ready" ? (
          <p className="mono mono--muted" role="status">
            {plural(pending.load.data.approvals.length, "request")} waiting · read at{" "}
            {formatClock(new Date(pending.load.fetchedAt).toISOString(), now)}
          </p>
        ) : null}
        <p className="prose">
          Each request is over its cap and cannot book without a yes. The traveller has said why; the clock is the
          rate they may lose while it waits.
        </p>
      </div>

      {pending.load.k === "loading" ? <Loading what="requests waiting on you" /> : null}

      {pending.load.k === "fault" ? (
        pending.load.status === 401 ? (
          <Notice tone="neutral" code="401 unauthenticated" title="Sign in to see approvals">
            <p className="prose">Your session has ended. Sign in again and this page will show what is waiting.</p>
          </Notice>
        ) : (
          <LoadFault {...pending.load} what="your approvals" onRetry={() => reloadPending()} />
        )
      ) : null}

      {pending.load.k === "ready" ? (
        <PendingList
          views={pending.load.data.approvals}
          fetchedAt={pending.load.fetchedAt}
          decidedHere={decidedHere}
          onDecided={onDecided}
          onStale={() => reloadPending(true)}
        />
      ) : null}

      <section className="appr__decided" aria-labelledby="appr-decided">
        <h2 className="h2" id="appr-decided">
          Decided
        </h2>
        {decided.load.k === "loading" ? <Loading what="recent decisions" /> : null}
        {decided.load.k === "fault" && decided.load.status !== 401 ? (
          <LoadFault {...decided.load} what="recent decisions" onRetry={() => reloadDecided()} />
        ) : null}
        {decided.load.k === "ready" ? <DecidedList views={decided.load.data} now={now} /> : null}
      </section>
    </div>
  );
}

function PendingList({
  views,
  fetchedAt,
  decidedHere,
  onDecided,
  onStale,
}: {
  readonly views: readonly ApprovalView[];
  readonly fetchedAt: number;
  readonly decidedHere: ReadonlyMap<string, { view: ApprovalView; fetchedAt: number }>;
  readonly onDecided: (view: ApprovalView, fetchedAt: number) => () => void;
  readonly onStale: () => void;
}): JSX.Element {
  const live = new Set(views.map((v) => v.id));
  const kept = [...decidedHere.values()].filter((d) => !live.has(d.view.id));
  const rows = [
    ...kept,
    ...views.map((view) => decidedHere.get(view.id) ?? { view, fetchedAt }),
  ];

  if (rows.length === 0) {
    return (
      <div className="empty">
        <p className="prose">
          Nothing is waiting on you. A request lands here when you are the approver for an over-cap stay, or when
          one escalates to you.
        </p>
      </div>
    );
  }

  return (
    <ul className="appr__list">
      {rows.map(({ view, fetchedAt: at }) => (
        <li key={view.id}>
          <DecisionCard
            view={view}
            fetchedAt={at}
            actions="both"
            onDecided={onDecided(view, at)}
            onStale={onStale}
          />
        </li>
      ))}
    </ul>
  );
}

function DecidedList({ views, now }: { readonly views: readonly ApprovalView[]; readonly now: number }): JSX.Element {
  if (views.length === 0) {
    return <p className="prose prose--quiet">Nothing decided yet. What you approve or reject will be listed here.</p>;
  }
  return (
    <ul className="decided-list">
      {views.map((v) => {
        const decider = v.approvers.find((a) => a.id === v.decidedBy)?.name ?? null;
        return (
          <li key={v.id} className="decided-row">
            <div className="decided-row__top">
              <ApprovalStateChip state={v.state} outcome={v.outcome} />
              <span className="decided-row__name">
                {v.traveller.name} · {v.booking.offer.property.name}
              </span>
            </div>
            <p className="mono mono--muted">
              {formatMoney(v.overageStay)} over · {v.state}
              {decider !== null ? ` by ${firstName(decider)}` : ""}
              {v.decidedAt !== null ? ` ${formatClock(v.decidedAt, now)}` : ""}
              {v.state === "approved" ? ` · ${outcomeWord(v.outcome)}` : ""}
            </p>
            {v.state === "rejected" && v.decisionNote !== null ? (
              <p className="decided-row__note">&ldquo;{v.decisionNote}&rdquo;</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
