/**
 * Slice 1 persistence. Two implementations of the same `Store` contract:
 *
 *  - `createFileStore(dir)` — durable, zero native deps. Mutating state lands
 *    through a temp file + `rename`, so a crash mid-write can never leave a
 *    half-written record behind. The supplier log is append-only JSONL.
 *  - `createMemoryStore()` — the identical code over an in-memory file map,
 *    used by the API tests.
 *
 * The source log has no update and no delete path by construction (spec §3.3,
 * A18): the only writer is `appendSourceLog`, and it appends a line.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type {
  Booking,
  Policy,
  SourceLogEntry,
  Traveller,
} from "../core/types.ts";
import type { Store } from "./Store.ts";

const TRAVELLERS_FILE = "travellers.json";
const POLICIES_FILE = "policies.json";
const BOOKINGS_FILE = "bookings.json";
const SOURCE_LOG_FILE = "source-log.jsonl";

/** The only thing the two store flavours disagree about. */
interface Persistence {
  readText(name: string): Promise<string | null>;
  /** Must be atomic: readers see either the old bytes or the new, never a mix. */
  writeText(name: string, data: string): Promise<void>;
  appendText(name: string, data: string): Promise<void>;
}

function memoryPersistence(): Persistence {
  const files = new Map<string, string>();
  return {
    async readText(name) {
      return files.get(name) ?? null;
    },
    async writeText(name, data) {
      files.set(name, data);
    },
    async appendText(name, data) {
      files.set(name, (files.get(name) ?? "") + data);
    },
  };
}

