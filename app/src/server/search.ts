/**
 * Streaming fan-out search.
 *
 * Source latency is a design constraint, not an implementation detail (spec
 * §3.1): four sources are called *concurrently*, each with its own 2.5s
 * `AbortController` budget, and the session emits a fully re-ranked list every
 * time one of them answers. A source that times out or throws is marked
 * `failed` and the session carries on — the page degrades, it never errors
 * (§3.3, A24).
 *
 * Commutes are computed in one batched call per answering source, with a
 * property-level cache, because a results page needs twenty of them at once and
 * an N+1 here would dominate the p95 budget.
 */

import { estimateCommute } from "../core/commute.ts";
import { newId } from "../core/ids.ts";
import { evaluate } from "../core/policy.ts";
import { rankOffers, type RankInput } from "../core/rank.ts";
import type {
  Commute,
  GeoPoint,
  Offer,
  OfferId,
  Policy,
  PropertyId,
  RankedOffer,
  SearchQuery,
} from "../core/types.ts";
import type { RouteSource } from "../routing/RouteSource.ts";
import type { RateSource } from "../supply/RateSource.ts";
import type { Store } from "../store/Store.ts";
import { withCorrelationId } from "./audit.ts";

export const SOURCE_TIMEOUT_MS = 2_500;
export const SESSION_TTL_MS = 30 * 60_000;

export type SourceStatus = "pending" | "answered" | "failed";

export interface SourceState {
  readonly sourceId: string;
  readonly displayName: string;
  readonly status: SourceStatus;
  readonly offerCount: number;
  readonly durationMs: number;
}

export interface SearchSnapshot {
  readonly results: RankedOffer[];
  readonly sources: SourceState[];
  readonly blockedCount: number;
  readonly answered: number;
  readonly failed: number;
  readonly total: number;
  readonly durationMs: number;
  readonly done: boolean;
}

export type SearchEvent =
  | { readonly event: "source"; readonly data: SourceState }
  | {
      readonly event: "results";
      readonly data: { results: RankedOffer[]; answered: number; total: number };
    }
  | {
      readonly event: "done";
      readonly data: {
        answered: number;
        total: number;
        failed: number;
        durationMs: number;
      };
    };

export interface SearchSession {
  readonly id: string;
  readonly query: SearchQuery;
  readonly policy: Policy;
  readonly travellerId: string;
  readonly createdAt: Date;
  snapshot(): SearchSnapshot;
  /** Replays everything that has already happened, then streams the rest. */
  subscribe(listener: (event: SearchEvent) => void): () => void;
  /** Resolves when every source has answered, failed or timed out. */
  settled(): Promise<void>;
  /** The ranked entry for an offer id, for the confirm screen and booking. */
  find(offerId: OfferId): RankedOffer | undefined;
}

export interface CreateSearchArgs {
  readonly query: SearchQuery;
  readonly policy: Policy;
  readonly travellerId: string;
}

export interface SearchRegistry {
  create(args: CreateSearchArgs): SearchSession;
  get(id: string): SearchSession | undefined;
}

interface SessionDeps {
  readonly sources: RateSource[];
  readonly routes: RouteSource;
  readonly store: Store;
}

