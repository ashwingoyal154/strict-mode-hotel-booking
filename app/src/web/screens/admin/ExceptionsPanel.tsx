/**
 * Exceptions — every over-cap request, with the traveller's reason, the decision
 * and its note, what happened to the booking, and whether the request sat
 * unanswered at the top of the chain.
 */

import { useId, useState } from "react";
import type { ApprovalState } from "../../../core/types.ts";
import { formatDateRange, formatMoney, formatStamp, plural } from "../../lib/fmt.ts";
import { listExceptions, type ApprovalView } from "./api.ts";
import { ApprovalStateChip, Chip, outcomeWord } from "./chips.tsx";
import { Loading, LoadFault, useLoad } from "./useLoad.tsx";

type Filter = ApprovalState | "all";

const FILTERS: readonly { readonly value: Filter; readonly label: string }[] = [
  { value: "all", label: "all states" },
  { value: "pending", label: "pending" },
  { value: "approved", label: "approved" },
  { value: "rejected", label: "rejected" },
  { value: "withdrawn", label: "withdrawn" },
];

export function ExceptionsPanel(): JSX.Element {
  const [filter, setFilter] = useState<Filter>("all");
  const data = useLoad(() => listExceptions(filter === "all" ? null : filter), [filter]);
  const id = useId();

  return (
    <div className="apanel">
      <div className="apanel__head">
        <h2 className="h2">Exceptions</h2>
        <p className="prose prose--quiet">Every stay that went over cap, and what became of it.</p>
      </div>

      <div className="apanel__toolbar">
        <div className="afield afield--inline">
          <label className="afield__label" htmlFor={`${id}-state`}>
            Showing
          </label>
          <select
            id={`${id}-state`}
            className="aselect"
            value={filter}
            onChange={(e) => setFilter(FILTERS.find((f) => f.value === e.target.value)?.value ?? "all")}
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="btn-text" onClick={() => data.reload(true)}>
          Refresh
        </button>
      </div>

      {data.load.k === "loading" ? <Loading what="exceptions" /> : null}
      {data.load.k === "fault" ? <LoadFault {...data.load} what="exceptions" onRetry={() => data.reload()} /> : null}
      {data.load.k === "ready" ? <ExceptionsTable rows={data.load.data.approvals} filter={filter} /> : null}
    </div>
  );
}

function ExceptionsTable({
  rows,
  filter,
}: {
  readonly rows: readonly ApprovalView[];
  readonly filter: Filter;
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p className="prose">
          {filter === "all" ? "No stay has gone over cap yet." : `No over-cap requests are ${filter}.`}
        </p>
      </div>
    );
  }

  const sorted = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const breached = rows.filter((r) => r.slaBreachedAtTop).length;
  const notBooked = rows.filter((r) => r.outcome !== null && r.outcome !== "confirmed").length;

  return (
    <>
      <p className="mono mono--muted">
        {plural(rows.length, "request")} · {breached} breached at the top · {notBooked} approved but not booked
      </p>
      <div className="atable-wrap">
        <table className="atable">
          <caption className="sr-only">Over-cap approval requests</caption>
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col">Requested</th>
              <th scope="col">Traveller</th>
              <th scope="col">Stay</th>
              <th scope="col" className="num">
                Over cap
              </th>
              <th scope="col">Justification</th>
              <th scope="col">Decision</th>
              <th scope="col">Outcome</th>
              <th scope="col">SLA</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const decider = r.approvers.find((a) => a.id === r.decidedBy)?.name ?? r.decidedBy;
              const escalations = Math.max(0, r.levels.length - 1);
              const lost = r.outcome !== null && r.outcome !== "confirmed";
              return (
                <tr key={r.id} className={r.slaBreachedAtTop ? "stripe--blocked" : undefined}>
                  <td>
                    <ApprovalStateChip state={r.state} outcome={r.outcome} />
                  </td>
                  <td className="muted">{formatStamp(r.createdAt)}</td>
                  <td>
                    <span className="cell-main">{r.traveller.name}</span>
                    <span className="cell-sub">{r.traveller.email}</span>
                  </td>
                  <td>
                    <span className="cell-main">{r.booking.offer.property.name}</span>
                    <span className="cell-sub">
                      {r.booking.offer.property.city} ·{" "}
                      {formatDateRange(r.booking.offer.rate.checkIn, r.booking.offer.rate.checkOut)}
                    </span>
                  </td>
                  <td className="num">
                    <span className="cell-main">{formatMoney(r.overageStay)}</span>
                    <span className="cell-sub">{formatMoney(r.overagePerNight)}/night</span>
                  </td>
                  <td className="wrap">
                    <span className="cell-sub">{r.justificationCode.replace(/_/g, " ")}</span>
                    <span className="cell-quote">&ldquo;{r.justificationText}&rdquo;</span>
                  </td>
                  <td className="wrap">
                    {r.state === "pending" ? (
                      <span className="cell-sub">with {r.sla.approverName}</span>
                    ) : r.state === "withdrawn" ? (
                      <span className="cell-sub">withdrawn by the traveller</span>
                    ) : (
                      <>
                        <span className="cell-main">
                          {r.state} by {decider ?? "unknown"}
                        </span>
                        {r.decidedAt !== null ? <span className="cell-sub">{formatStamp(r.decidedAt)}</span> : null}
                        {r.decisionNote !== null ? (
                          <span className="cell-quote">&ldquo;{r.decisionNote}&rdquo;</span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className={lost ? "tone-over" : undefined}>{outcomeWord(r.outcome)}</td>
                  <td>
                    {r.slaBreachedAtTop ? (
                      <Chip tone="blocked">Breached at top</Chip>
                    ) : (
                      <span className="cell-main">not breached at top</span>
                    )}
                    <span className="cell-sub">
                      {escalations === 0 ? "no escalation" : `escalated ×${escalations}`}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
