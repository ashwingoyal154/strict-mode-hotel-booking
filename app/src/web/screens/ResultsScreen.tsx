/**
 * Results — the streaming screen, and the signature moment of the product.
 *
 * How the settle works:
 *   · The SSE stream is opened first, so the source meter starts moving before any
 *     result exists. `source` events drive the segments with the API's own
 *     durationMs; `results` events carry the whole re-ranked list each time.
 *   · A snapshot GET runs alongside it, purely so a reload or a direct link lands
 *     on a settled list, and so the meter knows each source's display name. It is
 *     applied only if no `results` frame has arrived, so it can never clobber live
 *     data.
 *   · Offer ids already rendered are remembered in a ref. Ids appearing for the
 *     first time are tagged `offer--settling` for that render only, which is a
 *     one-shot CSS animation on insert over --dur-settle with --ease-settle. It
 *     cannot re-fire on a reorder, and prefers-reduced-motion removes it.
 *   · Skeletons are rendered one per still-pending source, capped at three, using
 *     OfferCard's own classes — so when a result lands in a skeleton's place the
 *     height does not change.
 *   · A failed source stays in the meter in the blocked colour with a `failed`
 *     label. The list stays usable; the page degrades and never errors.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import type { Anchor, RankedOffer, SearchQuery } from "../../core/types.ts";
import {
  getSearch,
  isApiError,
  messageOf,
  subscribeSearch,
  type DoneEvent,
  type SourceDescriptor,
  type SourceEvent,
} from "../lib/api.ts";
import { formatDateRange, nightsBetween, plural } from "../lib/fmt.ts";
import { BlockedDisclosure } from "../components/BlockedDisclosure.tsx";
import { Notice } from "../components/Notice.tsx";
import { OfferCard } from "../components/OfferCard.tsx";
import { SkeletonCard } from "../components/SkeletonCard.tsx";
import { SourceMeter, type MeterSource } from "../components/SourceMeter.tsx";

const MAX_SKELETONS = 3;

interface HandoffState {
  readonly sources: readonly SourceDescriptor[];
  readonly anchor: Anchor;
  readonly query: SearchQuery;
}

/** The Search screen hands the source list and query over so the meter is
 *  populated on the very first frame, before the snapshot resolves. */
function readHandoff(state: unknown): HandoffState | null {
  if (typeof state !== "object" || state === null) return null;
  const rec = state as Record<string, unknown>;
  const sources = rec["sources"];
  const anchor = rec["anchor"];
  const query = rec["query"];
  if (!Array.isArray(sources) || typeof anchor !== "object" || anchor === null) return null;
  if (typeof query !== "object" || query === null) return null;
  return {
    sources: sources as readonly SourceDescriptor[],
    anchor: anchor as Anchor,
    query: query as SearchQuery,
  };
}

interface SourceState {
  readonly status: SourceEvent["status"];
  readonly offerCount: number;
  readonly durationMs: number;
}

