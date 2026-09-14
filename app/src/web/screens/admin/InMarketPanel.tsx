/**
 * In market — duty of care. Who is on the road on a given night, where, and how
 * to reach the hotel. The count by country leads; a `high` advisory row takes the
 * blocked stripe and a caution row the over stripe.
 */

import { useId, useState } from "react";
import type { InMarketTraveller, TravelAdvisory } from "../../../core/types.ts";
import { formatDateRange, plural, telHref } from "../../lib/fmt.ts";
import { getInMarket, type CountryCount } from "./api.ts";
import { AdvisoryChip, BookingStateChip, Chip } from "./chips.tsx";
import { todayInKolkata } from "./format.ts";
import { Loading, LoadFault, useLoad } from "./useLoad.tsx";

type Level = TravelAdvisory["level"] | null;

const RANK: Readonly<Record<string, number>> = { high: 0, caution: 1, none: 2 };

function stripe(level: Level): string | undefined {
  if (level === "high") return "stripe--blocked";
  if (level === "caution") return "stripe--over";
  return undefined;
}

function countrySummary(
  c: CountryCount,
  travellers: readonly InMarketTraveller[],
): { level: Level; notes: readonly string[] } {
  const fromRows = travellers
    .filter((t) => t.countryCode === c.countryCode && t.advisory !== null)
    .map((t) => t.advisory)
    .filter((a): a is TravelAdvisory => a !== null);
  const list = Array.isArray(c.advisories) ? c.advisories : fromRows;
  const level: Level = list.some((a) => a.level === "high")
    ? "high"
    : list.some((a) => a.level === "caution")
      ? "caution"
      : null;
  const notes = [...new Set(list.map((a) => (a.city !== null ? `${a.city} · ${a.note}` : a.note)))];
  return { level, notes };
}

export function InMarketPanel(): JSX.Element {
  const [date, setDate] = useState(() => todayInKolkata());
  const [input, setInput] = useState(date);
  const data = useLoad(() => getInMarket(date), [date]);
  const id = useId();

  return (
    <div className="apanel">
      <div className="apanel__head">
        <h2 className="h2">In market</h2>
        <p className="prose prose--quiet">Everyone staying in a booked hotel on the night you choose.</p>
      </div>

      <div className="apanel__toolbar">
        <div className="afield afield--inline">
          <label className="afield__label" htmlFor={`${id}-date`}>
            Night of
          </label>
          <input
            id={`${id}-date`}
            type="date"
            className="ainput ainput--date"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setDate(e.target.value);
            }}
          />
        </div>
        {date !== todayInKolkata() ? (
          <button
            type="button"
            className="btn-text"
            onClick={() => {
              const today = todayInKolkata();
              setInput(today);
              setDate(today);
            }}
          >
            Tonight
          </button>
        ) : null}
      </div>

      {data.load.k === "loading" ? <Loading what="travellers in market" /> : null}
      {data.load.k === "fault" ? (
        <LoadFault {...data.load} what="travellers in market" onRetry={() => data.reload()} />
      ) : null}
      {data.load.k === "ready" ? (
        <InMarketTables
          date={data.load.data.date}
          travellers={data.load.data.travellers}
          byCountry={data.load.data.byCountry}
        />
      ) : null}
    </div>
  );
}

function InMarketTables({
  date,
  travellers,
  byCountry,
}: {
  readonly date: string;
  readonly travellers: readonly InMarketTraveller[];
  readonly byCountry: readonly CountryCount[];
}): JSX.Element {
  if (travellers.length === 0) {
    return (
      <div className="empty">
        <p className="prose">No one has a booked stay on the night of {date}.</p>
      </div>
    );
  }

  const countries = byCountry
    .map((c) => ({ ...c, ...countrySummary(c, travellers) }))
    .sort((a, b) => RANK[a.level ?? "none"]! - RANK[b.level ?? "none"]! || b.count - a.count);

  const rows = [...travellers].sort(
    (a, b) =>
      RANK[a.advisory?.level ?? "none"]! - RANK[b.advisory?.level ?? "none"]! ||
      a.countryCode.localeCompare(b.countryCode) ||
      a.name.localeCompare(b.name),
  );

  return (
    <>
      <p className="mono mono--muted" role="status">
        {plural(travellers.length, "traveller")} in {plural(byCountry.length, "country", "countries")} · night of{" "}
        {date}
      </p>

      <section className="apanel__section" aria-label="Count by country">
        <h3 className="h3">By country</h3>
        <div className="atable-wrap">
          <table className="atable">
            <caption className="sr-only">Travellers in market by country</caption>
            <thead>
              <tr>
                <th scope="col">Advisory</th>
                <th scope="col">Country</th>
                <th scope="col" className="num">
                  Travellers
                </th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {countries.map((c) => (
                <tr key={c.countryCode} className={stripe(c.level)}>
                  <td>
                    {c.level === null ? (
                      <Chip tone="neutral">No advisory</Chip>
                    ) : c.level === "high" ? (
                      <Chip tone="blocked">High advisory</Chip>
                    ) : (
                      <Chip tone="over">Caution</Chip>
                    )}
                  </td>
                  <td>{c.countryCode}</td>
                  <td className="num">{c.count}</td>
                  <td className="wrap">
                    {c.notes.length === 0 ? (
                      <span className="cell-sub">—</span>
                    ) : (
                      c.notes.map((n) => (
                        <span key={n} className="cell-quote">
                          {n}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="apanel__section" aria-label="Travellers">
        <h3 className="h3">Travellers</h3>
        <div className="atable-wrap">
          <table className="atable">
            <caption className="sr-only">Travellers in market, with the hotel and how to reach it</caption>
            <thead>
              <tr>
                <th scope="col">Advisory</th>
                <th scope="col">Traveller</th>
                <th scope="col">Hotel</th>
                <th scope="col">Hotel phone</th>
                <th scope="col">Address</th>
                <th scope="col">Stay</th>
                <th scope="col">Booking</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.bookingId} className={stripe(t.advisory?.level ?? null)}>
                  <td className="wrap">
                    <AdvisoryChip advisory={t.advisory} />
                    {t.advisory !== null ? <span className="cell-quote">{t.advisory.note}</span> : null}
                  </td>
                  <td>
                    <span className="cell-main">{t.name}</span>
                    <span className="cell-sub">{t.email}</span>
                  </td>
                  <td>
                    <span className="cell-main">{t.propertyName}</span>
                    <span className="cell-sub">
                      {t.city} · {t.countryCode}
                    </span>
                  </td>
                  <td>
                    <a className="btn-text" href={telHref(t.propertyPhone)}>
                      {t.propertyPhone}
                    </a>
                  </td>
                  <td className="wrap">
                    <span className="cell-prose">{t.addressLine}</span>
                  </td>
                  <td>{formatDateRange(t.checkIn, t.checkOut)}</td>
                  <td>
                    <BookingStateChip state={t.state} />
                    <span className="cell-sub">{t.confirmationCode}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
