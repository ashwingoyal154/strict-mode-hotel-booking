/**
 * SourceMeter — a row of hairline segments, one per source, filling as each
 * answers, with `n of m sources · 840ms` in mono.
 *
 * It stays on the page after settling as a receipt of what was actually searched,
 * and a failed source renders in the blocked colour with a `failed` label rather
 * than disappearing. Timings are the API's own `durationMs`; nothing is timed
 * client-side.
 */

import type { SourceStatus } from "../lib/api.ts";
import { formatDuration, plural } from "../lib/fmt.ts";

export interface MeterSource {
  readonly id: string;
  readonly displayName: string;
  readonly status: SourceStatus;
  readonly offerCount: number;
  readonly durationMs: number;
}

interface SourceMeterProps {
  readonly sources: readonly MeterSource[];
  /** The elapsed figure the API reported, not a client clock. */
  readonly elapsedMs: number;
  readonly done: boolean;
  readonly resultCount: number;
}

export function SourceMeter({
  sources,
  elapsedMs,
  done,
  resultCount,
}: SourceMeterProps): JSX.Element {
  const total = sources.length;
  const settled = sources.filter((s) => s.status !== "pending").length;
  const failed = sources.filter((s) => s.status === "failed").length;

  const announcement = done
    ? `${settled} of ${total} sources answered${failed > 0 ? `, ${failed} failed` : ""}. ${plural(resultCount, "result")}.`
    : `${settled} of ${total} sources answered. ${plural(resultCount, "result")} so far.`;

  return (
    <section
      className="meter"
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Sources searched"
    >
      <div className="meter__bar" aria-hidden="true">
        {sources.map((s) => (
          <span key={s.id} className="meter__seg" data-status={s.status} />
        ))}
      </div>

      <p className="mono mono--muted meter__status">
        <span className="meter__count">
          {settled} of {total} sources
        </span>
        <span aria-hidden="true">&middot;</span>
        <span>{formatDuration(elapsedMs)}</span>
        {done ? null : <span>searching</span>}
      </p>

      <ul className="meter__legend">
        {sources.map((s) => (
          <li key={s.id} className="meter__src" data-status={s.status}>
            <span>{s.displayName}</span>
            {s.status === "failed" ? (
              <span className="meter__flag">failed</span>
            ) : s.status === "answered" ? (
              <span>{formatDuration(s.durationMs)}</span>
            ) : (
              <span className="meter__flag">waiting</span>
            )}
          </li>
        ))}
      </ul>

      <span className="sr-only">{announcement}</span>
    </section>
  );
}
