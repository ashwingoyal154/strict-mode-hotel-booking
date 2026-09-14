/**
 * FX pins — the corporate rate for each calendar month, which policy evaluation
 * uses so the same booking never gets different verdicts on different days.
 *
 * Rates are typed as decimals and converted to integer `rateMicros` by exact
 * string arithmetic. `parseFloat(x) * 1e6` is never used: 0.07 * 1e6 is not
 * 70000 in floating point.
 */

import { useId, useMemo, useRef, useState } from "react";
import type { FxRate, IsoMonth } from "../../../core/types.ts";
import { Notice } from "../../components/Notice.tsx";
import { isApiError, messageOf } from "../../lib/api.ts";
import { formatStamp, plural } from "../../lib/fmt.ts";
import { getFxPins, putFxPins, type FxPinInput } from "./api.ts";
import { Chip } from "./chips.tsx";
import { formatMonth, formatRate, formatScaled, isCurrencyCode, monthInKolkata, parseScaled } from "./format.ts";
import { Loading, LoadFault, useLoad } from "./useLoad.tsx";

interface Row {
  readonly key: string;
  readonly base: string;
  readonly quote: string;
  readonly rate: string;
  readonly original: FxRate | null;
}

function toRows(rates: readonly FxRate[]): Row[] {
  return rates.map((r, i) => ({
    key: `fx-${i}`,
    base: r.base,
    quote: r.quote,
    rate: formatScaled(r.rateMicros, 6, 2),
    original: r,
  }));
}

function signature(rows: readonly Row[]): string {
  return JSON.stringify(rows.map((r) => [r.base.trim().toUpperCase(), r.quote.trim().toUpperCase(), r.rate.trim()]));
}

function build(rows: readonly Row[]): { rates: FxPinInput[] | null; errors: Readonly<Record<string, string>> } {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  const rates = rows.map((r) => {
    const base = r.base.trim().toUpperCase();
    const quote = r.quote.trim().toUpperCase();
    if (!isCurrencyCode(base)) errors[`${r.key}-base`] = "Three letters, like GBP.";
    if (!isCurrencyCode(quote)) errors[`${r.key}-quote`] = "Three letters, like INR.";
    if (isCurrencyCode(base) && base === quote) errors[`${r.key}-quote`] = "A currency cannot be pinned to itself.";
    const pair = `${base}/${quote}`;
    if (seen.has(pair)) errors[`${r.key}-base`] = `${pair} is already pinned for this month.`;
    seen.add(pair);
    const parsed = parseScaled(r.rate, 6, "The rate");
    let rateMicros = 0;
    if (!parsed.ok) errors[`${r.key}-rate`] = parsed.error;
    else if (parsed.value <= 0) errors[`${r.key}-rate`] = "The rate must be more than zero.";
    else rateMicros = parsed.value;
    return { base, quote, rateMicros };
  });
  return { rates: Object.keys(errors).length === 0 ? rates : null, errors };
}

