/**
 * Streaming fan-out search with **stateless, signed search ids**.
 *
 * Serverless means the instance that answers `GET /api/search/:id` is often not
 * the one that answered `POST /api/search`. So the id carries its own query:
 * anchor, dates, party, display currency, traveller, entity, policy version, FX
 * pin month and created-at, HMAC-signed under `SM_SECRET`. Any instance that
 * misses its cache recomputes the session from the id. Supply is re-queried, the
 * policy is the exact version the id names and the pins are that month's pins, so
 * deterministic supply yields byte-identical offers.
 *
 * A tampered id, or one presented by another traveller, is `404 search_not_found`;
 * one older than 30 minutes is `410 search_expired`.
 *
 * Source latency is a design constraint (spec §3.1): sources are called
 * concurrently with a 2.5s budget each, and a failed source marks itself failed
 * while the session carries on (§3.3, A24).
 */

import { createHash, randomBytes } from "node:crypto";

import { estimateCommute } from "../core/commute.ts";
import { convertVia } from "../core/fx.ts";
import { evaluate } from "../core/policy.ts";
import { dedupeByProperty, rankOffers, type RankInput } from "../core/rank.ts";
import type {
  Anchor,
  Commute,
  Conversion,
  Currency,
  FxRate,
  GeoPoint,
  IsoMonth,
  Money,
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
import { openJson, sealJson } from "./signing.ts";

export const SOURCE_TIMEOUT_MS = 2_500;
export const SEARCH_TTL_MS = 30 * 60_000;
/** Slice 1 name, kept for anything that imported it. */
export const SESSION_TTL_MS = SEARCH_TTL_MS;

const PURPOSE = "search-id";

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
  | { readonly event: "results"; readonly data: { results: RankedOffer[]; answered: number; total: number } }
  | {
      readonly event: "done";
      readonly data: { answered: number; total: number; failed: number; durationMs: number };
    };

export interface SearchSession {
  readonly id: string;
  /** The SearchRecord id, also the correlation id of the fan-out's source log entries. */
  readonly recordId: string;
  readonly query: SearchQuery;
  readonly policy: Policy;
  readonly travellerId: string;
  readonly entityId: string;
  readonly createdAt: Date;
  readonly displayCurrency: Currency;
  readonly pinMonth: IsoMonth;
  readonly fxPins: readonly FxRate[];
  snapshot(): SearchSnapshot;
  /** Replays everything that has already happened, then streams the rest. */
  subscribe(listener: (event: SearchEvent) => void): () => void;
  /** Resolves when every source has answered, failed or timed out. */
  settled(): Promise<void>;
  /** The ranked entry for any offer the sources returned, including ones deduped out of the list. */
  find(offerId: OfferId): RankedOffer | undefined;
}

export interface CreateSearchArgs {
  readonly query: SearchQuery;
  readonly policy: Policy;
  readonly travellerId: string;
  readonly entityId: string;
  readonly displayCurrency: Currency;
  readonly pinMonth: IsoMonth;
  readonly fxPins: readonly FxRate[];
}

export type SearchLookup =
  | { readonly ok: true; readonly session: SearchSession }
  | {
      readonly ok: false;
      readonly status: 404 | 410;
      readonly code: "search_not_found" | "search_expired";
      readonly message: string;
    };

export interface SearchRegistry {
  create(args: CreateSearchArgs): Promise<SearchSession>;
  /** Any instance can serve any unexpired search: recomputes on a cache miss. */
  get(id: string): Promise<SearchSession | undefined>;
  /** `get`, plus the traveller check and the precise failure the API reports. */
  resolve(id: string, travellerId: string): Promise<SearchLookup>;
}

export interface SearchDeps {
  readonly sources: RateSource[];
  readonly routes: RouteSource;
  readonly store: Store;
  readonly now: () => Date;
}

// ---------- the id ----------

interface SearchIdWire {
  readonly v: 1;
  /** label, lat, lng, city, countryCode */
  readonly a: [string, number, number, string, string];
  readonly ci: string;
  readonly co: string;
  readonly g: number;
  readonly r: number;
  readonly dc: string;
  readonly t: string;
  readonly e: string;
  readonly pv: number;
  readonly pm: string;
  readonly at: number;
  /** Nonce, so two identical searches in the same millisecond are still two searches. */
  readonly n: string;
}

function isWire(x: unknown): x is SearchIdWire {
  if (typeof x !== "object" || x === null) return false;
  const w = x as Record<string, unknown>;
  const a = w.a;
  return (
    w.v === 1 &&
    Array.isArray(a) &&
    a.length === 5 &&
    typeof a[0] === "string" &&
    typeof a[1] === "number" &&
    typeof a[2] === "number" &&
    typeof a[3] === "string" &&
    typeof a[4] === "string" &&
    typeof w.ci === "string" &&
    typeof w.co === "string" &&
    typeof w.g === "number" &&
    typeof w.r === "number" &&
    typeof w.dc === "string" &&
    typeof w.t === "string" &&
    typeof w.e === "string" &&
    typeof w.pv === "number" &&
    typeof w.pm === "string" &&
    typeof w.at === "number" &&
    typeof w.n === "string"
  );
}

function decodeSearchId(id: string): SearchIdWire | null {
  const raw = openJson(PURPOSE, id);
  return isWire(raw) ? raw : null;
}

export function searchRecordIdFor(searchId: string): string {
  return `srec_${createHash("sha256").update(searchId).digest("hex").slice(0, 24)}`;
}

function queryOf(w: SearchIdWire): SearchQuery {
  const anchor: Anchor = { label: w.a[0], geo: { lat: w.a[1], lng: w.a[2] }, city: w.a[3], countryCode: w.a[4] };
  return { anchor, checkIn: w.ci, checkOut: w.co, guests: w.g, rooms: w.r };
}

// ---------- the session ----------

function displayConversion(total: Money, to: Currency, pins: readonly FxRate[]): Conversion {
  try {
    return convertVia(total, to, pins);
  } catch {
    // No pin for the display currency: show the supplier figure rather than invent one.
    return { from: total, to: total, fx: null };
  }
}

function createSession(
  deps: SearchDeps,
  id: string,
  createdAt: Date,
  args: CreateSearchArgs,
): SearchSession {
  const recordId = searchRecordIdFor(id);
  const startedAt = Date.now();

  const states = new Map<string, SourceState>();
  for (const src of deps.sources) {
    states.set(src.id, { sourceId: src.id, displayName: src.displayName, status: "pending", offerCount: 0, durationMs: 0 });
  }

  const inputs = new Map<OfferId, RankInput>();
  const commuteCache = new Map<PropertyId, Commute>();
  const listeners = new Set<(event: SearchEvent) => void>();

  let ranked: RankedOffer[] = [];
  let done = false;
  let totalDurationMs = 0;

  const answeredCount = (): number => [...states.values()].filter((s) => s.status === "answered").length;
  const failedCount = (): number => [...states.values()].filter((s) => s.status === "failed").length;

  function emit(event: SearchEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A dead SSE socket must not take down the fan-out.
      }
    }
  }

  const resultsEvent = (): SearchEvent => ({
    event: "results",
    data: { results: ranked, answered: answeredCount(), total: deps.sources.length },
  });

  const doneEvent = (): SearchEvent => ({
    event: "done",
    data: { answered: answeredCount(), total: deps.sources.length, failed: failedCount(), durationMs: totalDurationMs },
  });

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
      try {
        const verdict = evaluate({
          rate: offer.rate,
          property: offer.property,
          policy: args.policy,
          fxPins: args.fxPins,
          pinMonth: args.pinMonth,
        });
        const display = displayConversion(offer.rate.allInTotal, args.displayCurrency, args.fxPins);
        inputs.set(offer.rate.id, { offer, commute, verdict, display });
      } catch {
        // One malformed offer is dropped; it must not take its source's other offers with it.
      }
    }

    ranked = rankOffers(dedupeByProperty([...inputs.values()]));
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
      emit(resultsEvent());
    } finally {
      clearTimeout(timer);
    }
  }

  const settledPromise = withCorrelationId(recordId, () =>
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
    recordId,
    query: args.query,
    policy: args.policy,
    travellerId: args.travellerId,
    entityId: args.entityId,
    createdAt,
    displayCurrency: args.displayCurrency,
    pinMonth: args.pinMonth,
    fxPins: args.fxPins,

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
          display: input.display,
        }
      );
    },
  };
}

