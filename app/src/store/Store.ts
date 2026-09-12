import type {
  Booking,
  Policy,
  SourceLogEntry,
  Traveller,
} from "../core/types.ts";

/**
 * Persistence seam. Slice 1 ships a file-backed implementation so the app runs
 * anywhere with no native deps or database to provision; slice 2 swaps in
 * PostgreSQL behind this interface (spec §3.2 names Postgres as the target).
 *
 * The source log is append-only by contract: there is no update or delete.
 */
export interface Store {
  // travellers — JIT-created on first SSO login
  getTravellerByEmail(email: string): Promise<Traveller | null>;
  getTraveller(id: string): Promise<Traveller | null>;
  putTraveller(t: Traveller): Promise<void>;
  listTravellers(): Promise<Traveller[]>;

  // policy — versioned; every save increments version and keeps history
  getCurrentPolicy(entityId: string): Promise<Policy | null>;
  getPolicyVersion(entityId: string, version: number): Promise<Policy | null>;
  savePolicy(p: Policy): Promise<void>;

  // bookings
  getBooking(id: string): Promise<Booking | null>;
  getBookingByIdempotencyKey(key: string): Promise<Booking | null>;
  putBooking(b: Booking): Promise<void>;
  listBookingsForTraveller(travellerId: string): Promise<Booking[]>;
  listBookingsForEntity(entityId: string): Promise<Booking[]>;

  // append-only supplier log
  appendSourceLog(e: SourceLogEntry): Promise<void>;
  listSourceLog(limit: number): Promise<SourceLogEntry[]>;
}