export function FxPanel(): JSX.Element {
  const [month, setMonth] = useState<IsoMonth>(() => monthInKolkata());
  const [input, setInput] = useState<string>(month);
  const [justSaved, setJustSaved] = useState<{ month: IsoMonth; at: number; count: number } | null>(null);
  const pins = useLoad(() => getFxPins(month), [month]);
  const id = useId();

  return (
    <div className="apanel">
      <div className="apanel__head">
        <h2 className="h2">FX pins</h2>
        <p className="prose prose--quiet">
          One corporate rate per currency pair per month. Caps in one currency are compared with rates in another
          using these, never a live rate.
        </p>
      </div>

      <div className="apanel__toolbar">
        <div className="afield afield--inline">
          <label className="afield__label" htmlFor={`${id}-month`}>
            Month
          </label>
          <input
            id={`${id}-month`}
            type="month"
            className="ainput ainput--date"
            value={input}
            placeholder="2026-09"
            onChange={(e) => {
              setInput(e.target.value);
              if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value);
            }}
          />
        </div>
        <span className="mono mono--muted">{formatMonth(month)}</span>
      </div>

      {pins.load.k === "loading" ? <Loading what={`pins for ${formatMonth(month)}`} /> : null}
      {pins.load.k === "fault" ? <LoadFault {...pins.load} what="FX pins" onRetry={() => pins.reload()} /> : null}
      {pins.load.k === "ready" ? (
        <FxEditor
          key={`${pins.load.data.month}-${pins.load.fetchedAt}`}
          month={pins.load.data.month}
          rates={pins.load.data.rates}
          justSaved={
            justSaved !== null && justSaved.month === pins.load.data.month && justSaved.at === pins.load.fetchedAt
              ? justSaved.count
              : null
          }
          onSaved={(data) => {
            pins.set(data);
          }}
          onSavedMark={(count, at) => setJustSaved({ month: month, at, count })}
        />
      ) : null}
    </div>
  );
}

type Save =
  | { readonly k: "idle" }
  | { readonly k: "saving" }
  | { readonly k: "saved"; readonly count: number }
  | { readonly k: "failed"; readonly code: string; readonly message: string };

