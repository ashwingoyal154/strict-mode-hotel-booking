/**
 * Filesystem DocPersistence, for local development. Same guarantees as Blob,
 * including across several processes sharing one directory.
 *
 * Layout: `${dir}/${collection}/${name}.json` and `${dir}/_stream/${stream}/${name}.json`.
 * Each file holds `{ id, doc }`, so the id survives the filename encoding.
 *
 * How the guarantees are met:
 *  - Every write to a document takes an exclusive lock file, `${file}.lock`,
 *    created with `open(..., "wx")` (O_CREAT|O_EXCL), which the kernel makes
 *    atomic across processes. Inside one process a keyed mutex sits in front of
 *    it, so same-process contenders queue instead of polling the filesystem.
 *  - `create` is an exclusive create: it writes a temp file and hard-`link`s it to
 *    the target. `link` fails with EEXIST if the target exists, so this is
 *    create-if-absent. Unlike `open(target, "wx")` followed by a write, a reader
 *    can never observe a half-written file.
 *  - `replace` compares the etag under the lock. The etag is the sha-256 of the
 *    file's bytes. Content hashing admits A→B→A: a CAS holding A's etag succeeds
 *    after the document went to B and back. That is harmless here: the document
 *    is byte-identical to what the mutator read, and mutators are pure functions
 *    of the document.
 *  - All other writes land via temp file + `rename`, which is atomic, so lock-free
 *    readers see the old bytes or the new, never a mix.
 */