function createSession(deps: SessionDeps, args: CreateSearchArgs): SearchSession {
  const id = newId("srch");
  const correlationId = newId("corr");
  const createdAt = new Date();
  const startedAt = Date.now();

  const states = new Map<string, SourceState>();
  for (const src of deps.sources) {
    states.set(src.id, {
      sourceId: src.id,
      displayName: src.displayName,
      status: "pending",
      offerCount: 0,
      durationMs: 0,
    });
  }

  const inputs = new Map<OfferId, RankInput>();
  const commuteCache = new Map<PropertyId, Commute>();
  const listeners = new Set<(event: SearchEvent) => void>();

  let ranked: RankedOffer[] = [];
  let done = false;
  let totalDurationMs = 0;

  const answeredCount = (): number =>
    [...states.values()].filter((s) => s.status === "answered").length;
  const failedCount = (): number =>
    [...states.values()].filter((s) => s.status === "failed").length;

  function emit(event: SearchEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A dead SSE socket must not take down the fan-out.
      }
    }
  }

  function resultsEvent(): SearchEvent {
    return {
      event: "results",
      data: {
        results: ranked,
        answered: answeredCount(),
        total: deps.sources.length,
      },
    };
  }

  function doneEvent(): SearchEvent {
    return {
      event: "done",
      data: {
        answered: answeredCount(),
        total: deps.sources.length,
        failed: failedCount(),
        durationMs: totalDurationMs,
      },
    };
  }

  /**
   * One batched commute call for every property this source brought that we have
   * not already routed, then policy, then a full re-rank. Ranking is always
   * recomputed over the whole accumulated set: the list the traveller sees is
   * never a concatenation of per-source lists.
   */
  async function absorb(offers: readonly Offer[]): Promise<void> {
    const missing: Offer[] = [];
    const seen = new Set<PropertyId>();
    for (const offer of offers) {
      const pid = offer.property.id;
      if (commuteCache.has(pid) || seen.has(pid)) continue;
      seen.add(pid);
      missing.push(offer);
    }

    if (missing.length > 0) {
      const points: GeoPoint[] = missing.map((o) => o.property.geo);
      let commutes: readonly Commute[];
      try {
        commutes = await deps.routes.commuteBatch(args.query.anchor.geo, points);
      } catch {
        // Routing is the product, so it is never silently dropped: fall back to
        // the same pure estimator the local RouteSource delegates to.
        commutes = points.map((p) => estimateCommute(args.query.anchor.geo, p));
      }
      missing.forEach((offer, i) => {
        const commute = commutes[i];
        if (commute !== undefined) commuteCache.set(offer.property.id, commute);
      });
    }

    for (const offer of offers) {
      const commute = commuteCache.get(offer.property.id);
      if (commute === undefined) continue;
      const verdict = evaluate({
        rate: offer.rate,
        property: offer.property,
        policy: args.policy,
      });
      inputs.set(offer.rate.id, { offer, commute, verdict });
    }

    ranked = rankOffers([...inputs.values()]);
  }

  async function runSource(src: RateSource): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`source ${src.id} exceeded ${SOURCE_TIMEOUT_MS}ms`)),
      SOURCE_TIMEOUT_MS,
    );
    const began = Date.now();
    try {
      const offers = await src.searchAvailability(args.query, controller.signal);
      if (controller.signal.aborted) throw new Error("aborted");
      await absorb(offers);
      const state: SourceState = {
        sourceId: src.id,
        displayName: src.displayName,
        status: "answered",
        offerCount: offers.length,
        durationMs: Date.now() - began,
      };
      states.set(src.id, state);
      emit({ event: "source", data: state });
      emit(resultsEvent());
    } catch {
      const state: SourceState = {
        sourceId: src.id,
        displayName: src.displayName,
        status: "failed",
        offerCount: 0,
        durationMs: Date.now() - began,
      };
      states.set(src.id, state);
      emit({ event: "source", data: state });
      // Still emit results: the list the traveller holds is unchanged but the
      // client needs the count to move so the source meter settles.
      emit(resultsEvent());
    } finally {
      clearTimeout(timer);
    }
  }

  const settledPromise = withCorrelationId(correlationId, () =>
    Promise.all(deps.sources.map((src) => runSource(src)))
      .then(() => undefined)
      .finally(() => {
        totalDurationMs = Date.now() - startedAt;
        done = true;
        emit(doneEvent());
      }),
  );

  return {
    id,
    query: args.query,
    policy: args.policy,
    travellerId: args.travellerId,
    createdAt,

    snapshot() {
      return {
        results: ranked,
        sources: [...states.values()],
        blockedCount: ranked.filter((r) => r.verdict.state === "blocked").length,
        answered: answeredCount(),
        failed: failedCount(),
        total: deps.sources.length,
        durationMs: done ? totalDurationMs : Date.now() - startedAt,
        done,
      };
    },

    subscribe(listener) {
      // Replay first. A search starts the instant POST /api/search returns, so a
      // subscriber that connects 40ms later must still see every source event.
      for (const state of states.values()) {
        if (state.status !== "pending") listener({ event: "source", data: state });
      }
      if (ranked.length > 0 || answeredCount() > 0) listener(resultsEvent());
      if (done) {
        listener(doneEvent());
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    settled() {
      return settledPromise;
    },

    find(offerId) {
      const input = inputs.get(offerId);
      if (input === undefined) return undefined;
      return (
        ranked.find((r) => r.offer.rate.id === offerId) ?? {
          offer: input.offer,
          commute: input.commute,
          verdict: input.verdict,
          rank: 0,
          rankReason: "",
        }
      );
    },
  };
}

export function createSearchRegistry(deps: SessionDeps): SearchRegistry {
  const sessions = new Map<string, SearchSession>();

  const sweep = (): void => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of sessions) {
      if (session.createdAt.getTime() < cutoff) sessions.delete(id);
    }
  };

  return {
    create(args) {
      sweep();
      const session = createSession(deps, args);
      sessions.set(session.id, session);
      return session;
    },
    get(id) {
      sweep();
      return sessions.get(id);
    },
  };
}
