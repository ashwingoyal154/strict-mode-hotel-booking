/**
 * The persistence port under Store. Three implementations share one contract:
 * memory (tests), file (local dev) and Vercel Blob (production).
 *
 * Why these operations and not a generic key-value put: bookings are money and
 * several serverless instances write concurrently. `create` is an atomic
 * create-if-absent, which is what makes an idempotency key reservation safe
 * across instances. `replace` is compare-and-swap on an etag, which is what
 * stops an approver's decision and a traveller's withdrawal from silently
 * overwriting each other. A store that only offers last-write-wins cannot
 * honour A14.
 *
 * Reads are read-your-writes. The Blob adapter reads with the cache bypassed.
 */
export interface StoredDoc<T> {
  readonly doc: T;
  readonly etag: string;
}

export interface DocPersistence {
  readonly id: "memory" | "file" | "blob";

  get<T>(collection: string, id: string): Promise<StoredDoc<T> | null>;

  /** Atomic create. Resolves null — never throws, never overwrites — when the id already exists. */
  create<T>(collection: string, id: string, doc: T): Promise<StoredDoc<T> | null>;

  /** Compare-and-swap. Resolves null when `ifMatch` is no longer the current etag. */
  replace<T>(collection: string, id: string, doc: T, ifMatch: string): Promise<StoredDoc<T> | null>;

  /** Unconditional upsert, for documents with exactly one writer. */
  put<T>(collection: string, id: string, doc: T): Promise<StoredDoc<T>>;

  delete(collection: string, id: string): Promise<void>;

  list<T>(collection: string): Promise<StoredDoc<T>[]>;

  /** Append-only stream. There is no update or delete path. Ids must sort by time. */
  append<T>(stream: string, id: string, entry: T): Promise<void>;

  readStream<T>(stream: string, opts: { readonly limit: number; readonly newestFirst: boolean }): Promise<T[]>;
}
