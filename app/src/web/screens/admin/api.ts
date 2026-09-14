/**
 * Slice 2 approver and admin requests, written strictly against API_CONTRACT.md
 * → "Slice 2". Nothing here invents a route, header or body shape.
 *
 * `lib/api.ts` keeps its transport private, so this file carries a thin one of
 * its own that parses the error envelope identically and throws the same exported
 * `ApiError`. Screens therefore handle one error type everywhere.
 */

import type {
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalState,
  Booking,
  Currency,
  DataExport,
  DirectoryEntry,
  ErasureReceipt,
  FxRate,
  InMarketTraveller,
  IsoDate,
  IsoDateTime,
  IsoMonth,
  Policy,
  TravelAdvisory,
  Traveller,
} from "../../../core/types.ts";
import { ApiError } from "../../lib/api.ts";

const BASE = "/api";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

interface Req {
  readonly method?: "GET" | "POST" | "PUT";
  readonly body?: unknown;
}

async function call<T>(path: string, opts: Req = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
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
    const wrapped = isRecord(parsed) ? parsed["error"] : undefined;
    const code = isRecord(wrapped) && typeof wrapped["code"] === "string" ? wrapped["code"] : "unexpected_error";
    const message =
      isRecord(wrapped) && typeof wrapped["message"] === "string"
        ? wrapped["message"]
        : `The request failed (${res.status}).`;
    throw new ApiError(res.status, code, message, isRecord(wrapped) ? wrapped["detail"] : undefined);
  }

  return parsed as T;
}

const enc = encodeURIComponent;

// ---------- approvals ----------

export interface ApproverRef {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly level: number;
}

export interface SlaView {
  readonly level: number;
  readonly approverId: string;
  readonly approverName: string;
  readonly dueAt: IsoDateTime;
  readonly remainingMs: number;
  readonly breached: boolean;
  readonly atTop: boolean;
  readonly nextApproverName: string | null;
}

export interface ApprovalView extends ApprovalRequest {
  readonly booking: Booking;
  readonly traveller: { readonly id: string; readonly name: string; readonly email: string };
  readonly approvers: readonly ApproverRef[];
  readonly sla: SlaView;
}

export type Decision = "approve" | "reject";

export interface DecisionResult {
  readonly approval: ApprovalView;
  readonly booking: Booking;
}

export function listApprovals(
  scope: "mine" | "entity",
  state: ApprovalState,
): Promise<{ approvals: readonly ApprovalView[] }> {
  return call(`/approvals?scope=${scope}&state=${state}`);
}

export function decide(
  approvalId: string,
  decision: Decision,
  note: string | null,
  actionToken?: string,
): Promise<DecisionResult> {
  const body: { decision: Decision; note?: string; actionToken?: string } = { decision };
  if (note !== null && note.trim().length > 0) body.note = note.trim();
  if (actionToken !== undefined) body.actionToken = actionToken;
  return call(`/approvals/${enc(approvalId)}/decision`, { method: "POST", body });
}

export type TokenPreview =
  | {
      readonly valid: true;
      readonly decision: Decision;
      readonly approval: ApprovalView;
      readonly approverName: string;
    }
  | { readonly valid: false; readonly reason: string };

export function previewActionToken(token: string): Promise<TokenPreview> {
  return call(`/approvals/action/${enc(token)}`);
}

export type { ApprovalOutcome };

// ---------- admin: policy ----------

export type PolicyBody = Omit<Policy, "version" | "updatedAt" | "updatedBy">;

export function getPolicy(): Promise<{ policy: Policy }> {
  return call("/admin/policy");
}

export function putPolicy(body: PolicyBody): Promise<{ policy: Policy }> {
  return call("/admin/policy", { method: "PUT", body });
}

// ---------- admin: exceptions ----------

export function listExceptions(state: ApprovalState | null): Promise<{ approvals: readonly ApprovalView[] }> {
  return call(state === null ? "/admin/approvals" : `/admin/approvals?state=${state}`);
}

// ---------- admin: duty of care ----------

export interface CountryCount {
  readonly countryCode: string;
  readonly count: number;
  /** The contract names the field without a shape; both plausible shapes are read. */
  readonly advisories: readonly TravelAdvisory[] | number;
}

export interface InMarket {
  readonly date: IsoDate;
  readonly travellers: readonly InMarketTraveller[];
  readonly byCountry: readonly CountryCount[];
}

export function getInMarket(date: IsoDate): Promise<InMarket> {
  return call(`/admin/in-market?date=${enc(date)}`);
}

// ---------- admin: directory ----------

export type DirectoryTraveller = Traveller & { readonly managerName: string | null };

export interface DirectoryUpload {
  readonly created: number;
  readonly updated: number;
  readonly unresolvedManagers: readonly string[];
  readonly cycles: readonly string[];
}

export function getDirectory(): Promise<{ travellers: readonly DirectoryTraveller[] }> {
  return call("/admin/directory");
}

export function uploadDirectoryCsv(csv: string): Promise<DirectoryUpload> {
  return call("/admin/directory", { method: "POST", body: { csv } });
}

export type { DirectoryEntry };

// ---------- admin: fx pins ----------

export interface FxPinInput {
  readonly base: Currency;
  readonly quote: Currency;
  readonly rateMicros: number;
}

export function getFxPins(month: IsoMonth): Promise<{ month: IsoMonth; rates: readonly FxRate[] }> {
  return call(`/admin/fx-pins?month=${enc(month)}`);
}

export function putFxPins(
  month: IsoMonth,
  rates: readonly FxPinInput[],
): Promise<{ month: IsoMonth; rates: readonly FxRate[] }> {
  return call("/admin/fx-pins", { method: "PUT", body: { month, rates } });
}

// ---------- admin: data rights ----------

export function exportTraveller(id: string): Promise<DataExport> {
  return call(`/admin/travellers/${enc(id)}/export`);
}

export function eraseTraveller(id: string, confirmEmail: string): Promise<ErasureReceipt> {
  return call(`/admin/travellers/${enc(id)}/erase`, { method: "POST", body: { confirmEmail } });
}

// ---------- admin: metrics ----------

export interface Metrics {
  readonly bookings: number;
  readonly confirmed: number;
  readonly inPolicyRate: number | null;
  readonly approvals: {
    readonly total: number;
    readonly pending: number;
    readonly withinSlaRate: number | null;
    readonly rateLostRate: number | null;
  };
  readonly cards: {
    readonly issued: number;
    readonly issueDeclined: number;
    readonly deskDeclined: number;
    readonly declineRate: number | null;
  };
  /** Named without a shape in the contract: a count, or a breakdown of counts. */
  readonly invoices: number | Readonly<Record<string, number>>;
}

export function getMetrics(): Promise<Metrics> {
  return call("/admin/metrics");
}
