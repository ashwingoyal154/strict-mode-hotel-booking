/**
 * The DocPersistence contract, run against every backend: memory and file
 * always, and the real Vercel Blob store when SM_TEST_BLOB=1 and
 * BLOB_READ_WRITE_TOKEN are set.
 *
 * Concurrency tests deliberately spread contenders across two independent
 * persistence instances over the same storage. For file that means two lock
 * domains sharing one directory; for Blob it is the closest a test gets to two
 * serverless instances. Memory has a single instance by nature.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { del, list } from "@vercel/blob";

import type { SourceLogEntry } from "../../src/core/types.ts";
import type { DocPersistence } from "../../src/store/DocPersistence.ts";
import { createStore } from "../../src/store/FileStore.ts";
import type { Store } from "../../src/store/Store.ts";
import { createBlobPersistence } from "../../src/store/persistence/blob.ts";
import { createFilePersistence } from "../../src/store/persistence/file.ts";
import { createMemoryPersistence } from "../../src/store/persistence/memory.ts";
import { StreamEntryExistsError } from "../../src/store/persistence/shared.ts";

interface Backend {
  readonly name: string;
  readonly timeoutMs: number;
  setup(): Promise<void>;
  /** A persistence instance over the backend's shared storage; call twice for two "instances". */
  open(): DocPersistence;
  teardown(): Promise<void>;
}

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN ?? "";
const runBlob = process.env.SM_TEST_BLOB === "1" && blobToken.length > 0;

function memoryBackend(): Backend {
  let shared: DocPersistence | null = null;
  return {
    name: "memory",
    timeoutMs: 20_000,
    async setup() {
      shared = createMemoryPersistence();
    },
    open() {
      if (shared === null) throw new Error("memory backend not set up");
      return shared;
    },
    async teardown() {
      shared = null;
    },
  };
}

function fileBackend(): Backend {
  let dir = "";
  return {
    name: "file",
    timeoutMs: 30_000,
    async setup() {
      dir = await mkdtemp(join(tmpdir(), "sm-persistence-"));
    },
    open() {
      return createFilePersistence(dir);
    },
    async teardown() {
      if (dir !== "") await rm(dir, { recursive: true, force: true });
    },
  };
}

