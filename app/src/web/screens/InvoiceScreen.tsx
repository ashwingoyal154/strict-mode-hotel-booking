/**
 * Invoice — the one screen that looks like paper.
 *
 * A single ruled column at `--measure` width, set in tabular machine voice. The
 * number, the GSTINs and the place of supply (by state name) sit at the top, then
 * the line table, then the totals, then one sentence on input tax credit stated as
 * a verdict with its reason. Every figure is the server's Money, rendered with its
 * paise; nothing is summed here.
 *
 * `@media print` hides the app shell, the demo bar and this screen's own controls,
 * and prints the light palette whatever the theme.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Invoice, InvoiceLine, InvoiceParty, IsoDateTime, Money } from "../../core/types.ts";
import { asInvoiceNotReady, getInvoice, isApiError, messageOf } from "../lib/api.ts";
import { formatDeadline, formatMoney, formatPercent, formatStamp, sentenceTail, stateLabel } from "../lib/fmt.ts";
import { Notice } from "../components/Notice.tsx";

type Phase =
  | { readonly k: "loading" }
  | { readonly k: "ready"; readonly invoice: Invoice }
  | { readonly k: "later"; readonly availableAfter: IsoDateTime; readonly message: string | null }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

const money = (m: Money | null): string => (m === null ? "–" : formatMoney(m, { decimals: true }));

function Party({ role, party }: { readonly role: string; readonly party: InvoiceParty }): JSX.Element {
  return (
    <div className="invoice__party">
      <span className="label">{role}</span>
      <span className="invoice__party-name">{party.name}</span>
      <span>GSTIN {party.gstin ?? "–"}</span>
      <span>{stateLabel(party.stateCode)}</span>
      <p className="invoice__addr">{party.address}</p>
    </div>
  );
}

export function InvoiceScreen(): JSX.Element {
  const { bookingId = "" } = useParams<{ bookingId: string }>();
  const [phase, setPhase] = useState<Phase>({ k: "loading" });

  useEffect(() => {
    let live = true;
    void getInvoice(bookingId)
      .then((res) => {
        if (live) setPhase({ k: "ready", invoice: res.invoice });
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (isApiError(err) && err.code === "invoice_not_ready") {
          const detail = asInvoiceNotReady(err.detail);
          if (detail !== null) {
            setPhase({ k: "later", availableAfter: detail.availableAfter, message: detail.message });
            return;
          }
        }
        setPhase({
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

  if (phase.k !== "ready") {
    return (
      <div className="screen">
        <h1 className="h1">Invoice</h1>
        {phase.k === "loading" ? <p className="mono mono--muted">loading the invoice&hellip;</p> : null}
        {phase.k === "later" ? (
          <Notice tone="neutral" code="invoice_not_ready" title="Available after checkout">
            <p className="mono">available after {formatDeadline(phase.availableAfter)}</p>
            {phase.message !== null ? <p className="prose">{phase.message}</p> : null}
            <p className="prose prose--quiet">
              The hotel&rsquo;s tax invoice is issued once the stay is settled, because only
              then is the final amount a fact.
            </p>
          </Notice>
        ) : null}
        {phase.k === "fault" ? (
          <Notice tone="blocked" code={phase.code} title="We could not open the invoice">
            <p className="prose">{phase.message}</p>
          </Notice>
        ) : null}
        <Link to={tripHref} className="btn-text">
          Back to the trip
        </Link>
      </div>
    );
  }

  const { invoice } = phase;
  const gst = invoice.kind === "gst_tax_invoice";
  const lines: readonly InvoiceLine[] = invoice.lines;
  const hasIgst = lines.some((l) => l.igst !== null);
  const hasOther = lines.some((l) => l.otherTax !== null);
  const hasCgst = lines.some((l) => l.cgst !== null || l.sgst !== null) || gst;

  return (
    <div className="invoice-screen">
      <div className="invoice__bar no-print">
        <Link to={tripHref} className="btn-text">
          Back to the trip
        </Link>
        <button type="button" className="btn" onClick={() => window.print()}>
          Print
        </button>
      </div>

      <article className="invoice" aria-labelledby="invoice-title">
        <header className="invoice__head">
          <span className="label">{gst ? "GST · rule 46" : "Not a GST document"}</span>
          <h1 className="invoice__title" id="invoice-title">
            {gst ? "Tax invoice" : "Tax summary"}
          </h1>
          <div className="invoice__meta">
            <div className="invoice__meta-row">
              <span className="label">Number</span>
              <span className="invoice__number">{invoice.number}</span>
            </div>
            <div className="invoice__meta-row">
              <span className="label">Financial year</span>
              <span>{invoice.financialYear}</span>
            </div>
            <div className="invoice__meta-row">
              <span className="label">Issued</span>
              <span>{formatStamp(invoice.issuedAt)}</span>
            </div>
            <div className="invoice__meta-row">
              <span className="label">Place of supply</span>
              <span>{stateLabel(invoice.placeOfSupply)}</span>
            </div>
          </div>
        </header>

        <section className="invoice__parties" aria-label="Parties">
          <Party role="Supplier" party={invoice.supplier} />
          <Party role="Recipient" party={invoice.recipient} />
        </section>

        <div className="invoice__table-wrap">
          <table className="table invoice__table">
            <thead>
              <tr>
                <th scope="col">Description</th>
                <th scope="col">SAC</th>
                <th scope="col" className="is-numeric">
                  Taxable
                </th>
                <th scope="col" className="is-numeric">
                  Rate
                </th>
                {hasCgst ? (
                  <>
                    <th scope="col" className="is-numeric">
                      CGST
                    </th>
                    <th scope="col" className="is-numeric">
                      SGST
                    </th>
                  </>
                ) : null}
                {hasIgst ? (
                  <th scope="col" className="is-numeric">
                    IGST
                  </th>
                ) : null}
                {hasOther ? (
                  <th scope="col" className="is-numeric">
                    Other tax
                  </th>
                ) : null}
                <th scope="col" className="is-numeric">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${i}-${l.description}`}>
                  <td className="invoice__desc">{l.description}</td>
                  <td>{l.sac ?? "–"}</td>
                  <td className="is-numeric">{money(l.taxableValue)}</td>
                  <td className="is-numeric">{formatPercent(l.taxRatePercent)}</td>
                  {hasCgst ? (
                    <>
                      <td className="is-numeric">{money(l.cgst)}</td>
                      <td className="is-numeric">{money(l.sgst)}</td>
                    </>
                  ) : null}
                  {hasIgst ? <td className="is-numeric">{money(l.igst)}</td> : null}
                  {hasOther ? <td className="is-numeric">{money(l.otherTax)}</td> : null}
                  <td className="is-numeric">{money(l.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="invoice__totals" aria-label="Totals">
          <div className="invoice__total-row">
            <span className="label">Taxable value</span>
            <span>{money(invoice.taxableTotal)}</span>
          </div>
          <div className="invoice__total-row">
            <span className="label">Tax</span>
            <span>{money(invoice.taxTotal)}</span>
          </div>
          <div className="invoice__total-row invoice__total-row--grand">
            <span className="label">Total</span>
            <span>{money(invoice.grandTotal)}</span>
          </div>
        </section>

        <p className="invoice__itc">
          <strong>{invoice.itc.claimable ? "ITC claimable" : "ITC not claimable"}</strong> &mdash;{" "}
          {sentenceTail(invoice.itc.reason)}
        </p>

        <p className="invoice__foot">
          {invoice.id} &middot; booking {invoice.bookingId}
        </p>
      </article>
    </div>
  );
}
