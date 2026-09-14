/**
 * Metrics — quiet stat rows, not hero tiles. Each rate carries the counts it was
 * computed from, so a percentage is never an adjective without its arithmetic.
 */

import { plural } from "../../lib/fmt.ts";
import { getMetrics, type Metrics } from "./api.ts";
import { formatRatio } from "./format.ts";
import { Loading, LoadFault, useLoad } from "./useLoad.tsx";

function Stat({ k, v, sub }: { readonly k: string; readonly v: string; readonly sub?: string }): JSX.Element {
  return (
    <div className="stat">
      <dt className="stat__k">{k}</dt>
      <dd className="stat__v">
        {v}
        {sub !== undefined ? <span className="stat__sub">{sub}</span> : null}
      </dd>
    </div>
  );
}

export function MetricsPanel(): JSX.Element {
  const data = useLoad(getMetrics, []);

  return (
    <div className="apanel">
      <div className="apanel__head">
        <h2 className="h2">Metrics</h2>
        <p className="prose prose--quiet">How the policy is holding up across the whole entity.</p>
      </div>
      <div className="apanel__toolbar">
        <button type="button" className="btn-text" onClick={() => data.reload(true)}>
          Refresh
        </button>
      </div>
      {data.load.k === "loading" ? <Loading what="metrics" /> : null}
      {data.load.k === "fault" ? <LoadFault {...data.load} what="metrics" onRetry={() => data.reload()} /> : null}
      {data.load.k === "ready" ? <MetricRows m={data.load.data} /> : null}
    </div>
  );
}

function MetricRows({ m }: { readonly m: Metrics }): JSX.Element {
  const invoices =
    typeof m.invoices === "number"
      ? { v: String(m.invoices), sub: undefined }
      : {
          v: String(Object.values(m.invoices).reduce((a, b) => a + b, 0)),
          sub: Object.entries(m.invoices)
            .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
            .join(" · "),
        };

  return (
    <div className="stat-groups">
      <section className="stat-group" aria-label="Bookings">
        <h3 className="label">Bookings</h3>
        <dl className="stats">
          <Stat k="bookings" v={String(m.bookings)} sub={`${m.confirmed} confirmed`} />
          <Stat k="in-policy rate" v={formatRatio(m.inPolicyRate)} sub={`of ${plural(m.bookings, "booking")}`} />
        </dl>
      </section>

      <section className="stat-group" aria-label="Approvals">
        <h3 className="label">Approvals</h3>
        <dl className="stats">
          <Stat k="requests" v={String(m.approvals.total)} sub={`${m.approvals.pending} pending`} />
          <Stat
            k="within SLA"
            v={formatRatio(m.approvals.withinSlaRate)}
            sub={`of ${plural(m.approvals.total, "request")}`}
          />
          <Stat k="rate lost" v={formatRatio(m.approvals.rateLostRate)} sub="approved, but nothing was booked" />
        </dl>
      </section>

      <section className="stat-group" aria-label="Cards">
        <h3 className="label">Cards</h3>
        <dl className="stats">
          <Stat k="issued" v={String(m.cards.issued)} />
          <Stat
            k="decline rate"
            v={formatRatio(m.cards.declineRate)}
            sub={`${m.cards.issueDeclined} at issue · ${m.cards.deskDeclined} at the desk`}
          />
        </dl>
      </section>

      <section className="stat-group" aria-label="Invoices">
        <h3 className="label">Invoices</h3>
        <dl className="stats">
          <Stat k="invoices issued" v={invoices.v} {...(invoices.sub !== undefined ? { sub: invoices.sub } : {})} />
        </dl>
      </section>
    </div>
  );
}