import { link, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import type { DocPersistence, StoredDoc } from "../DocPersistence.ts";
import {
  KeyedMutex,
  STREAM_ROOT,
  StreamEntryExistsError,
  assertCollection,
  assertId,
  assertStream,
  compareIds,
  mapLimit,
  pickStreamIds,
  serialise,
  sha256Hex,
  sleep,
} from "./shared.ts";

/** A lock older than this was left by a crashed writer: writes take milliseconds. */
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 60_000;
const MAX_ENCODED_NAME = 200;
const READ_CONCURRENCY = 32;

interface FileEnvelope<T> {
  readonly id: string;
  readonly doc: T;
}

interface Cell<T> {
  readonly env: FileEnvelope<T>;
  readonly etag: string;
}

function codeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function ignoreEnoent(err: unknown): void {
  if (codeOf(err) !== "ENOENT") throw err;
}

const etagOf = (text: string): string => `"sha256-${sha256Hex(text)}"`;

/**
 * An injective, case-insensitive-safe filename. Uppercase letters become `^` +
 * lowercase (`^` itself is always percent-encoded, so it cannot be confused), and
 * names too long for a filesystem fall back to `#<sha256>` (`#` is also always
 * percent-encoded, so no encoded id can take that form).
 */
function fileNameFor(id: string): string {
  const encoded = encodeURIComponent(id).replace(/[A-Z]/g, (c) => `^${c.toLowerCase()}`);
  return encoded.length <= MAX_ENCODED_NAME ? `${encoded}.json` : `#${sha256Hex(id)}.json`;
}

export function createFilePersistence(dir: string): DocPersistence {
  const root = resolve(dir);
  const mutex = new KeyedMutex();

  const collectionDir = (collection: string): string => join(root, collection);
  const streamDir = (stream: string): string => join(root, STREAM_ROOT, stream);

  async function readCell<T>(path: string): Promise<Cell<T> | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      ignoreEnoent(err);
      return null;
    }
    return { env: JSON.parse(text) as FileEnvelope<T>, etag: etagOf(text) };
  }

  async function acquire(lockPath: string): Promise<() => Promise<void>> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
        } finally {
          await handle.close();
        }
        return async () => {
          await unlink(lockPath).catch(ignoreEnoent);
        };
      } catch (err) {
        if (codeOf(err) !== "EEXIST") throw err;
      }
      // Breaking a stale lock is racy if two processes break it at once. It can
      // only happen after a writer crashed while holding it for 30s, which is
      // acceptable for local development and irrelevant in production (Blob).
      const age = await stat(lockPath).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await unlink(lockPath).catch(ignoreEnoent);
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`timed out waiting for lock ${lockPath}`);
      await sleep(Math.min(50, 2 + attempt) * (0.5 + Math.random()));
    }
  }

  async function withLock<R>(path: string, fn: () => Promise<R>): Promise<R> {
    return mutex.run(path, async () => {
      const release = await acquire(`${path}.lock`);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  const tempFor = (path: string): string => `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;

  async function writeAtomic(path: string, text: string): Promise<void> {
    const tmp = tempFor(path);
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  }

  /** True when this call created the file; false when it already existed. */
  async function createExclusive(path: string, text: string): Promise<boolean> {
    const tmp = tempFor(path);
    await writeFile(tmp, text, "utf8");
    try {
      await link(tmp, path);
      return true;
    } catch (err) {
      const code = codeOf(err);
      if (code === "EEXIST") return false;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw err;
      // No hard links on this filesystem. Still safe: we hold the lock, and every
      // writer of this path takes it.
      const exists = await stat(path).then(
        () => true,
        (e: unknown) => {
          ignoreEnoent(e);
          return false;
        },
      );
      if (exists) return false;
      await rename(tmp, path);
      return true;
    } finally {
      await unlink(tmp).catch(ignoreEnoent);
    }
  }

  function stored<T>(text: string): StoredDoc<T> {
    return { doc: (JSON.parse(text) as FileEnvelope<T>).doc, etag: etagOf(text) };
  }

  async function createIn<T>(dirPath: string, id: string, doc: T): Promise<StoredDoc<T> | null> {
    const path = join(dirPath, fileNameFor(id));
    const text = serialise({ id, doc });
    await mkdir(dirPath, { recursive: true });
    return withLock(path, async () => ((await createExclusive(path, text)) ? stored<T>(text) : null));
  }

  async function listDir<T>(dirPath: string): Promise<Cell<T>[]> {
    let names: string[];
    try {
      names = await readdir(dirPath);
    } catch (err) {
      ignoreEnoent(err);
      return [];
    }
    // `.lock` and `.tmp-*` siblings do not end in `.json`.
    const files = names.filter((n) => n.endsWith(".json"));
    const cells = await mapLimit(files, READ_CONCURRENCY, (n) => readCell<T>(join(dirPath, n)));
    return cells
      .filter((c): c is Cell<T> => c !== null)
      .sort((a, b) => compareIds(a.env.id, b.env.id));
  }

  return {
    id: "file",

    async get<T>(collection: string, id: string): Promise<StoredDoc<T> | null> {
      assertCollection(collection);
      assertId(id);
      const cell = await readCell<T>(join(collectionDir(collection), fileNameFor(id)));
      return cell === null ? null : { doc: cell.env.doc, etag: cell.etag };
    },

    async create<T>(collection: string, id: string, doc: T): Promise<StoredDoc<T> | null> {
      assertCollection(collection);
      assertId(id);
      return createIn(collectionDir(collection), id, doc);
    },

    async replace<T>(collection: string, id: string, doc: T, ifMatch: string): Promise<StoredDoc<T> | null> {
      assertCollection(collection);
      assertId(id);
      const dirPath = collectionDir(collection);
      const path = join(dirPath, fileNameFor(id));
      const text = serialise({ id, doc });
      await mkdir(dirPath, { recursive: true });
      return withLock(path, async () => {
        // Read and compare under the lock: no writer can land between the
        // comparison and the rename.
        const current = await readCell<T>(path);
        if (current === null || current.etag !== ifMatch) return null;
        await writeAtomic(path, text);
        return stored<T>(text);
      });
    },

    async put<T>(collection: string, id: string, doc: T): Promise<StoredDoc<T>> {
      assertCollection(collection);
      assertId(id);
      const dirPath = collectionDir(collection);
      const path = join(dirPath, fileNameFor(id));
      const text = serialise({ id, doc });
      await mkdir(dirPath, { recursive: true });
      return withLock(path, async () => {
        await writeAtomic(path, text);
        return stored<T>(text);
      });
    },

    async delete(collection: string, id: string): Promise<void> {
      assertCollection(collection);
      assertId(id);
      const dirPath = collectionDir(collection);
      const path = join(dirPath, fileNameFor(id));
      await mkdir(dirPath, { recursive: true });
      await withLock(path, async () => {
        await unlink(path).catch(ignoreEnoent);
      });
    },

    async list<T>(collection: string): Promise<StoredDoc<T>[]> {
      assertCollection(collection);
      const cells = await listDir<T>(collectionDir(collection));
      return cells.map((c) => ({ doc: c.env.doc, etag: c.etag }));
    },

    async append<T>(stream: string, id: string, entry: T): Promise<void> {
      assertStream(stream);
      assertId(id);
      const created = await createIn(streamDir(stream), id, entry);
      if (created === null) throw new StreamEntryExistsError(stream, id);
    },

    async readStream<T>(stream: string, opts: { readonly limit: number; readonly newestFirst: boolean }): Promise<T[]> {
      assertStream(stream);
      const cells = await listDir<T>(streamDir(stream));
      const byId = new Map(cells.map((c) => [c.env.id, c.env.doc] as const));
      const ids = pickStreamIds([...byId.keys()], opts.limit, opts.newestFirst);
      return ids.map((id) => byId.get(id) as T);
    },
  };
}
