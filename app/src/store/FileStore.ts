/**
 * Slice 2 domain store: one implementation of `Store` over the `DocPersistence`
 * port, so memory, file and Vercel Blob behave identically, including under
 * concurrency.
 *
 * Concurrency model
 *  - Single-writer documents (entities, FX pins, a booking's first write) use `put`.
 *  - Every `mutate*` is a bounded compare-and-swap loop: read, apply the pure
 *    function, `replace` if the etag is unchanged, back off and retry otherwise.
 *    It throws `ConcurrentUpdateError` once the attempts run out.
 *  - Anything that must happen exactly once is an atomic `create`: the
 *    idempotency reservation (A14 across instances), a one-tap token use, the
 *    booking → invoice claim, and a policy version.
 *  - The invoice counter is a CAS counter per (entity, financial year). Each
 *    successful CAS hands out exactly one number, so numbers never repeat. The Blob
 *    adapter recognises its own landed writes after an SDK retry, so a lost
 *    response cannot re-apply the increment and skip a number.
 *
 * Index documents (why: Blob `list` is one GET per document, so per-traveller and
 * per-entity queries must not scan whole collections). Each index is
 * `{ entries: [{ id, sortKey, tag? }] }`, updated by CAS:
 *  - `idx-entity-travellers/{entityId}`; `traveller-by-email/{email}` → `{ kind, value: travellerId }`
 *  - `idx-traveller-bookings/{travellerId}`, `idx-entity-bookings/{entityId}`;
 *    `booking-by-idempotency-key/{key}` → `{ kind, value: bookingId }`
 *  - `idx-entity-approvals/{entityId}` with `tag` = approval state, so the cron's
 *    "pending" sweep fetches only pending approvals
 *  - `idx-recipient-notifications/{recipientId}` sorted by `at`, so
 *    `listNotificationsFor(limit)` fetches only `limit` documents
 *  - `idx-traveller-searches/{travellerId}` plus `idx-search-registry/all`, a list
 *    of travellers who have ever searched, so the 30-day purge reads one index per
 *    traveller instead of every search document
 *  - `policy-current/{entityId}` → `{ version }`, pointing into immutable
 *    `policy-versions/{entityId}#{version}`
 *  - `booking-invoice/{bookingId}` → `{ invoiceId }`
 *
 * Write ordering: a new document's index entry is written BEFORE the document.
 * A crash in between leaves a dangling entry, which readers filter out (a missing
 * doc, or one that no longer belongs to the owner). The reverse order would leave
 * a booking invisible to its traveller. Readers always re-verify ownership
 * against the document itself, so a stale index can never leak a record.
 *
 * Streams are append-only and have no update or delete path (A18). Stream ids are
 * `${ISO timestamp}~${entry id}`, which sort by time.
 */

import type {
  ApprovalRequest,
  ApprovalState,
  Booking,
  CardEvent,
  FxRate,
  Invoice,
  IsoDateTime,
  IsoMonth,
  LegalEntity,
  NotificationRecord,
  Policy,
  SearchRecord,
  SourceLogEntry,
  Traveller,
} from "../core/types.ts";
import type { DocPersistence, StoredDoc } from "./DocPersistence.ts";
import {
  ConcurrentUpdateError,
  NotFoundError,
  type ActionTokenUse,
  type IdempotencyRecord,
  type Mutator,
  type Store,
} from "./Store.ts";
import { createFilePersistence } from "./persistence/file.ts";
import { createMemoryPersistence } from "./persistence/memory.ts";
import { backoffMs, canonicalJson, mapLimit, normaliseLimit, sha256Hex, sleep } from "./persistence/shared.ts";