// ---------- the registry ----------

interface CacheEntry {
  readonly at: number;
  readonly session: Promise<SearchSession | null>;
}

export function createSearchRegistry(deps: SearchDeps): SearchRegistry {
  const cache = new Map<string, CacheEntry>();

  const sweep = (): void => {
    const cutoff = deps.now().getTime() - SEARCH_TTL_MS;
    for (const [id, entry] of cache) {
      if (entry.at < cutoff) cache.delete(id);
    }
  };

  const expired = (w: SearchIdWire): boolean => deps.now().getTime() - w.at > SEARCH_TTL_MS;

  function lookup(id: string, w: SearchIdWire): Promise<SearchSession | null> {
    const hit = cache.get(id);
    if (hit !== undefined) return hit.session;
    const session = (async (): Promise<SearchSession | null> => {
      const policy =
        (await deps.store.getPolicyVersion(w.e, w.pv)) ?? (await deps.store.getCurrentPolicy(w.e));
      if (policy === null) return null;
      const fxPins = await deps.store.getFxPins(w.pm);
      return createSession(deps, id, new Date(w.at), {
        query: queryOf(w),
        policy,
        travellerId: w.t,
        entityId: w.e,
        displayCurrency: w.dc,
        pinMonth: w.pm,
        fxPins,
      });
    })();
    // Registered before it resolves, so concurrent misses share one fan-out.
    cache.set(id, { at: w.at, session });
    session.then(
      (s) => {
        if (s === null) cache.delete(id);
      },
      () => cache.delete(id),
    );
    return session;
  }

  return {
    async create(args) {
      sweep();
      const createdAt = deps.now();
      const wire: SearchIdWire = {
        v: 1,
        a: [
          args.query.anchor.label,
          args.query.anchor.geo.lat,
          args.query.anchor.geo.lng,
          args.query.anchor.city,
          args.query.anchor.countryCode,
        ],
        ci: args.query.checkIn,
        co: args.query.checkOut,
        g: args.query.guests,
        r: args.query.rooms,
        dc: args.displayCurrency,
        t: args.travellerId,
        e: args.entityId,
        pv: args.policy.version,
        pm: args.pinMonth,
        at: createdAt.getTime(),
        n: randomBytes(4).toString("base64url"),
      };
      const id = sealJson(PURPOSE, wire);
      const session = createSession(deps, id, createdAt, args);
      cache.set(id, { at: wire.at, session: Promise.resolve(session) });
      await deps.store.putSearchRecord({
        id: session.recordId,
        travellerId: args.travellerId,
        entityId: args.entityId,
        anchor: args.query.anchor,
        checkIn: args.query.checkIn,
        checkOut: args.query.checkOut,
        createdAt: createdAt.toISOString(),
      });
      return session;
    },

    async get(id) {
      sweep();
      const w = decodeSearchId(id);
      if (w === null || expired(w)) return undefined;
      return (await lookup(id, w)) ?? undefined;
    },

    async resolve(id, travellerId) {
      sweep();
      const w = decodeSearchId(id);
      if (w === null || w.t !== travellerId) {
        return { ok: false, status: 404, code: "search_not_found", message: "That search does not exist. Search again." };
      }
      if (expired(w)) {
        return {
          ok: false,
          status: 410,
          code: "search_expired",
          message: "Prices from that search are more than 30 minutes old. Search again for live prices.",
        };
      }
      const session = await lookup(id, w);
      if (session === null) {
        return { ok: false, status: 404, code: "search_not_found", message: "That search does not exist. Search again." };
      }
      return { ok: true, session };
    },
  };
}
