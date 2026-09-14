/**
 * Vercel Blob DocPersistence, for production: private store, several serverless
 * instances writing at once.
 *
 * Pathnames: `${prefix}/${collection}/${encodeURIComponent(id)}.json`; streams
 * under `${prefix}/_stream/${stream}/`. The SDK (@vercel/blob 2.8) is used as
 * follows, all verified against the live store:
 *
 *  - create  → `put(..., { allowOverwrite: false })`. The server rejects a second
 *    writer atomically (10 concurrent creators → exactly 1 success).
 *  - replace → `put(..., { allowOverwrite: true, ifMatch })`. A stale etag throws
 *    `BlobPreconditionFailedError`.
 *  - get     → `get(..., { access: "private", useCache: false })`, which adds
 *    `cache=0` and reads from origin, so a read sees the preceding write.
 *  - list    → `list({ prefix, cursor })`, paginated until `hasMore` is false.
 *  - delete  → `del(pathname)`. Deleting a missing blob succeeds.
 *
 * Two SDK behaviours shape the error handling:
 *
 *  1. There is no error class for "already exists". It arrives as a plain
 *     `BlobError` (API code `bad_request`), and a losing concurrent CAS
 *     occasionally surfaces as a plain `BlobError` too. We never match on message
 *     text. After a failed write we read what is actually stored and decide from
 *     that.
 *  2. The SDK retries network errors internally. A retried write whose first
 *     attempt landed looks like a conflict with ourselves. Without care, a lost
 *     response on the invoice counter would make the Store's CAS loop re-apply the
 *     increment and skip a number. So each write carries a random nonce, and the
 *     stored envelope keeps the last few writers' nonces (`w`). If a failed write
 *     finds its own nonce stored, it succeeded.
 *
 * The token lives only in this closure. It is never logged, never placed on the
 * returned object, and never interpolated into an error message.
 */

import { randomUUID } from "node:crypto";
import {
  BlobError,
  BlobPreconditionFailedError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  del,
  get,
  list,
  put,
} from "@vercel/blob";

import type { DocPersistence, StoredDoc } from "../DocPersistence.ts";
import {
  STREAM_ROOT,
  StreamEntryExistsError,
  assertCollection,
  assertId,
  assertStream,
  backoffMs,
  compareIds,
  mapLimit,
  pickStreamIds,
  serialise,
  sleep,
} from "./shared.ts";

/** How many prior writers' nonces a document remembers. */
const WRITE_HISTORY = 16;
/** Retries of our own, on top of the SDK's, for transient conflicts where nothing was stored. */
const LOCAL_RETRIES = 3;
const LIST_PAGE = 1000;
/** `list` fetches every document; refuse rather than silently fan out thousands of GETs. */
const MAX_LIST_DOCS = 5000;
const READ_CONCURRENCY = 8;
const ETAG_CACHE_SIZE = 2048;
/** Blob's minimum. Irrelevant to our reads (always origin), but it bounds any other path. */
const CACHE_MAX_AGE_SECONDS = 60;

interface Envelope<T> {
  readonly v: 1;
  readonly id: string;
  /** Nonces of the most recent writers, newest first. */
  readonly w: readonly string[];
  readonly doc: T;
}

interface Current<T> {
  readonly env: Envelope<T>;
  readonly etag: string;
}

export interface BlobPersistenceConfig {
  readonly token: string;
  readonly prefix: string;
}

const PREFIX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function parseEnvelope<T>(text: string, pathname: string): Envelope<T> {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    !Array.isArray((parsed as { w?: unknown }).w) ||
    !("doc" in parsed)
  ) {
    throw new Error(`corrupt document at ${pathname}`);
  }
  return parsed as Envelope<T>;
}

/** Conflicts and brown-outs where retrying the same conditional write is safe. */
function isTransient(err: unknown): boolean {
  if (err instanceof BlobServiceNotAvailable || err instanceof BlobServiceRateLimited) return true;
  // Exactly BlobError, not a subclass: the SDK's generic `bad_request`, which is
  // how "already exists" and some concurrent-write conflicts arrive.
  return err instanceof BlobError && err.constructor === BlobError;
}