const C = {
  travellers: "travellers",
  travellerByEmail: "traveller-by-email",
  entityTravellers: "idx-entity-travellers",
  entities: "entities",
  policyVersions: "policy-versions",
  policyCurrent: "policy-current",
  fxPins: "fx-pins",
  idempotency: "idempotency",
  bookings: "bookings",
  bookingByKey: "booking-by-idempotency-key",
  travellerBookings: "idx-traveller-bookings",
  entityBookings: "idx-entity-bookings",
  approvals: "approvals",
  entityApprovals: "idx-entity-approvals",
  notifications: "notifications",
  recipientNotifications: "idx-recipient-notifications",
  invoices: "invoices",
  bookingInvoice: "booking-invoice",
  invoiceSequences: "invoice-sequences",
  actionTokens: "action-tokens",
  searches: "searches",
  travellerSearches: "idx-traveller-searches",
  searchRegistry: "idx-search-registry",
} as const;

const SOURCE_LOG_STREAM = "source-log";
const READ_CONCURRENCY = 16;
const WHOLE_STREAM = Number.MAX_SAFE_INTEGER;

interface IndexEntry {
  readonly id: string;
  readonly sortKey: string;
  readonly tag?: string;
}

interface IndexDoc {
  readonly entries: readonly IndexEntry[];
}

interface Pointer<K extends string> {
  readonly value: string;
  readonly kind: K;
}

interface InvoiceCounter {
  readonly entityId: string;
  readonly financialYear: string;
  readonly last: number;
}

export interface StoreOptions {
  /** CAS attempts before ConcurrentUpdateError. Must exceed the expected number of simultaneous writers to one document. */
  readonly maxAttempts?: number;
}

const normEmail = (email: string): string => email.trim().toLowerCase();

/** Newest first by timestamp, then id, so equal timestamps still order deterministically. */
function byNewest<T>(at: (x: T) => string, id: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const t = at(b).localeCompare(at(a));
    return t !== 0 ? t : id(b).localeCompare(id(a));
  };
}

function streamId(at: string, id: string): string {
  const ms = Date.parse(at);
  // Normalise to fixed-width UTC so ids sort by time even if callers vary format.
  const time = Number.isFinite(ms) ? new Date(ms).toISOString() : at;
  return `${time}~${id}`;
}

/** A stream name derived from an arbitrary key: literal when safe, hashed otherwise. `.k.` and `.h.` cannot collide. */
function streamKey(base: string, key: string): string {
  return /^[a-z0-9_-]{1,64}$/.test(key) ? `${base}.k.${key}` : `${base}.h.${sha256Hex(key).slice(0, 40)}`;
}

const policyVersionId = (entityId: string, version: number): string =>
  `${entityId}#${String(version).padStart(8, "0")}`;

