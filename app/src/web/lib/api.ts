/**
 * The one place every HTTP request lives.
 *
 * Written strictly against API_CONTRACT.md. No endpoint, header or body shape is
 * invented here, and no screen is allowed to call `fetch` directly — when the API
 * stream lands, this file is the only surface that has to agree with it.
 */

import type {
  Anchor,
  Booking,
  IsoDate,
  IsoDateTime,
  Money,
  Policy,
  PolicyVerdict,
  PriceDriftDetail,
  RankedOffer,
  SearchQuery,
  SourceLogEntry,
  Traveller,
} from "../../core/types.ts";

const BASE = "/api";

// ---------- errors ----------

/** Every non-2xx, plus the unreachable-server case as `status: 0`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;

  constructor(status: number, code: string, message: string, detail: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** A message worth showing a human, whatever was thrown. */
export function messageOf(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error && e.message.length > 0) return e.message;
  return "Something went wrong. Try again.";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function readErrorBody(body: unknown): { code: string; message: string; detail: unknown } | null {
  if (!isRecord(body)) return null;
  const wrapped = body["error"];
  if (!isRecord(wrapped)) return null;
  const code = wrapped["code"];
  const message = wrapped["message"];
  return {
    code: typeof code === "string" ? code : "unexpected_error",
    message: typeof message === "string" ? message : "The request failed.",
    detail: wrapped["detail"],
  };
}

// ---------- transport ----------

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      headers,
      body: opts.body === undefined ? null : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(
      0,
      "network_unreachable",
      "The server did not answer. Check that the API is running, then try again.",
      undefined,
    );
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
  }

  if (!res.ok) {
    const err = readErrorBody(parsed);
    throw new ApiError(
      res.status,
      err?.code ?? "unexpected_error",
      err?.message ?? `The request failed (${res.status}).`,
      err?.detail,
    );
  }

  return parsed as T;
}

// ---------- auth ----------

export async function login(email: string, name?: string): Promise<{ traveller: Traveller }> {
  const body: { email: string; name?: string } = { email };
  if (name !== undefined && name.trim().length > 0) body.name = name.trim();
  return request<{ traveller: Traveller }>("/auth/login", { method: "POST", body });
}

export async function logout(): Promise<void> {
  await request<void>("/auth/logout", { method: "POST" });
}

export async function me(): Promise<{ traveller: Traveller }> {
  return request<{ traveller: Traveller }>("/me");
}

// ---------- search ----------

export interface SourceDescriptor {
  readonly id: string;
  readonly displayName: string;
}

export interface CreateSearchBody {
  readonly anchorQuery: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly guests: number;
  readonly rooms: number;
}

export interface SearchCreated {
  readonly searchId: string;
  readonly anchor: Anchor;
  readonly query: SearchQuery;
  readonly sources: readonly SourceDescriptor[];
}

export interface SearchSnapshot {
  readonly searchId: string;
  readonly anchor: Anchor;
  readonly query: SearchQuery;
  readonly results: readonly RankedOffer[];
  readonly sources: readonly SourceDescriptor[];
  readonly blockedCount: number;
}

export async function createSearch(body: CreateSearchBody): Promise<SearchCreated> {
  return request<SearchCreated>("/search", { method: "POST", body });
}

export async function getSearch(searchId: string): Promise<SearchSnapshot> {
  return request<SearchSnapshot>(`/search/${encodeURIComponent(searchId)}`);
}

// ---------- the stream ----------

export type SourceStatus = "pending" | "answered" | "failed";

export interface SourceEvent {
  readonly sourceId: string;
  readonly status: SourceStatus;
  readonly offerCount: number;
  readonly durationMs: number;
}

export interface ResultsEvent {
  readonly results: readonly RankedOffer[];
  readonly answered: number;
  readonly total: number;
}

export interface DoneEvent {
  readonly answered: number;
  readonly total: number;
  readonly failed: number;
  readonly durationMs: number;
}

export interface SearchStreamHandlers {
  readonly onSource?: (e: SourceEvent) => void;
  readonly onResults?: (e: ResultsEvent) => void;
  readonly onDone?: (e: DoneEvent) => void;
  /** The transport dropped before `done`. The page degrades; it never errors. */
  readonly onStreamError?: () => void;
}