export function createBlobPersistence(cfg: BlobPersistenceConfig): DocPersistence {
  const token = cfg.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("createBlobPersistence: a read-write token is required");
  }
  const prefix = cfg.prefix.replace(/^\/+|\/+$/g, "");
  if (!PREFIX.test(prefix)) throw new Error("createBlobPersistence: prefix must be path segments of [A-Za-z0-9._-]");

  /** etag → writer history, so a CAS carries the history forward without an extra read. */
  const histories = new Map<string, readonly string[]>();
  const remember = (etag: string, w: readonly string[]): void => {
    histories.delete(etag);
    histories.set(etag, w);
    if (histories.size > ETAG_CACHE_SIZE) {
      const oldest = histories.keys().next();
      if (oldest.done !== true) histories.delete(oldest.value);
    }
  };

  const folderOf = (collectionPath: string): string => `${prefix}/${collectionPath}/`;
  const pathnameOf = (collectionPath: string, id: string): string =>
    `${folderOf(collectionPath)}${encodeURIComponent(id)}.json`;

  /**
   * `get` splices the pathname into the URL verbatim, and the server decodes it.
   * A stored pathname containing `%20` would therefore be looked up as a space
   * and 404. Escaping each segment once more makes the URL decode back to the
   * stored pathname. `put`/`del` send the pathname as a parameter and take it
   * literally.
   */
  const urlPathOf = (pathname: string): string => pathname.split("/").map(encodeURIComponent).join("/");

  async function read<T>(pathname: string): Promise<Current<T> | null> {
    const res = await get(urlPathOf(pathname), { access: "private", token, useCache: false });
    if (res === null) return null;
    if (res.statusCode !== 200) throw new Error(`unexpected status ${res.statusCode} reading ${pathname}`);
    const env = parseEnvelope<T>(await new Response(res.stream).text(), pathname);
    remember(res.blob.etag, env.w);
    return { env, etag: res.blob.etag };
  }

  /** After a failed write, read what is stored. If the read also fails, the original error is more useful. */
  async function readAfterFailure<T>(pathname: string, original: unknown): Promise<Current<T> | null> {
    try {
      return await read<T>(pathname);
    } catch {
      throw original;
    }
  }

  function write(
    pathname: string,
    body: string,
    conditions: { readonly allowOverwrite: boolean; readonly ifMatch?: string },
  ): Promise<{ readonly etag: string }> {
    return put(pathname, body, {
      access: "private",
      token,
      contentType: "application/json",
      addRandomSuffix: false,
      cacheControlMaxAge: CACHE_MAX_AGE_SECONDS,
      ...conditions,
    });
  }

  /**
   * The result of a write that landed but was overwritten before we could see it.
   * The write succeeded; its version is simply no longer current, so its etag
   * must fail any later CAS, which this one does.
   */
  const superseded = <T>(doc: T, nonce: string): StoredDoc<T> => ({ doc, etag: `"superseded-${nonce}"` });

  async function createAt<T>(collectionPath: string, id: string, doc: T): Promise<StoredDoc<T> | null> {
    const pathname = pathnameOf(collectionPath, id);
    const nonce = randomUUID();
    const env: Envelope<T> = { v: 1, id, w: [nonce], doc };
    const body = serialise(env);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await write(pathname, body, { allowOverwrite: false });
        remember(res.etag, env.w);
        return { doc: parseEnvelope<T>(body, pathname).doc, etag: res.etag };
      } catch (err) {
        const current = await readAfterFailure<T>(pathname, err);
        if (current !== null) {
          if (current.env.w[0] === nonce) return { doc: current.env.doc, etag: current.etag };
          if (current.env.w.includes(nonce)) return superseded(parseEnvelope<T>(body, pathname).doc, nonce);
          // Somebody else holds the id. Whatever the SDK called the error, this
          // is create-if-absent losing.
          return null;
        }
        if (!isTransient(err) || attempt >= LOCAL_RETRIES) throw err;
        await sleep(backoffMs(attempt));
      }
    }
  }

  async function listPathnames(folder: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: folder, token, limit: LIST_PAGE, ...(cursor === undefined ? {} : { cursor }) });
      for (const b of page.blobs) {
        const rest = b.pathname.slice(folder.length);
        if (b.pathname.startsWith(folder) && !rest.includes("/") && rest.endsWith(".json")) out.push(b.pathname);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor !== undefined);
    return out;
  }

  const idFromPathname = (folder: string, pathname: string): string =>
    decodeURIComponent(pathname.slice(folder.length, -".json".length));

  return {
    id: "blob",

    async get<T>(collection: string, id: string): Promise<StoredDoc<T> | null> {
      assertCollection(collection);
      assertId(id);
      const current = await read<T>(pathnameOf(collection, id));
      return current === null ? null : { doc: current.env.doc, etag: current.etag };
    },

    async create<T>(collection: string, id: string, doc: T): Promise<StoredDoc<T> | null> {
      assertCollection(collection);
      assertId(id);
      return createAt(collection, id, doc);
    },

    async replace<T>(collection: string, id: string, doc: T, ifMatch: string): Promise<StoredDoc<T> | null> {
      assertCollection(collection);
      assertId(id);
      const pathname = pathnameOf(collection, id);
      const nonce = randomUUID();
      const env: Envelope<T> = { v: 1, id, w: [nonce, ...(histories.get(ifMatch) ?? [])].slice(0, WRITE_HISTORY), doc };
      const body = serialise(env);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await write(pathname, body, { allowOverwrite: true, ifMatch });
          remember(res.etag, env.w);
          return { doc: parseEnvelope<T>(body, pathname).doc, etag: res.etag };
        } catch (err) {
          const current = await readAfterFailure<T>(pathname, err);
          // Gone: `ifMatch` cannot be the current etag of nothing.
          if (current === null) return null;
          if (current.env.w[0] === nonce) return { doc: current.env.doc, etag: current.etag };
          if (current.env.w.includes(nonce)) return superseded(parseEnvelope<T>(body, pathname).doc, nonce);
          if (current.etag !== ifMatch) return null;
          // The etag still matches and our write is not there: nothing landed.
          // A precondition failure here means the server saw a newer version our
          // read has not caught up with, so report the CAS as lost and let the
          // caller re-read. Anything else transient is safe to retry, because the
          // write is still conditional.
          if (err instanceof BlobPreconditionFailedError) return null;
          if (!isTransient(err) || attempt >= LOCAL_RETRIES) throw err;
          await sleep(backoffMs(attempt));
        }
      }
    },

    async put<T>(collection: string, id: string, doc: T): Promise<StoredDoc<T>> {
      assertCollection(collection);
      assertId(id);
      const pathname = pathnameOf(collection, id);
      const env: Envelope<T> = { v: 1, id, w: [randomUUID()], doc };
      const body = serialise(env);
      // Unconditional, so the SDK's own retries are idempotent.
      const res = await write(pathname, body, { allowOverwrite: true });
      remember(res.etag, env.w);
      return { doc: parseEnvelope<T>(body, pathname).doc, etag: res.etag };
    },

    async delete(collection: string, id: string): Promise<void> {
      assertCollection(collection);
      assertId(id);
      await del(pathnameOf(collection, id), { token });
    },

    async list<T>(collection: string): Promise<StoredDoc<T>[]> {
      assertCollection(collection);
      const pathnames = await listPathnames(folderOf(collection));
      if (pathnames.length > MAX_LIST_DOCS) {
        throw new Error(`refusing to list ${pathnames.length} documents in ${collection}; use an index document`);
      }
      const docs = await mapLimit(pathnames, READ_CONCURRENCY, (p) => read<T>(p));
      return docs
        .filter((d): d is Current<T> => d !== null) // deleted between list and get
        .sort((a, b) => compareIds(a.env.id, b.env.id))
        .map((d) => ({ doc: d.env.doc, etag: d.etag }));
    },

    async append<T>(stream: string, id: string, entry: T): Promise<void> {
      assertStream(stream);
      assertId(id);
      const created = await createAt(`${STREAM_ROOT}/${stream}`, id, entry);
      if (created === null) throw new StreamEntryExistsError(stream, id);
    },

    async readStream<T>(stream: string, opts: { readonly limit: number; readonly newestFirst: boolean }): Promise<T[]> {
      assertStream(stream);
      const folder = folderOf(`${STREAM_ROOT}/${stream}`);
      // List names only (one call per 1,000), sort by id, and fetch just the
      // entries asked for. Reading the latest 50 log entries costs 50 GETs, not N.
      const ids = (await listPathnames(folder)).map((p) => idFromPathname(folder, p)).sort(compareIds);
      const picked = pickStreamIds(ids, opts.limit, opts.newestFirst);
      const entries = await mapLimit(picked, READ_CONCURRENCY, (id) => read<T>(pathnameOf(`${STREAM_ROOT}/${stream}`, id)));
      return entries.filter((e): e is Current<T> => e !== null).map((e) => e.env.doc);
    },
  };
}