function FxEditor({
  month,
  rates,
  justSaved,
  onSaved,
  onSavedMark,
}: {
  readonly month: IsoMonth;
  readonly rates: readonly FxRate[];
  readonly justSaved: number | null;
  readonly onSaved: (data: { month: IsoMonth; rates: readonly FxRate[] }) => void;
  readonly onSavedMark: (count: number, at: number) => void;
}): JSX.Element {
  const [rows, setRows] = useState<Row[]>(() => toRows(rates));
  const [save, setSave] = useState<Save>(justSaved === null ? { k: "idle" } : { k: "saved", count: justSaved });
  const [showErrors, setShowErrors] = useState(false);
  const counter = useRef(0);
  const uid = useId();

  const original = useMemo(() => signature(toRows(rates)), [rates]);
  const dirty = signature(rows) !== original;
  const built = build(rows);
  const errors = showErrors ? built.errors : {};

  const patch = (key: string, change: Partial<Row>): void => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));
    if (save.k !== "saving") setSave({ k: "idle" });
  };

  const submit = (): void => {
    if (built.rates === null) {
      setShowErrors(true);
      return;
    }
    setSave({ k: "saving" });
    void putFxPins(month, built.rates)
      .then((res) => {
        // The parent re-keys the editor on the new data; mark it first so the
        // remounted editor opens showing what was saved.
        const at = Date.now();
        onSavedMark(res.rates.length, at);
        onSaved(res);
      })
      .catch((err: unknown) =>
        setSave({
          k: "failed",
          code: isApiError(err) ? `${err.status} ${err.code}` : "unexpected_error",
          message: messageOf(err),
        }),
      );
  };

  const fid = (name: string): string => `${uid}-${name}`;
  const err = (name: string): JSX.Element | null =>
    errors[name] !== undefined ? (
      <span className="aerror" id={`${fid(name)}-err`}>
        {errors[name]}
      </span>
    ) : null;
  const invalid = (name: string): { "aria-invalid": boolean; "aria-describedby"?: string } =>
    errors[name] !== undefined ? { "aria-invalid": true, "aria-describedby": `${fid(name)}-err` } : { "aria-invalid": false };

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {rows.length === 0 ? (
        <div className="empty">
          <p className="prose">No rates are pinned for {formatMonth(month)} yet.</p>
        </div>
      ) : (
        <div className="atable-wrap">
          <table className="atable">
            <caption className="sr-only">Pinned FX rates for {formatMonth(month)}</caption>
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">Base</th>
                <th scope="col">Quote</th>
                <th scope="col" className="num">
                  Rate
                </th>
                <th scope="col">Reads as</th>
                <th scope="col">As of</th>
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const o = r.original;
                const edited =
                  o !== null &&
                  (o.base !== r.base.trim().toUpperCase() ||
                    o.quote !== r.quote.trim().toUpperCase() ||
                    formatScaled(o.rateMicros, 6, 2) !== r.rate.trim());
                const parsed = parseScaled(r.rate, 6, "The rate");
                const base = r.base.trim().toUpperCase();
                const quote = r.quote.trim().toUpperCase();
                const readsAs =
                  parsed.ok && parsed.value > 0 && isCurrencyCode(base) && isCurrencyCode(quote)
                    ? formatRate(base, quote, parsed.value)
                    : "—";
                return (
                  <tr key={r.key}>
                    <td>
                      <Chip tone="neutral">
                        {o === null ? "New" : edited ? "Edited" : o.source === "spot" ? "Spot" : "Pinned"}
                      </Chip>
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={fid(`${r.key}-base`)}>
                        Base currency, row {i + 1}
                      </label>
                      <input
                        id={fid(`${r.key}-base`)}
                        className="ainput ainput--code"
                        maxLength={3}
                        value={r.base}
                        onChange={(e) => patch(r.key, { base: e.target.value.toUpperCase() })}
                        {...invalid(`${r.key}-base`)}
                      />
                      {err(`${r.key}-base`)}
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={fid(`${r.key}-quote`)}>
                        Quote currency, row {i + 1}
                      </label>
                      <input
                        id={fid(`${r.key}-quote`)}
                        className="ainput ainput--code"
                        maxLength={3}
                        value={r.quote}
                        onChange={(e) => patch(r.key, { quote: e.target.value.toUpperCase() })}
                        {...invalid(`${r.key}-quote`)}
                      />
                      {err(`${r.key}-quote`)}
                    </td>
                    <td className="num">
                      <label className="sr-only" htmlFor={fid(`${r.key}-rate`)}>
                        Quote units per one base unit, row {i + 1}
                      </label>
                      <input
                        id={fid(`${r.key}-rate`)}
                        className="ainput ainput--num"
                        inputMode="decimal"
                        value={r.rate}
                        onChange={(e) => patch(r.key, { rate: e.target.value })}
                        {...invalid(`${r.key}-rate`)}
                      />
                      {err(`${r.key}-rate`)}
                    </td>
                    <td>{readsAs}</td>
                    <td className="muted">{o !== null && !edited ? formatStamp(o.asOf) : "on save"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-text"
                        onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                      >
                        Remove<span className="sr-only"> rate row {i + 1}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <button
          type="button"
          className="btn-text"
          onClick={() =>
            setRows((rs) => [
              ...rs,
              { key: `fx-new-${++counter.current}`, base: "", quote: "INR", rate: "", original: null },
            ])
          }
        >
          Add a rate
        </button>
      </div>

      {save.k === "failed" ? (
        <Notice tone="blocked" code={save.code} title="The pins were not saved">
          <p className="prose">{save.message}</p>
        </Notice>
      ) : null}
      {showErrors && built.rates === null ? (
        <p className="aerror" role="alert">
          Fix the highlighted rates before saving.
        </p>
      ) : null}

      <div className="asave__bar">
        <button type="submit" className="btn btn--primary asave__primary" disabled={!dirty || save.k === "saving"}>
          {save.k === "saving" ? "Saving…" : `Save pins for ${formatMonth(month)}`}
        </button>
        {dirty && save.k !== "saving" ? (
          <button
            type="button"
            className="btn-text"
            onClick={() => {
              setRows(toRows(rates));
              setShowErrors(false);
            }}
          >
            Discard changes
          </button>
        ) : null}
        <span className="mono asave__status" role="status">
          {save.k === "saved"
            ? `saved · ${plural(save.count, "rate")} pinned for ${formatMonth(month)}`
            : dirty
              ? "unsaved changes"
              : `${plural(rates.length, "rate")} pinned`}
        </span>
      </div>
    </form>
  );
}