function blobBackend(): Backend {
  const prefix = `sm-test/${RUN}`;
  return {
    name: "blob",
    timeoutMs: 300_000,
    async setup() {},
    open() {
      return createBlobPersistence({ token: blobToken, prefix });
    },
    async teardown() {
      // Delete everything under this run's prefix, page by page.
      let remaining = 0;
      for (let pass = 0; pass < 3; pass++) {
        let cursor: string | undefined;
        do {
          const page = await list({ prefix: `${prefix}/`, token: blobToken, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
          for (let i = 0; i < page.blobs.length; i += 100) {
            await del(page.blobs.slice(i, i + 100).map((b) => b.url), { token: blobToken });
          }
          cursor = page.hasMore ? page.cursor : undefined;
        } while (cursor !== undefined);
        remaining = (await list({ prefix: `${prefix}/`, token: blobToken, limit: 1 })).blobs.length;
        if (remaining === 0) break;
      }
      timings.push({ backend: "blob", test: `cleanup (${remaining} blobs left)`, ms: 0 });
    },
  };
}

const backends: Backend[] = [memoryBackend(), fileBackend(), ...(runBlob ? [blobBackend()] : [])];

const timings: Array<{ backend: string; test: string; ms: number }> = [];

afterAll(() => {
  if (timings.length === 0) return;
  const rows = timings.map((t) => `  ${t.backend.padEnd(7)} ${String(Math.round(t.ms)).padStart(7)} ms  ${t.test}`);
  console.log(`persistence contract timings (run ${RUN})\n${rows.join("\n")}`);
});

function sourceEntry(id: string, at: string, correlationId: string): SourceLogEntry {
  return {
    id,
    at,
    sourceId: "fixture",
    operation: "book",
    correlationId,
    request: { id },
    response: { ok: true },
    errorMessage: null,
    durationMs: 12,
  };
}

for (const backend of backends) {
  describe(`DocPersistence contract: ${backend.name}`, () => {
    let a: DocPersistence;
    let b: DocPersistence;
    /** Stores over two instances, so store-level contenders are split across "instances" too. */
    let stores: [Store, Store];

    beforeAll(async () => {
      await backend.setup();
      a = backend.open();
      b = backend.open();
      stores = [createStore(a), createStore(b)];
    }, backend.timeoutMs);

    afterAll(async () => {
      await backend.teardown();
    }, backend.timeoutMs);

    const timed = (name: string, fn: () => Promise<void>): void => {
      it(
        name,
        async () => {
          const started = performance.now();
          try {
            await fn();
          } finally {
            timings.push({ backend: backend.name, test: name, ms: performance.now() - started });
          }
        },
        backend.timeoutMs,
      );
    };

    const pick = <T>(pair: readonly [T, T], i: number): T => pair[i % 2] as T;

    timed("a read immediately sees a write, on the same and on another instance", async () => {
      expect(await a.get("contract-rw", "doc-1")).toBeNull();

      const created = await a.create("contract-rw", "doc-1", { n: 1 });
      expect(created).not.toBeNull();
      const readBack = await a.get<{ n: number }>("contract-rw", "doc-1");
      expect(readBack).toEqual({ doc: { n: 1 }, etag: created?.etag });
      expect((await b.get<{ n: number }>("contract-rw", "doc-1"))?.doc).toEqual({ n: 1 });

      const replaced = await a.replace("contract-rw", "doc-1", { n: 2 }, created?.etag ?? "");
      expect(replaced?.doc).toEqual({ n: 2 });
      expect(await b.get("contract-rw", "doc-1")).toEqual({ doc: { n: 2 }, etag: replaced?.etag });

      const put = await b.put("contract-rw", "doc-1", { n: 3 });
      expect(await a.get("contract-rw", "doc-1")).toEqual({ doc: { n: 3 }, etag: put.etag });

      await a.delete("contract-rw", "doc-1");
      expect(await b.get("contract-rw", "doc-1")).toBeNull();
      await a.delete("contract-rw", "doc-1"); // deleting a missing doc is a no-op
    });

    // Regression. Every other case here uses small documents, and the real Blob run
    // passed 27/27 while every production approval, booking and index update failed.
    // Blob serves a document over ~1 KB compressed with a WEAK ETag (W/"…") that its
    // own ifMatch rejects. The etag used for the CAS here comes from a fresh read,
    // not from the write, because that is exactly the path production takes.
    timed("compare-and-swap works on a document large enough to be served compressed", async () => {
      const big = (n: number) => ({ n, pad: "x".repeat(6_000) });
      const created = await a.create("contract-large", "doc", big(1));
      expect(created).not.toBeNull();

      const read = await b.get<{ n: number; pad: string }>("contract-large", "doc");
      expect(read?.doc.n).toBe(1);
      const replaced = await b.replace("contract-large", "doc", big(2), read?.etag ?? "");
      expect(replaced, "CAS with an etag taken from a read must succeed").not.toBeNull();

      const [sa, sb] = stores;
      // Only the fields the store indexes on are real; the padding makes it large.
      await sa.putApproval({
        id: "apr_large",
        entityId: "acme",
        bookingId: "bkg_large",
        travellerId: "trv_large",
        state: "pending",
        chain: [],
        levels: [],
        createdAt: new Date().toISOString(),
        pad: "y".repeat(6_000),
      } as never);
      const mutated = await sb.mutateApproval("apr_large", (cur) => ({ ...cur, state: "approved" }) as never);
      expect((mutated as unknown as { state: string }).state).toBe("approved");
    });

    timed("create is create-if-absent: 10 concurrent creators yield exactly one winner", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => pick([a, b] as const, i).create("contract-create", "the-one", { creator: i })),
      );
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);

      const stored = await a.get<{ creator: number }>("contract-create", "the-one");
      expect(stored).toEqual(winners[0]);
      expect(await b.create("contract-create", "the-one", { creator: 99 })).toBeNull();
      expect((await a.get<{ creator: number }>("contract-create", "the-one"))?.doc).toEqual(winners[0]?.doc);
    });

    timed("replace is compare-and-swap: a stale etag returns null and changes nothing", async () => {
      const v1 = await a.create("contract-cas", "doc", { v: 1 });
      if (v1 === null) throw new Error("setup create failed");
      const v2 = await a.replace("contract-cas", "doc", { v: 2 }, v1.etag);
      expect(v2).not.toBeNull();
      expect(v2?.etag).not.toBe(v1.etag);

      expect(await b.replace("contract-cas", "doc", { v: 99 }, v1.etag)).toBeNull();
      expect((await a.get<{ v: number }>("contract-cas", "doc"))?.doc).toEqual({ v: 2 });
      expect(await a.replace("contract-cas", "never-created", { v: 1 }, v1.etag)).toBeNull();

      const racers = await Promise.all(
        Array.from({ length: 10 }, (_, i) => pick([a, b] as const, i).replace("contract-cas", "doc", { v: 100 + i }, v2?.etag ?? "")),
      );
      const won = racers.filter((r) => r !== null);
      expect(won).toHaveLength(1);
      expect((await b.get<{ v: number }>("contract-cas", "doc"))?.doc).toEqual(won[0]?.doc);
    });

    timed("ids round-trip verbatim and list stays inside its collection", async () => {
      const ids = ["a b/c", "é?#%&=+", "CaseSensitive", "casesensitive", "..", "x".repeat(300)];
      for (const [i, id] of ids.entries()) expect(await a.create("contract-list", id, { i, id })).not.toBeNull();
      await a.put("contract-list-other", "a b/c", { other: true });

      for (const [i, id] of ids.entries()) expect((await b.get("contract-list", id))?.doc).toEqual({ i, id });
      const listed = await b.list<{ i: number; id: string }>("contract-list");
      expect(listed.map((d) => d.doc.id)).toEqual([...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
      expect(await a.list("contract-list-other")).toHaveLength(1);
      expect(await a.list("contract-list-empty")).toEqual([]);
    });

    timed("streams are append-only, time-ordered and unreachable through the document API", async () => {
      for (const id of ["t3", "t1", "t5", "t2", "t4"]) await pick([a, b] as const, Number(id.slice(1))).append("contract-stream", id, { id });
      expect(await a.readStream<{ id: string }>("contract-stream", { limit: 3, newestFirst: true })).toEqual([
        { id: "t5" },
        { id: "t4" },
        { id: "t3" },
      ]);
      expect(await b.readStream<{ id: string }>("contract-stream", { limit: 2, newestFirst: false })).toEqual([{ id: "t1" }, { id: "t2" }]);
      expect(await a.readStream("contract-stream", { limit: 0, newestFirst: true })).toEqual([]);

      await expect(b.append("contract-stream", "t2", { id: "tampered" })).rejects.toBeInstanceOf(StreamEntryExistsError);
      expect(await a.readStream("contract-stream", { limit: 10, newestFirst: false })).toContainEqual({ id: "t2" });
      expect(await a.readStream("contract-stream", { limit: 10, newestFirst: false })).not.toContainEqual({ id: "tampered" });

      await expect(a.get("_stream", "t2")).rejects.toBeInstanceOf(RangeError);
      await expect(a.put("_stream", "t2", {})).rejects.toBeInstanceOf(RangeError);
      await expect(a.delete("_stream", "t2")).rejects.toBeInstanceOf(RangeError);
    });

    timed("nextInvoiceSequence: 20 concurrent callers get exactly 1..20", async () => {
      const numbers = await Promise.all(
        Array.from({ length: 20 }, (_, i) => pick(stores, i).nextInvoiceSequence("acme", "2026-27")),
      );
      expect([...numbers].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(await stores[0].nextInvoiceSequence("acme", "2026-27")).toBe(21);
      expect(await stores[1].nextInvoiceSequence("acme", "2027-28")).toBe(1);
      expect(await stores[1].nextInvoiceSequence("globex", "2026-27")).toBe(1);
    });

    timed("reserveIdempotencyKey: 10 concurrent reservations yield exactly one reserved", async () => {
      const rec = { key: "idem-key-contract-0001", travellerId: "trv_1", requestHash: "hash-a", createdAt: "2026-09-14T10:00:00.000Z" };
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => pick(stores, i).reserveIdempotencyKey(rec)));
      expect(results.filter((r) => r.reserved)).toHaveLength(1);
      for (const r of results) {
        if (!r.reserved) expect(r.existing).toMatchObject({ key: rec.key, requestHash: "hash-a", state: "in_flight", bookingId: null });
      }

      // Same key, different body: still returned as existing; the server turns it into 409.
      const conflicting = await stores[1].reserveIdempotencyKey({ ...rec, requestHash: "hash-b" });
      expect(conflicting.reserved).toBe(false);
      if (!conflicting.reserved) expect(conflicting.existing.requestHash).toBe("hash-a");
    });

    timed("consumeActionToken is true exactly once under concurrency", async () => {
      const use = { tokenId: "tok_contract_1", approvalId: "apr_1", consumedAt: "2026-09-14T10:00:00.000Z" };
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => pick(stores, i).consumeActionToken(use)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await stores[0].consumeActionToken(use)).toBe(false);
    });

    timed("the source log has no mutation path", async () => {
      // The Store exposes exactly three source-log operations, none of which mutates.
      const sourceLogMethods = Object.keys(stores[0]).filter((k) => /sourcelog/i.test(k)).sort();
      expect(sourceLogMethods).toEqual(["appendSourceLog", "listSourceLog", "listSourceLogByCorrelation"]);

      const e1 = sourceEntry("src_1", "2026-09-14T10:00:00.000Z", "corr_a");
      const e2 = sourceEntry("src_2", "2026-09-14T10:00:01.000Z", "corr_b");
      const e3 = sourceEntry("src_3", "2026-09-14T10:00:02.000Z", "corr_a");
      await Promise.all([stores[0].appendSourceLog(e1), stores[1].appendSourceLog(e2), stores[0].appendSourceLog(e3)]);

      expect((await stores[1].listSourceLog(2)).map((e) => e.id)).toEqual(["src_3", "src_2"]);
      expect((await stores[0].listSourceLogByCorrelation(["corr_a"])).map((e) => e.id)).toEqual(["src_1", "src_3"]);

      // Re-appending an existing entry is refused, and the original survives untouched.
      await expect(stores[1].appendSourceLog({ ...e1, errorMessage: "rewritten" })).rejects.toBeInstanceOf(StreamEntryExistsError);
      const all = await stores[0].listSourceLog(10);
      expect(all).toHaveLength(3);
      expect(all.find((e) => e.id === "src_1")?.errorMessage).toBeNull();
    });
  });
}

if (!runBlob) {
  describe("DocPersistence contract: blob", () => {
    it.skip("set SM_TEST_BLOB=1 and BLOB_READ_WRITE_TOKEN to run against Vercel Blob", () => undefined);
  });
}