export function ResultsScreen(): JSX.Element {
  const { searchId = "" } = useParams<{ searchId: string }>();
  const handoff = readHandoff(useLocation().state);

  const [descriptors, setDescriptors] = useState<readonly SourceDescriptor[]>(
    handoff?.sources ?? [],
  );
  const [states, setStates] = useState<Readonly<Record<string, SourceState>>>({});
  const [results, setResults] = useState<readonly RankedOffer[]>([]);
  const [done, setDone] = useState<DoneEvent | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(handoff?.anchor ?? null);
  const [query, setQuery] = useState<SearchQuery | null>(handoff?.query ?? null);
  const [streamDropped, setStreamDropped] = useState(false);
  const [loadFault, setLoadFault] = useState<{ code: string; message: string } | null>(null);

  const seenRef = useRef<Set<string>>(new Set());
  const gotFrameRef = useRef(false);
  const [settling, setSettling] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (searchId === "") return undefined;

    let live = true;
    seenRef.current = new Set();
    gotFrameRef.current = false;

    const applyResults = (incoming: readonly RankedOffer[]): void => {
      const fresh = new Set<string>();
      for (const r of incoming) {
        const id = r.offer.rate.id;
        if (!seenRef.current.has(id)) {
          seenRef.current.add(id);
          fresh.add(id);
        }
      }
      setSettling(fresh);
      setResults(incoming);
    };

    const unsubscribe = subscribeSearch(searchId, {
      onSource: (e) => {
        if (!live) return;
        setStates((prev) => ({
          ...prev,
          [e.sourceId]: {
            status: e.status,
            offerCount: e.offerCount,
            durationMs: e.durationMs,
          },
        }));
        setDescriptors((prev) =>
          prev.some((d) => d.id === e.sourceId)
            ? prev
            : [...prev, { id: e.sourceId, displayName: e.sourceId }],
        );
      },
      onResults: (e) => {
        if (!live) return;
        gotFrameRef.current = true;
        applyResults(e.results);
      },
      onDone: (e) => {
        if (!live) return;
        gotFrameRef.current = true;
        setDone(e);
      },
      onStreamError: () => {
        if (!live) return;
        setStreamDropped(true);
      },
    });

    void getSearch(searchId)
      .then((snap) => {
        if (!live) return;
        setAnchor(snap.anchor);
        setQuery(snap.query);
        setDescriptors((prev) => (prev.length >= snap.sources.length ? prev : snap.sources));
        if (!gotFrameRef.current) applyResults(snap.results);
      })
      .catch((err: unknown) => {
        if (!live) return;
        // The snapshot is a convenience; only surface it when the stream has
        // given us nothing either.
        if (!gotFrameRef.current) {
          setLoadFault({
            code: isApiError(err) ? err.code : "unexpected_error",
            message: messageOf(err),
          });
        }
      });

    return () => {
      live = false;
      unsubscribe();
    };
  }, [searchId]);

  const meterSources: readonly MeterSource[] = useMemo(
    () =>
      descriptors.map((d) => {
        const s = states[d.id];
        return {
          id: d.id,
          displayName: d.displayName,
          status: s?.status ?? "pending",
          offerCount: s?.offerCount ?? 0,
          durationMs: s?.durationMs ?? 0,
        };
      }),
    [descriptors, states],
  );

  const elapsedMs = useMemo(() => {
    if (done !== null) return done.durationMs;
    return meterSources.reduce((max, s) => (s.durationMs > max ? s.durationMs : max), 0);
  }, [done, meterSources]);

  const bookable = useMemo(() => results.filter((r) => r.verdict.state !== "blocked"), [results]);
  const blocked = useMemo(() => results.filter((r) => r.verdict.state === "blocked"), [results]);

  const pending = meterSources.filter((s) => s.status === "pending").length;
  const settled = done !== null;
  const skeletonCount = settled
    ? 0
    : Math.min(MAX_SKELETONS, descriptors.length === 0 ? MAX_SKELETONS : pending);
  const failedCount = meterSources.filter((s) => s.status === "failed").length;

  const nights = query === null ? 0 : nightsBetween(query.checkIn, query.checkOut);

  if (loadFault !== null) {
    return (
      <div className="screen">
        <h1 className="h1">That search is gone</h1>
        <Notice tone="blocked" code={loadFault.code} title="Nothing to show">
          <p className="prose">{loadFault.message}</p>
          <p className="prose prose--quiet">
            Searches expire after thirty minutes so a price is never quoted from a stale
            fan-out.
          </p>
        </Notice>
        <Link to="/" className="btn">
          Start a new search
        </Link>
      </div>
    );
  }

  return (
    <div className="results">
      <div className="results__anchor">
        <h1 className="h1">{anchor?.label ?? "Searching"}</h1>
        {query !== null ? (
          <p className="mono mono--muted">
            {formatDateRange(query.checkIn, query.checkOut)} &middot; {plural(nights, "night")}{" "}
            &middot; {plural(query.guests, "guest")} &middot; {plural(query.rooms, "room")}
          </p>
        ) : null}
      </div>

      <SourceMeter
        sources={meterSources}
        elapsedMs={elapsedMs}
        done={settled}
        resultCount={bookable.length}
      />

      {streamDropped && !settled ? (
        <Notice tone="neutral" code="stream dropped" title="The live updates stopped">
          <p className="prose">
            These are the results we had when the connection went. Reload to search again.
          </p>
        </Notice>
      ) : null}

      {settled && failedCount > 0 ? (
        <div className="results__degraded">
          <span className="label label--blocked">
            {plural(failedCount, "source")} failed
          </span>
          <p className="prose">
            These results are everything the other sources returned. Nothing is hidden
            from you &mdash; there is simply less of it.
          </p>
        </div>
      ) : null}

      <ul className="results__list">
        {bookable.map((r) => (
          <li key={r.offer.rate.id}>
            <OfferCard
              ranked={r}
              href={`/confirm/${encodeURIComponent(searchId)}/${encodeURIComponent(r.offer.rate.id)}`}
              settling={settling.has(r.offer.rate.id)}
            />
          </li>
        ))}
        {Array.from({ length: skeletonCount }, (_, i) => (
          <li key={`skeleton-${i}`}>
            <SkeletonCard />
          </li>
        ))}
      </ul>

      {settled && bookable.length === 0 ? (
        <div className="empty">
          <span className="label">0 bookable results</span>
          <p className="prose">
            {blocked.length > 0
              ? "Everything near this anchor is blocked by your policy. The reasons are below."
              : "No source had anything near this anchor for these dates."}
          </p>
          <Link to="/" className="btn">
            Change the anchor or the dates
          </Link>
        </div>
      ) : null}

      <BlockedDisclosure offers={blocked} />
    </div>
  );
}
