/**
 * Domain Store behaviour over memory and file persistence: indexes, ordering,
 * erasure-safe lookups, CAS retries and the exactly-once operations. The Blob
 * backend is covered by the persistence contract suite. The Store code above the
 * port is identical for every backend.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ApprovalRequest,
  Booking,
  CardEvent,
  Invoice,
  NotificationRecord,
  Policy,
  SearchRecord,
  Traveller,
} from "../../src/core/types.ts";
import { createFileStore, createMemoryStore, createStore } from "../../src/store/FileStore.ts";
import { ConcurrentUpdateError, NotFoundError, type Store } from "../../src/store/Store.ts";
import { createMemoryPersistence } from "../../src/store/persistence/memory.ts";

// The store only reads ids, owners, timestamps, keys and states. The rest of
// these large records is opaque to it, so fixtures carry just those fields.
const booking = (b: Pick<Booking, "id" | "travellerId" | "entityId" | "createdAt" | "idempotencyKey" | "state">): Booking =>
  ({ ...b, confirmationCode: "ABC234", cancelledAt: null }) as unknown as Booking;
const approval = (a: Pick<ApprovalRequest, "id" | "bookingId" | "travellerId" | "entityId" | "state" | "createdAt">): ApprovalRequest =>
  ({ ...a, decidedAt: null }) as unknown as ApprovalRequest;
const invoice = (i: Pick<Invoice, "id" | "bookingId" | "entityId" | "number">): Invoice =>
  ({ ...i, financialYear: "2026-27" }) as unknown as Invoice;
const policy = (version: number, capMinor: number, updatedAt: string): Policy =>
  ({
    version,
    entityId: "acme",
    caps: [{ cityTier: "metro", city: null, perNight: { minor: capMinor, currency: "INR" } }],
    updatedAt,
    updatedBy: "admin@acme.test",
  }) as unknown as Policy;

const traveller = (id: string, email: string, entityId = "acme", createdAt = "2026-09-01T00:00:00.000Z"): Traveller => ({
  id,
  email,
  name: `Traveller ${id}`,
  entityId,
  defaultCostCentre: "CC-1",
  isAdmin: false,
  createdAt,
  managerId: null,
  displayCurrency: null,
  erasedAt: null,
});

const notification = (id: string, recipientId: string, at: string): NotificationRecord => ({
  id,
  at,
  recipientId,
  channel: "in_app",
  kind: "approval_requested",
  subject: "s",
  body: "b",
  actionUrl: null,
  approvalId: null,
  bookingId: null,
  delivery: "sent",
  deliveryError: null,
  readAt: null,
});

const search = (id: string, travellerId: string, createdAt: string): SearchRecord => ({
  id,
  travellerId,
  entityId: "acme",
  anchor: { label: "BKC", geo: { lat: 19.06, lng: 72.86 }, city: "Mumbai", countryCode: "IN" },
  checkIn: "2026-09-20",
  checkOut: "2026-09-22",
  createdAt,
});

const cardEvent = (id: string, entityId: string, at: string): CardEvent => ({
  id,
  bookingId: "bkg_1",
  entityId,
  at,
  kind: "issued",
  declineCode: null,
  note: null,
});

const flavours: Array<{ name: string; make: () => Promise<{ store: Store; reopen: () => Store; cleanup: () => Promise<void> }> }> = [
  {
    name: "memory",
    make: async () => {
      const store = createMemoryStore();
      return { store, reopen: () => store, cleanup: async () => undefined };
    },
  },
  {
    name: "file",
    make: async () => {
      const dir = await mkdtemp(join(tmpdir(), "sm-store-"));
      return { store: createFileStore(dir), reopen: () => createFileStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  },
];

for (const flavour of flavours) {
  describe(`Store over ${flavour.name}`, () => {
    let store: Store;
    let reopen: () => Store;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ store, reopen, cleanup } = await flavour.make());
    });
    afterEach(async () => {
      await cleanup();
    });

    it("finds travellers by email case-insensitively, lists by entity, and forgets an erased email", async () => {
      await store.putTraveller(traveller("trv_asha", "Asha@Acme.test"));
      await store.putTraveller(traveller("trv_meera", "meera@acme.test", "acme", "2026-09-02T00:00:00.000Z"));
      await store.putTraveller(traveller("trv_other", "x@globex.test", "globex"));

      expect((await store.getTravellerByEmail(" asha@ACME.test "))?.id).toBe("trv_asha");
      expect((await reopen().listTravellers("acme")).map((t) => t.id)).toEqual(["trv_asha", "trv_meera"]);

      const erased = await store.mutateTraveller("trv_asha", (t) => ({
        ...t,
        name: "Erased traveller",
        email: "erased-abc@erased.invalid",
        erasedAt: "2026-09-14T00:00:00.000Z",
      }));
      expect(erased.email).toBe("erased-abc@erased.invalid");
      expect(await store.getTravellerByEmail("asha@acme.test")).toBeNull();
      expect((await store.getTravellerByEmail("erased-abc@erased.invalid"))?.id).toBe("trv_asha");
    });

    it("mutate is a CAS loop: 10 concurrent mutators lose no update", async () => {
      await store.putTraveller(traveller("trv_cas", "cas@acme.test"));
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.mutateTraveller("trv_cas", (t) => ({ ...t, name: `${t.name}|${i}` }))),
      );
      const name = (await store.getTraveller("trv_cas"))?.name ?? "";
      expect(name.split("|").slice(1).sort()).toEqual(Array.from({ length: 10 }, (_, i) => String(i)).sort());
    });

    it("throws NotFoundError for a missing document and ConcurrentUpdateError when retries run out", async () => {
      await expect(store.mutateBooking("bkg_missing", (b) => b)).rejects.toBeInstanceOf(NotFoundError);

      const base = createMemoryPersistence();
      const alwaysConflicting = createStore({ ...base, replace: async () => null }, { maxAttempts: 3 });
      await alwaysConflicting.putTraveller(traveller("trv_x", "x@acme.test"));
      await expect(alwaysConflicting.mutateTraveller("trv_x", (t) => ({ ...t, name: "changed" }))).rejects.toBeInstanceOf(
        ConcurrentUpdateError,
      );
    });

    it("keeps policy versions immutable and the current pointer monotonic", async () => {
      await store.savePolicy(policy(1, 1_000_000, "2026-09-01T00:00:00.000Z"));
      await store.savePolicy(policy(2, 1_200_000, "2026-09-02T00:00:00.000Z"));
      // A concurrent seed of the same version that differs only in updatedAt is the same save.
      await store.savePolicy(policy(1, 1_000_000, "2026-09-03T00:00:00.000Z"));

      expect((await store.getCurrentPolicy("acme"))?.version).toBe(2);
      expect((await store.getPolicyVersion("acme", 1))?.caps[0]?.perNight.minor).toBe(1_000_000);
      await expect(store.savePolicy(policy(2, 9_999_999, "2026-09-04T00:00:00.000Z"))).rejects.toBeInstanceOf(ConcurrentUpdateError);
      expect(await store.getCurrentPolicy("globex")).toBeNull();
    });

    it("round-trips entities and FX pins", async () => {
      expect(await store.getFxPins("2026-09")).toEqual([]);
      const rate = { base: "GBP", quote: "INR", rateMicros: 106_250_000, source: "pinned_monthly" as const, pinMonth: "2026-09", asOf: "2026-09-01T00:00:00.000Z" };
      await store.putFxPins("2026-09", [rate]);
      expect(await reopen().getFxPins("2026-09")).toEqual([rate]);
      expect(await store.getEntity("acme")).toBeNull();
    });

    it("idempotency: complete makes the key replay the booking; release frees only in-flight keys", async () => {
      const rec = { key: "idem-key-00000001", travellerId: "trv_asha", requestHash: "h1", createdAt: "2026-09-14T10:00:00.000Z" };
      expect(await store.reserveIdempotencyKey(rec)).toEqual({ reserved: true });

      await store.releaseIdempotencyKey(rec.key);
      expect(await store.reserveIdempotencyKey(rec)).toEqual({ reserved: true });

      const b = booking({ id: "bkg_1", travellerId: "trv_asha", entityId: "acme", createdAt: "2026-09-14T10:00:00.000Z", idempotencyKey: rec.key, state: "confirmed" });
      await store.putBooking(b);
      await store.completeIdempotencyKey(rec.key, b.id);
      await store.releaseIdempotencyKey(rec.key); // must not free a completed key

      const again = await store.reserveIdempotencyKey(rec);
      expect(again.reserved).toBe(false);
      if (!again.reserved) expect(again.existing).toMatchObject({ state: "completed", bookingId: "bkg_1" });
      expect((await store.getBookingByIdempotencyKey(rec.key))?.id).toBe("bkg_1");
      expect(await store.getBookingByIdempotencyKey("idem-key-unknown")).toBeNull();
    });

    it("lists bookings per traveller and entity, newest first, following mutations", async () => {
      const mk = (id: string, travellerId: string, entityId: string, day: number): Booking =>
        booking({ id, travellerId, entityId, createdAt: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`, idempotencyKey: `key-${id}-000000`, state: "confirmed" });
      await store.putBooking(mk("bkg_a", "trv_asha", "acme", 1));
      await store.putBooking(mk("bkg_b", "trv_asha", "acme", 3));
      await store.putBooking(mk("bkg_c", "trv_meera", "acme", 2));
      await store.putBooking(mk("bkg_d", "trv_x", "globex", 4));

      expect((await store.listBookingsForTraveller("trv_asha")).map((b) => b.id)).toEqual(["bkg_b", "bkg_a"]);
      expect((await reopen().listBookingsForEntity("acme")).map((b) => b.id)).toEqual(["bkg_b", "bkg_c", "bkg_a"]);

      const cancelled = await store.mutateBooking("bkg_a", (b) => ({ ...b, state: "cancelled" }));
      expect(cancelled.state).toBe("cancelled");
      expect((await store.getBooking("bkg_a"))?.state).toBe("cancelled");
    });

    it("filters approvals by state through the state-tagged index", async () => {
      const mk = (id: string, day: number): ApprovalRequest =>
        approval({ id, bookingId: `bkg_${id}`, travellerId: "trv_asha", entityId: "acme", state: "pending", createdAt: `2026-09-0${day}T00:00:00.000Z` });
      await store.putApproval(mk("apr_1", 1));
      await store.putApproval(mk("apr_2", 2));
      await store.mutateApproval("apr_1", (a) => ({ ...a, state: "approved" }));

      expect((await store.listApprovals("acme", { state: "pending" })).map((a) => a.id)).toEqual(["apr_2"]);
      expect((await store.listApprovals("acme", { state: "approved" })).map((a) => a.id)).toEqual(["apr_1"]);
      expect((await store.listApprovals("acme")).map((a) => a.id)).toEqual(["apr_2", "apr_1"]);
      expect(await store.listApprovals("globex")).toEqual([]);
    });

    it("lists the newest notifications up to a limit, mutates, and deletes per recipient", async () => {
      for (let i = 1; i <= 5; i++) await store.putNotification(notification(`ntf_${i}`, "trv_meera", `2026-09-14T10:0${i}:00.000Z`));
      await store.putNotification(notification("ntf_other", "trv_asha", "2026-09-14T11:00:00.000Z"));

      expect((await store.listNotificationsFor("trv_meera", 3)).map((n) => n.id)).toEqual(["ntf_5", "ntf_4", "ntf_3"]);
      const read = await store.mutateNotification("ntf_4", (n) => ({ ...n, readAt: "2026-09-14T12:00:00.000Z" }));
      expect(read.readAt).not.toBeNull();

      expect(await store.deleteNotificationsFor("trv_meera")).toBe(5);
      expect(await store.listNotificationsFor("trv_meera", 10)).toEqual([]);
      expect((await store.listNotificationsFor("trv_asha", 10)).map((n) => n.id)).toEqual(["ntf_other"]);
    });

    it("creates exactly one invoice per booking under concurrency", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.createInvoice(invoice({ id: `inv_${i}`, bookingId: "bkg_1", entityId: "acme", number: `ACME/26-27/${i}` }))),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.findIndex(Boolean);
      expect((await store.getInvoiceForBooking("bkg_1"))?.id).toBe(`inv_${winner}`);
      expect((await store.getInvoice(`inv_${winner}`))?.bookingId).toBe("bkg_1");
      expect(await store.getInvoiceForBooking("bkg_none")).toBeNull();
    });

    it("keeps card events per entity in time order", async () => {
      await store.appendCardEvent(cardEvent("ce_2", "acme", "2026-09-14T10:02:00.000Z"));
      await store.appendCardEvent(cardEvent("ce_1", "acme", "2026-09-14T10:01:00.000Z"));
      await store.appendCardEvent(cardEvent("ce_x", "Globex Ltd", "2026-09-14T10:00:00.000Z"));
      expect((await store.listCardEvents("acme")).map((e) => e.id)).toEqual(["ce_1", "ce_2"]);
      expect((await store.listCardEvents("Globex Ltd")).map((e) => e.id)).toEqual(["ce_x"]);
    });

    it("lists, deletes and purges search history by traveller and by age", async () => {
      await store.putSearchRecord(search("srch_old_a", "trv_asha", "2026-07-01T00:00:00.000Z"));
      await store.putSearchRecord(search("srch_new_a", "trv_asha", "2026-09-10T00:00:00.000Z"));
      await store.putSearchRecord(search("srch_old_m", "trv_meera", "2026-07-02T00:00:00.000Z"));
      await store.putSearchRecord(search("srch_new_m", "trv_meera", "2026-09-11T00:00:00.000Z"));

      expect((await store.listSearchRecordsFor("trv_asha")).map((s) => s.id)).toEqual(["srch_new_a", "srch_old_a"]);
      expect(await store.purgeSearchRecordsBefore("2026-08-15T00:00:00.000Z")).toBe(2);
      expect((await reopen().listSearchRecordsFor("trv_meera")).map((s) => s.id)).toEqual(["srch_new_m"]);
      expect(await store.deleteSearchRecordsFor("trv_asha")).toBe(1);
      expect(await store.listSearchRecordsFor("trv_asha")).toEqual([]);
      expect(await store.purgeSearchRecordsBefore("2026-08-15T00:00:00.000Z")).toBe(0);
    });
  });
}