function filePersistence(dir: string): Persistence {
  let made: Promise<void> | null = null;
  const ensureDir = (): Promise<void> => {
    made ??= mkdir(dir, { recursive: true }).then(() => undefined);
    return made;
  };
  return {
    async readText(name) {
      try {
        return await readFile(join(dir, name), "utf8");
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async writeText(name, data) {
      await ensureDir();
      const target = join(dir, name);
      const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      await writeFile(tmp, data, "utf8");
      await rename(tmp, target);
    },
    async appendText(name, data) {
      await ensureDir();
      await appendFile(join(dir, name), data, "utf8");
    },
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function parseArray<T>(text: string | null): T[] {
  if (text === null || text.trim() === "") return [];
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface StoreState {
  readonly travellers: Map<string, Traveller>;
  readonly policies: Map<string, Policy[]>;
  readonly bookings: Map<string, Booking>;
  readonly sourceLog: SourceLogEntry[];
}

function createStore(p: Persistence): Store {
  let state: StoreState | null = null;
  let loading: Promise<StoreState> | null = null;

  /** Serialises every read-modify-write so two concurrent puts cannot race. */
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  async function load(): Promise<StoreState> {
    const [travellersText, policiesText, bookingsText, logText] =
      await Promise.all([
        p.readText(TRAVELLERS_FILE),
        p.readText(POLICIES_FILE),
        p.readText(BOOKINGS_FILE),
        p.readText(SOURCE_LOG_FILE),
      ]);

    const travellers = new Map<string, Traveller>();
    for (const t of parseArray<Traveller>(travellersText)) travellers.set(t.id, t);

    const policies = new Map<string, Policy[]>();
    for (const pol of parseArray<Policy>(policiesText)) {
      const list = policies.get(pol.entityId) ?? [];
      list.push(pol);
      policies.set(pol.entityId, list);
    }
    for (const list of policies.values()) list.sort((a, b) => a.version - b.version);

    const bookings = new Map<string, Booking>();
    for (const b of parseArray<Booking>(bookingsText)) bookings.set(b.id, b);

    const sourceLog: SourceLogEntry[] = [];
    if (logText !== null) {
      for (const line of logText.split("\n")) {
        if (line.trim() === "") continue;
        try {
          sourceLog.push(JSON.parse(line) as SourceLogEntry);
        } catch {
          // A torn final line from a hard kill is skipped, never repaired:
          // the log is append-only, so rewriting it is not an option.
        }
      }
    }

    return { travellers, policies, bookings, sourceLog };
  }

  async function ready(): Promise<StoreState> {
    if (state !== null) return state;
    loading ??= load().then((s) => {
      state = s;
      return s;
    });
    return loading;
  }

  const flushTravellers = (s: StoreState): Promise<void> =>
    p.writeText(TRAVELLERS_FILE, JSON.stringify([...s.travellers.values()], null, 2));

  const flushPolicies = (s: StoreState): Promise<void> =>
    p.writeText(
      POLICIES_FILE,
      JSON.stringify([...s.policies.values()].flat(), null, 2),
    );

  const flushBookings = (s: StoreState): Promise<void> =>
    p.writeText(BOOKINGS_FILE, JSON.stringify([...s.bookings.values()], null, 2));

  const newestFirst = (a: Booking, b: Booking): number =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

  return {
    async getTravellerByEmail(email) {
      const s = await ready();
      const needle = email.trim().toLowerCase();
      for (const t of s.travellers.values()) {
        if (t.email.toLowerCase() === needle) return clone(t);
      }
      return null;
    },

    async getTraveller(id) {
      const s = await ready();
      const t = s.travellers.get(id);
      return t === undefined ? null : clone(t);
    },

    async putTraveller(t) {
      const s = await ready();
      return serial(async () => {
        s.travellers.set(t.id, clone(t));
        await flushTravellers(s);
      });
    },

    async listTravellers() {
      const s = await ready();
      return [...s.travellers.values()].map(clone);
    },

    async getCurrentPolicy(entityId) {
      const s = await ready();
      const list = s.policies.get(entityId);
      if (list === undefined || list.length === 0) return null;
      const latest = list[list.length - 1];
      return latest === undefined ? null : clone(latest);
    },

    async getPolicyVersion(entityId, version) {
      const s = await ready();
      const found = (s.policies.get(entityId) ?? []).find(
        (pol) => pol.version === version,
      );
      return found === undefined ? null : clone(found);
    },

    async savePolicy(pol) {
      const s = await ready();
      return serial(async () => {
        const list = s.policies.get(pol.entityId) ?? [];
        const at = list.findIndex((existing) => existing.version === pol.version);
        if (at >= 0) list[at] = clone(pol);
        else list.push(clone(pol));
        list.sort((a, b) => a.version - b.version);
        s.policies.set(pol.entityId, list);
        await flushPolicies(s);
      });
    },

    async getBooking(id) {
      const s = await ready();
      const b = s.bookings.get(id);
      return b === undefined ? null : clone(b);
    },

    async getBookingByIdempotencyKey(key) {
      const s = await ready();
      for (const b of s.bookings.values()) {
        if (b.idempotencyKey === key) return clone(b);
      }
      return null;
    },

    async putBooking(b) {
      const s = await ready();
      return serial(async () => {
        // Stored as a deep copy: the booking must never alias live supply.
        s.bookings.set(b.id, clone(b));
        await flushBookings(s);
      });
    },

    async listBookingsForTraveller(travellerId) {
      const s = await ready();
      return [...s.bookings.values()]
        .filter((b) => b.travellerId === travellerId)
        .sort(newestFirst)
        .map(clone);
    },

    async listBookingsForEntity(entityId) {
      const s = await ready();
      return [...s.bookings.values()]
        .filter((b) => b.entityId === entityId)
        .sort(newestFirst)
        .map(clone);
    },

    async appendSourceLog(e) {
      const s = await ready();
      return serial(async () => {
        const entry = clone(e);
        s.sourceLog.push(entry);
        await p.appendText(SOURCE_LOG_FILE, `${JSON.stringify(entry)}\n`);
      });
    },

    async listSourceLog(limit) {
      const s = await ready();
      const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
      if (n === 0) return [];
      return s.sourceLog.slice(-n).reverse().map(clone);
    },
  };
}

export function createFileStore(dir: string): Store {
  return createStore(filePersistence(dir));
}

export function createMemoryStore(): Store {
  return createStore(memoryPersistence());
}