function onJson<T>(es: EventSource, name: string, cb: ((e: T) => void) | undefined): void {
  if (cb === undefined) return;
  es.addEventListener(name, (ev: Event) => {
    const data = (ev as MessageEvent<unknown>).data;
    if (typeof data !== "string") return;
    try {
      cb(JSON.parse(data) as T);
    } catch {
      /* a malformed frame is dropped, not surfaced */
    }
  });
}

/** Subscribes to the fan-out. Returns an unsubscribe that closes the socket. */
export function subscribeSearch(searchId: string, handlers: SearchStreamHandlers): () => void {
  const es = new EventSource(`${BASE}/search/${encodeURIComponent(searchId)}/events`, {
    withCredentials: true,
  });
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    es.close();
  };

  onJson<SourceEvent>(es, "source", handlers.onSource);
  onJson<ResultsEvent>(es, "results", handlers.onResults);
  onJson<DoneEvent>(es, "done", (e) => {
    handlers.onDone?.(e);
    close();
  });

  es.addEventListener("error", () => {
    if (closed) return;
    // EventSource reconnects on its own while CONNECTING; only a hard CLOSED
    // counts as a dropped stream.
    if (es.readyState === EventSource.CLOSED) {
      closed = true;
      handlers.onStreamError?.();
    }
  });

  return close;
}

// ---------- bookings ----------

export interface CreateBookingBody {
  readonly searchId: string;
  readonly offerId: string;
  readonly costCentre: string;
  readonly acceptedTotal: Money;
}

/** A fresh key per confirm intent. Reused verbatim when retrying the same intent. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function createBooking(
  body: CreateBookingBody,
  idempotencyKey: string,
): Promise<{ booking: Booking }> {
  return request<{ booking: Booking }>("/bookings", {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export async function listBookings(): Promise<{ bookings: readonly Booking[] }> {
  return request<{ bookings: readonly Booking[] }>("/bookings");
}

export async function getBooking(id: string): Promise<{ booking: Booking }> {
  return request<{ booking: Booking }>(`/bookings/${encodeURIComponent(id)}`);
}

export async function cancelBooking(id: string): Promise<{ booking: Booking }> {
  return request<{ booking: Booking }>(`/bookings/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
}

// ---------- admin ----------

export async function getPolicy(): Promise<{ policy: Policy }> {
  return request<{ policy: Policy }>("/admin/policy");
}

export async function getAdminBookings(): Promise<{ bookings: readonly Booking[] }> {
  return request<{ bookings: readonly Booking[] }>("/admin/bookings");
}

export async function getSourceLog(limit = 100): Promise<{ entries: readonly SourceLogEntry[] }> {
  return request<{ entries: readonly SourceLogEntry[] }>(`/admin/source-log?limit=${limit}`);
}

/** A real href, so the browser does the download. */
export const ADMIN_CSV_HREF = `${BASE}/admin/bookings.csv`;

// ---------- typed reads of `error.detail` ----------

export function asPriceDrift(detail: unknown): PriceDriftDetail | null {
  if (!isRecord(detail)) return null;
  const accepted = detail["acceptedTotal"];
  const current = detail["currentTotal"];
  const delta = detail["deltaMinor"];
  if (!isMoney(accepted) || !isMoney(current) || typeof delta !== "number") return null;
  const message = detail["message"];
  return {
    kind: "price_drift",
    acceptedTotal: accepted,
    currentTotal: current,
    deltaMinor: delta,
    message: typeof message === "string" ? message : "",
  };
}

export function asVerdict(detail: unknown): PolicyVerdict | null {
  if (!isRecord(detail)) return null;
  const verdict = detail["verdict"];
  if (!isRecord(verdict)) return null;
  const state = verdict["state"];
  const reason = verdict["reason"];
  if (state !== "in" && state !== "blocked") return null;
  if (typeof reason !== "string") return null;
  return verdict as unknown as PolicyVerdict;
}

export function asDeclineCode(detail: unknown): string | null {
  if (!isRecord(detail)) return null;
  const code = detail["declineCode"];
  return typeof code === "string" ? code : null;
}

export function asCancellationDeadline(detail: unknown): IsoDateTime | null {
  if (!isRecord(detail)) return null;
  const deadline = detail["cancellationDeadline"];
  return typeof deadline === "string" ? deadline : null;
}

function isMoney(v: unknown): v is Money {
  return isRecord(v) && typeof v["minor"] === "number" && typeof v["currency"] === "string";
}