export function createStore(p: DocPersistence, opts: StoreOptions = {}): Store {
  const maxAttempts = opts.maxAttempts ?? 40;

  const getDoc = async <T>(collection: string, id: string): Promise<T | null> =>
    (await p.get<T>(collection, id))?.doc ?? null;

  const fetchDocs = async <T>(collection: string, ids: readonly string[]): Promise<Array<T | null>> =>
    mapLimit(ids, READ_CONCURRENCY, (id) => getDoc<T>(collection, id));

  /**
   * Read → pure function → CAS, retried. The mutator receives a freshly parsed
   * document on every attempt (all backends parse on read), because it may run
   * more than once. A mutator that changes nothing costs no write.
   */
  async function mutateDoc<T>(collection: string, id: string, fn: Mutator<T>): Promise<{ before: T; after: T }> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current = await p.get<T>(collection, id);
      if (current === null) throw new NotFoundError(collection, id);
      const before = structuredClone(current.doc);
      const beforeJson = canonicalJson(before);
      const next = fn(current.doc);
      if (canonicalJson(next) === beforeJson) return { before, after: next };
      const written = await p.replace(collection, id, next, current.etag);
      if (written !== null) return { before, after: written.doc };
      await sleep(backoffMs(attempt));
    }
    throw new ConcurrentUpdateError(collection, id);
  }

  /**
   * Create-or-CAS loop for documents that may not exist yet (indexes, counters,
   * pointers). `fn` returns undefined for "no change". Both branches are
   * conditional: `create` loses to a concurrent creator, `replace` to a
   * concurrent writer, and either way we re-read.
   */
  async function upsert<T>(collection: string, id: string, fn: (current: T | null) => T | undefined): Promise<T | null> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current: StoredDoc<T> | null = await p.get<T>(collection, id);
      const next = fn(current === null ? null : current.doc);
      if (next === undefined) return current === null ? null : current.doc;
      const written = current === null ? await p.create(collection, id, next) : await p.replace(collection, id, next, current.etag);
      if (written !== null) return written.doc;
      await sleep(backoffMs(attempt));
    }
    throw new ConcurrentUpdateError(collection, id);
  }

  const indexAdd = (collection: string, key: string, entry: IndexEntry): Promise<IndexDoc | null> =>
    upsert<IndexDoc>(collection, key, (current) => {
      const entries = current?.entries ?? [];
      const existing = entries.find((e) => e.id === entry.id);
      if (existing !== undefined && existing.sortKey === entry.sortKey && existing.tag === entry.tag) return undefined;
      return { entries: [...entries.filter((e) => e.id !== entry.id), entry] };
    });

  const indexRemove = (collection: string, key: string, ids: readonly string[]): Promise<IndexDoc | null> =>
    upsert<IndexDoc>(collection, key, (current) => {
      if (current === null) return undefined;
      const drop = new Set(ids);
      const kept = current.entries.filter((e) => !drop.has(e.id));
      return kept.length === current.entries.length ? undefined : { entries: kept };
    });

  const readIndex = async (collection: string, key: string): Promise<IndexEntry[]> =>
    [...((await getDoc<IndexDoc>(collection, key))?.entries ?? [])];

  /** Deletes the indexed documents that still belong to the owner, then their index entries. Returns how many documents existed. */
  async function deleteIndexed<T>(
    docCollection: string,
    indexCollection: string,
    key: string,
    entries: readonly IndexEntry[],
    belongs: (doc: T) => boolean,
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const docs = await fetchDocs<T>(docCollection, entries.map((e) => e.id));
    const doomed = entries.filter((_, i) => {
      const d = docs[i];
      return d !== null && d !== undefined && belongs(d);
    });
    await mapLimit(doomed, READ_CONCURRENCY, (e) => p.delete(docCollection, e.id));
    await indexRemove(indexCollection, key, entries.map((e) => e.id));
    return doomed.length;
  }

  // ---------- travellers ----------

  /** Keeps the email lookup and entity index in step after a traveller write (including erasure, which changes the email). */
  async function afterTravellerWrite(prev: Traveller | null, next: Traveller): Promise<void> {
    const email = normEmail(next.email);
    const pointer = await getDoc<Pointer<"traveller">>(C.travellerByEmail, email);
    if (pointer?.value !== next.id) await p.put<Pointer<"traveller">>(C.travellerByEmail, email, { kind: "traveller", value: next.id });
    if (prev !== null && normEmail(prev.email) !== email) {
      const old = await getDoc<Pointer<"traveller">>(C.travellerByEmail, normEmail(prev.email));
      if (old?.value === next.id) await p.delete(C.travellerByEmail, normEmail(prev.email));
    }
    if (prev !== null && prev.entityId !== next.entityId) {
      await indexAdd(C.entityTravellers, next.entityId, { id: next.id, sortKey: next.createdAt });
      await indexRemove(C.entityTravellers, prev.entityId, [next.id]);
    }
  }

  // ---------- approvals ----------

  const approvalEntry = (a: ApprovalRequest): IndexEntry => ({ id: a.id, sortKey: a.createdAt, tag: a.state });

  const newestBooking = byNewest<Booking>((b) => b.createdAt, (b) => b.id);

  async function listIndexed<T>(
    indexCollection: string,
    key: string,
    docCollection: string,
    belongs: (doc: T) => boolean,
  ): Promise<T[]> {
    const entries = await readIndex(indexCollection, key);
    const docs = await fetchDocs<T>(docCollection, entries.map((e) => e.id));
    return docs.filter((d): d is T => d !== null && belongs(d));
  }

  return {
    // ---------- travellers ----------

    async getTravellerByEmail(email) {
      const needle = normEmail(email);
      if (needle === "") return null;
      const pointer = await getDoc<Pointer<"traveller">>(C.travellerByEmail, needle);
      if (pointer === null) return null;
      const t = await getDoc<Traveller>(C.travellers, pointer.value);
      // Verify against the document: a stale pointer must never resolve an erased or re-addressed traveller.
      return t !== null && normEmail(t.email) === needle ? t : null;
    },

    async getTraveller(id) {
      return getDoc<Traveller>(C.travellers, id);
    },

    async putTraveller(t) {
      const prev = await getDoc<Traveller>(C.travellers, t.id);
      await indexAdd(C.entityTravellers, t.entityId, { id: t.id, sortKey: t.createdAt });
      await p.put(C.travellers, t.id, t);
      await afterTravellerWrite(prev, t);
    },

    async mutateTraveller(id, fn) {
      const { before, after } = await mutateDoc<Traveller>(C.travellers, id, fn);
      await afterTravellerWrite(before, after);
      return after;
    },

    async listTravellers(entityId) {
      const docs = await listIndexed<Traveller>(C.entityTravellers, entityId, C.travellers, (t) => t.entityId === entityId);
      return docs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },

    // ---------- legal entity ----------

    async getEntity(id) {
      return getDoc<LegalEntity>(C.entities, id);
    },

    async putEntity(e) {
      await p.put(C.entities, e.id, e);
    },

    // ---------- policy ----------

    async getCurrentPolicy(entityId) {
      const pointer = await getDoc<{ readonly version: number }>(C.policyCurrent, entityId);
      return pointer === null ? null : getDoc<Policy>(C.policyVersions, policyVersionId(entityId, pointer.version));
    },

    async getPolicyVersion(entityId, version) {
      if (!Number.isInteger(version) || version < 1) return null;
      return getDoc<Policy>(C.policyVersions, policyVersionId(entityId, version));
    },

    async savePolicy(pol) {
      if (!Number.isInteger(pol.version) || pol.version < 1) throw new RangeError("policy version must be a positive integer");
      const id = policyVersionId(pol.entityId, pol.version);
      // Versions are immutable (A12 replays verdicts against them), so a version
      // is created, never overwritten. Two admins saving "version N+1" at once
      // conflict here. Two instances seeding the same default at boot differ only
      // in updatedAt/updatedBy and are treated as the same save.
      if ((await p.create(C.policyVersions, id, pol)) === null) {
        const existing = await getDoc<Policy>(C.policyVersions, id);
        const essence = (x: Policy): string => canonicalJson({ ...x, updatedAt: "", updatedBy: "" });
        if (existing === null || essence(existing) !== essence(pol)) throw new ConcurrentUpdateError(C.policyVersions, id);
      }
      // The pointer only ever moves forward, so a delayed save of an older version cannot roll it back.
      await upsert<{ readonly entityId: string; readonly version: number }>(C.policyCurrent, pol.entityId, (current) =>
        current !== null && current.version >= pol.version ? undefined : { entityId: pol.entityId, version: pol.version },
      );
    },

    // ---------- FX pins ----------

    async getFxPins(month: IsoMonth) {
      return (await getDoc<{ readonly rates: FxRate[] }>(C.fxPins, month))?.rates ?? [];
    },

    async putFxPins(month, rates) {
      await p.put(C.fxPins, month, { month, rates: [...rates] });
    },

    // ---------- idempotency ----------

    async reserveIdempotencyKey(rec) {
      const record: IdempotencyRecord = {
        key: rec.key,
        travellerId: rec.travellerId,
        requestHash: rec.requestHash,
        createdAt: rec.createdAt,
        state: "in_flight",
        bookingId: null,
      };
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // The atomic create IS the reservation: across every instance, exactly
        // one caller gets a non-null result for this key.
        if ((await p.create(C.idempotency, rec.key, record)) !== null) return { reserved: true } as const;
        // Returned as-is even when requestHash differs; the server turns that into 409.
        const existing = await getDoc<IdempotencyRecord>(C.idempotency, rec.key);
        if (existing !== null) return { reserved: false, existing } as const;
        // Released between our create and our read: race for it again.
      }
      throw new ConcurrentUpdateError(C.idempotency, rec.key);
    },

    async completeIdempotencyKey(key, bookingId) {
      await mutateDoc<IdempotencyRecord>(C.idempotency, key, (r) => ({ ...r, state: "completed", bookingId }));
    },

    async releaseIdempotencyKey(key) {
      const current = await getDoc<IdempotencyRecord>(C.idempotency, key);
      // Only an in-flight reservation is released. Deleting a completed one would
      // let the same key book twice. Read-then-delete is safe because only the
      // request holding the reservation completes or releases it.
      if (current !== null && current.state === "in_flight") await p.delete(C.idempotency, key);
    },

    // ---------- bookings ----------

    async getBooking(id) {
      return getDoc<Booking>(C.bookings, id);
    },

    async getBookingByIdempotencyKey(key) {
      const pointer = await getDoc<Pointer<"booking">>(C.bookingByKey, key);
      const bookingId = pointer?.value ?? (await getDoc<IdempotencyRecord>(C.idempotency, key))?.bookingId ?? null;
      if (bookingId === null) return null;
      const b = await getDoc<Booking>(C.bookings, bookingId);
      return b !== null && b.idempotencyKey === key ? b : null;
    },

    async putBooking(b) {
      await Promise.all([
        indexAdd(C.travellerBookings, b.travellerId, { id: b.id, sortKey: b.createdAt }),
        indexAdd(C.entityBookings, b.entityId, { id: b.id, sortKey: b.createdAt }),
      ]);
      await p.put(C.bookings, b.id, b);
      if ((await p.get(C.bookingByKey, b.idempotencyKey)) === null) {
        // First booking under a key wins the pointer; a lost race here is fine.
        await p.create<Pointer<"booking">>(C.bookingByKey, b.idempotencyKey, { kind: "booking", value: b.id });
      }
    },

    async mutateBooking(id, fn) {
      const { before, after } = await mutateDoc<Booking>(C.bookings, id, fn);
      if (before.travellerId !== after.travellerId) {
        await indexAdd(C.travellerBookings, after.travellerId, { id, sortKey: after.createdAt });
        await indexRemove(C.travellerBookings, before.travellerId, [id]);
      }
      if (before.entityId !== after.entityId) {
        await indexAdd(C.entityBookings, after.entityId, { id, sortKey: after.createdAt });
        await indexRemove(C.entityBookings, before.entityId, [id]);
      }
      return after;
    },

    async listBookingsForTraveller(travellerId) {
      const docs = await listIndexed<Booking>(C.travellerBookings, travellerId, C.bookings, (b) => b.travellerId === travellerId);
      return docs.sort(newestBooking);
    },

    async listBookingsForEntity(entityId) {
      const docs = await listIndexed<Booking>(C.entityBookings, entityId, C.bookings, (b) => b.entityId === entityId);
      return docs.sort(newestBooking);
    },

    // ---------- approvals ----------

    async getApproval(id) {
      return getDoc<ApprovalRequest>(C.approvals, id);
    },

    async putApproval(a) {
      const indexed = (await readIndex(C.entityApprovals, a.entityId)).some((e) => e.id === a.id);
      if (!indexed) {
        // New: index first (the state tag is the new state), so it is never invisible.
        await indexAdd(C.entityApprovals, a.entityId, approvalEntry(a));
        await p.put(C.approvals, a.id, a);
      } else {
        // Existing: document first. A crash before the tag update leaves the old
        // tag ("pending"), which the pending sweep fetches and then filters out.
        await p.put(C.approvals, a.id, a);
        await indexAdd(C.entityApprovals, a.entityId, approvalEntry(a));
      }
    },

    async mutateApproval(id, fn) {
      const { before, after } = await mutateDoc<ApprovalRequest>(C.approvals, id, fn);
      if (before.entityId !== after.entityId) await indexRemove(C.entityApprovals, before.entityId, [id]);
      await indexAdd(C.entityApprovals, after.entityId, approvalEntry(after));
      return after;
    },

    async listApprovals(entityId, filter) {
      const state: ApprovalState | undefined = filter?.state;
      const entries = (await readIndex(C.entityApprovals, entityId)).filter(
        (e) => state === undefined || e.tag === undefined || e.tag === state,
      );
      const docs = await fetchDocs<ApprovalRequest>(C.approvals, entries.map((e) => e.id));
      return docs
        .filter((a): a is ApprovalRequest => a !== null && a.entityId === entityId && (state === undefined || a.state === state))
        .sort(byNewest((a) => a.createdAt, (a) => a.id));
    },

    // ---------- notifications ----------

    async putNotification(n) {
      await indexAdd(C.recipientNotifications, n.recipientId, { id: n.id, sortKey: n.at });
      await p.put(C.notifications, n.id, n);
    },

    async listNotificationsFor(recipientId, limit) {
      const n = normaliseLimit(limit);
      if (n === 0) return [];
      const entries = (await readIndex(C.recipientNotifications, recipientId)).sort(byNewest((e) => e.sortKey, (e) => e.id));
      const out: NotificationRecord[] = [];
      // Fetch in windows of what is still needed, so dangling entries cost a little extra and a full inbox costs `limit` reads.
      for (let at = 0; at < entries.length && out.length < n; ) {
        const window = entries.slice(at, at + (n - out.length));
        at += window.length;
        const docs = await fetchDocs<NotificationRecord>(C.notifications, window.map((e) => e.id));
        for (const d of docs) if (d !== null && d.recipientId === recipientId) out.push(d);
      }
      return out.sort(byNewest((x) => x.at, (x) => x.id)).slice(0, n);
    },

    async mutateNotification(id, fn) {
      const { before, after } = await mutateDoc<NotificationRecord>(C.notifications, id, fn);
      if (before.recipientId !== after.recipientId) {
        await indexAdd(C.recipientNotifications, after.recipientId, { id, sortKey: after.at });
        await indexRemove(C.recipientNotifications, before.recipientId, [id]);
      }
      return after;
    },

    async deleteNotificationsFor(recipientId) {
      const entries = await readIndex(C.recipientNotifications, recipientId);
      return deleteIndexed<NotificationRecord>(
        C.notifications,
        C.recipientNotifications,
        recipientId,
        entries,
        (d) => d.recipientId === recipientId,
      );
    },

    // ---------- invoices ----------

    async getInvoice(id) {
      return getDoc<Invoice>(C.invoices, id);
    },

    async getInvoiceForBooking(bookingId) {
      const claim = await getDoc<Pointer<"invoice">>(C.bookingInvoice, bookingId);
      return claim === null ? null : getDoc<Invoice>(C.invoices, claim.value);
    },

    async createInvoice(inv) {
      // The claim is the atomic step: one invoice per booking, across instances.
      const claimed = await p.create<Pointer<"invoice">>(C.bookingInvoice, inv.bookingId, { kind: "invoice", value: inv.id });
      if (claimed === null) {
        const existing = await getDoc<Pointer<"invoice">>(C.bookingInvoice, inv.bookingId);
        // Resume only our own interrupted create: same invoice id, document never written.
        if (existing?.value !== inv.id || (await p.get(C.invoices, inv.id)) !== null) return false;
      }
      if ((await p.create(C.invoices, inv.id, inv)) === null) {
        const other = await getDoc<Invoice>(C.invoices, inv.id);
        if (other?.bookingId !== inv.bookingId) throw new Error(`invoice id ${inv.id} is already used by another booking`);
      }
      return true;
    },

    async nextInvoiceSequence(entityId, financialYear) {
      // One successful create/CAS = one number. A loser re-reads and tries last+1
      // again, so a number is never handed out twice, and none is skipped because
      // a failed CAS writes nothing.
      const counter = await upsert<InvoiceCounter>(C.invoiceSequences, `${entityId}|${financialYear}`, (current) => ({
        entityId,
        financialYear,
        last: (current?.last ?? 0) + 1,
      }));
      if (counter === null) throw new Error("invoice counter write returned nothing");
      return counter.last;
    },

    // ---------- one-tap tokens ----------

    async consumeActionToken(use: ActionTokenUse) {
      // Atomic create: true for exactly one consumer, on any instance.
      return (await p.create(C.actionTokens, use.tokenId, use)) !== null;
    },

    // ---------- card events ----------

    async appendCardEvent(e: CardEvent) {
      await p.append(streamKey("card-events", e.entityId), streamId(e.at, e.id), e);
    },

    async listCardEvents(entityId) {
      const events = await p.readStream<CardEvent>(streamKey("card-events", entityId), { limit: WHOLE_STREAM, newestFirst: false });
      return events.filter((e) => e.entityId === entityId);
    },

    // ---------- search history ----------

    async putSearchRecord(r: SearchRecord) {
      // Register the traveller for the retention purge before their first search lands.
      if ((await p.get(C.travellerSearches, r.travellerId)) === null) {
        await indexAdd(C.searchRegistry, "all", { id: r.travellerId, sortKey: "" });
      }
      await indexAdd(C.travellerSearches, r.travellerId, { id: r.id, sortKey: r.createdAt });
      await p.put(C.searches, r.id, r);
    },

    async listSearchRecordsFor(travellerId) {
      const docs = await listIndexed<SearchRecord>(C.travellerSearches, travellerId, C.searches, (s) => s.travellerId === travellerId);
      return docs.sort(byNewest((s) => s.createdAt, (s) => s.id));
    },

    async deleteSearchRecordsFor(travellerId) {
      const entries = await readIndex(C.travellerSearches, travellerId);
      return deleteIndexed<SearchRecord>(C.searches, C.travellerSearches, travellerId, entries, (s) => s.travellerId === travellerId);
    },

    async purgeSearchRecordsBefore(cutoff: IsoDateTime) {
      const cutoffMs = Date.parse(cutoff);
      if (!Number.isFinite(cutoffMs)) throw new RangeError(`invalid cutoff ${cutoff}`);
      const travellers = await readIndex(C.searchRegistry, "all");
      const counts = await mapLimit(travellers, 4, async (t) => {
        const old = (await readIndex(C.travellerSearches, t.id)).filter((e) => Date.parse(e.sortKey) < cutoffMs);
        return deleteIndexed<SearchRecord>(
          C.searches,
          C.travellerSearches,
          t.id,
          old,
          (s) => s.travellerId === t.id && Date.parse(s.createdAt) < cutoffMs,
        );
      });
      return counts.reduce((a, b) => a + b, 0);
    },

    // ---------- append-only supplier log ----------

    async appendSourceLog(e: SourceLogEntry) {
      const id = streamId(e.at, e.id);
      // Written twice, both append-only: the global log, and a per-correlation
      // stream so a booking's audit trail is not a scan of the whole log.
      await Promise.all([
        p.append(SOURCE_LOG_STREAM, id, e),
        p.append(streamKey("source-log.corr", e.correlationId), id, e),
      ]);
    },

    async listSourceLog(limit) {
      if (normaliseLimit(limit) === 0) return [];
      return p.readStream<SourceLogEntry>(SOURCE_LOG_STREAM, { limit, newestFirst: true });
    },

    /** Chronological (oldest first): it reads as an audit trail. */
    async listSourceLogByCorrelation(correlationIds) {
      const unique = [...new Set(correlationIds)];
      const perId = await mapLimit(unique, 8, async (cid) =>
        (await p.readStream<SourceLogEntry>(streamKey("source-log.corr", cid), { limit: WHOLE_STREAM, newestFirst: false })).filter(
          (e) => e.correlationId === cid,
        ),
      );
      const seen = new Set<string>();
      return perId
        .flat()
        .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    },
  };
}

export function createMemoryStore(): Store {
  return createStore(createMemoryPersistence());
}

export function createFileStore(dir: string): Store {
  return createStore(createFilePersistence(dir));
}
