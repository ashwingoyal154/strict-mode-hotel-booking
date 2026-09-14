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

/**
 * Domain persistence. One implementation (FileStore.ts) over the DocPersistence
 * port, so memory, file and Vercel Blob behave identically — including under
 * concurrency, which is where stores usually disagree.
 *
 * `mutate*` methods are compare-and-swap loops: read, apply the pure function,
 * replace-if-unchanged, retry on conflict. The function must be pure because it
 * can run more than once.
 */
export type Mutator<T> = (current: T) => T;

export class ConcurrentUpdateError extends Error {
  constructor(readonly collection: string, readonly id: string) {
    super(`concurrent update conflict on ${collection}/${id} after retries`);
    this.name = "ConcurrentUpdateError";
  }
}

export class NotFoundError extends Error {
  constructor(readonly collection: string, readonly id: string) {
    super(`${collection}/${id} not found`);
    this.name = "NotFoundError";
  }
}

export interface IdempotencyRecord {
  readonly key: string;
  readonly travellerId: string;
  /** stableHash of the request body: the same key with a different body is a conflict. */
  readonly requestHash: string;
  readonly createdAt: IsoDateTime;
  readonly state: "in_flight" | "completed";
  readonly bookingId: string | null;
}

export interface ActionTokenUse {
  readonly tokenId: string;
  readonly approvalId: string;
  readonly consumedAt: IsoDateTime;
}

export interface Store {
  // travellers
  getTravellerByEmail(email: string): Promise<Traveller | null>;
  getTraveller(id: string): Promise<Traveller | null>;
  putTraveller(t: Traveller): Promise<void>;
  mutateTraveller(id: string, fn: Mutator<Traveller>): Promise<Traveller>;
  listTravellers(entityId: string): Promise<Traveller[]>;

  // legal entity
  getEntity(id: string): Promise<LegalEntity | null>;
  putEntity(e: LegalEntity): Promise<void>;

  // policy — versioned; every save increments version and keeps history
  getCurrentPolicy(entityId: string): Promise<Policy | null>;
  getPolicyVersion(entityId: string, version: number): Promise<Policy | null>;
  savePolicy(p: Policy): Promise<void>;

  // monthly FX pins
  getFxPins(month: IsoMonth): Promise<FxRate[]>;
  putFxPins(month: IsoMonth, rates: readonly FxRate[]): Promise<void>;

  // idempotency — atomic across instances
  reserveIdempotencyKey(
    rec: Omit<IdempotencyRecord, "state" | "bookingId">,
  ): Promise<{ readonly reserved: true } | { readonly reserved: false; readonly existing: IdempotencyRecord }>;
  completeIdempotencyKey(key: string, bookingId: string): Promise<void>;
  /** After a retryable failure, so the traveller can try again on the same key. */
  releaseIdempotencyKey(key: string): Promise<void>;

  // bookings
  getBooking(id: string): Promise<Booking | null>;
  getBookingByIdempotencyKey(key: string): Promise<Booking | null>;
  putBooking(b: Booking): Promise<void>;
  mutateBooking(id: string, fn: Mutator<Booking>): Promise<Booking>;
  listBookingsForTraveller(travellerId: string): Promise<Booking[]>;
  listBookingsForEntity(entityId: string): Promise<Booking[]>;

  // approvals
  getApproval(id: string): Promise<ApprovalRequest | null>;
  putApproval(a: ApprovalRequest): Promise<void>;
  mutateApproval(id: string, fn: Mutator<ApprovalRequest>): Promise<ApprovalRequest>;
  listApprovals(entityId: string, filter?: { readonly state?: ApprovalState }): Promise<ApprovalRequest[]>;

  // notifications
  putNotification(n: NotificationRecord): Promise<void>;
  listNotificationsFor(recipientId: string, limit: number): Promise<NotificationRecord[]>;
  mutateNotification(id: string, fn: Mutator<NotificationRecord>): Promise<NotificationRecord>;
  deleteNotificationsFor(recipientId: string): Promise<number>;

  // invoices
  getInvoice(id: string): Promise<Invoice | null>;
  getInvoiceForBooking(bookingId: string): Promise<Invoice | null>;
  /** Create-only. Resolves false if an invoice for this booking already exists. */
  createInvoice(inv: Invoice): Promise<boolean>;
  /** Atomic per (entity, financial year). Never reuses or skips a number under concurrency. */
  nextInvoiceSequence(entityId: string, financialYear: string): Promise<number>;

  // one-tap approval links are single-use
  /** Resolves true the first time a token is consumed, false every time after. */
  consumeActionToken(use: ActionTokenUse): Promise<boolean>;

  // card events — the virtual-card decline rate is a launch metric (S3)
  appendCardEvent(e: CardEvent): Promise<void>;
  listCardEvents(entityId: string): Promise<CardEvent[]>;

  // search history — 30-day retention
  putSearchRecord(r: SearchRecord): Promise<void>;
  listSearchRecordsFor(travellerId: string): Promise<SearchRecord[]>;
  deleteSearchRecordsFor(travellerId: string): Promise<number>;
  purgeSearchRecordsBefore(cutoff: IsoDateTime): Promise<number>;

  // append-only supplier log
  appendSourceLog(e: SourceLogEntry): Promise<void>;
  listSourceLog(limit: number): Promise<SourceLogEntry[]>;
  listSourceLogByCorrelation(correlationIds: readonly string[]): Promise<SourceLogEntry[]>;
}
