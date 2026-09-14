/**
 * Approval reads, views and approver notifications.
 *
 * **Every read materialises escalations** (core/approval.ts#materialiseEscalations)
 * so a late reader sees the history an on-time reader would have seen. The
 * escalation is written with the store's compare-and-swap, and the
 * `approval_escalated` notification is sent only by the caller whose CAS write
 * *recorded* that level. Two instances reading at the same instant both compute
 * the escalation, but only one write can move the document from "without level
 * n" to "with level n"; the loser's retry sees level n already present,
 * materialises nothing new, and notifies nobody. Exactly once, by construction.
 */

import {
  canDecide,
  currentLevel,
  materialiseEscalations,
  slaView,
} from "../core/approval.ts";
import { formatDeadline } from "../core/format.ts";
import type {
  ApprovalLevel,
  ApprovalRequest,
  ApprovalState,
  Booking,
  IsoDateTime,
  Traveller,
} from "../core/types.ts";
import { ConcurrentUpdateError, NotFoundError, type Store } from "../store/Store.ts";
import { withCorrelationId } from "./audit.ts";
import { notify, type NotifyDeps } from "./notify.ts";
import { actionUrl, issueActionToken } from "./tokens.ts";

export interface ApprovalDeps extends NotifyDeps {
  readonly publicBaseUrl: string;
}

export interface ApprovalSla {
  readonly level: number;
  readonly approverId: string;
  readonly approverName: string;
  readonly dueAt: IsoDateTime;
  readonly remainingMs: number;
  readonly breached: boolean;
  readonly atTop: boolean;
  readonly nextApproverName: string | null;
}

export type ApprovalView = ApprovalRequest & {
  readonly booking: Booking;
  readonly traveller: { readonly id: string; readonly name: string; readonly email: string };
  readonly approvers: ReadonlyArray<{ id: string; name: string; email: string; level: number }>;
  readonly sla: ApprovalSla;
};

/** Notifications are addressed in the entity's home zone; travellers carry none of their own. */
const NOTIFY_TIME_ZONE = "Asia/Kolkata";

export type TravellerLookup = (id: string) => Promise<Traveller | null>;

export function travellerLookup(store: Store): TravellerLookup {
  const memo = new Map<string, Promise<Traveller | null>>();
  return (id) => {
    let hit = memo.get(id);
    if (hit === undefined) {
      hit = store.getTraveller(id);
      memo.set(id, hit);
    }
    return hit;
  };
}

// ---------- materialisation ----------

export async function refreshApproval(
  deps: ApprovalDeps,
  approval: ApprovalRequest,
): Promise<{ approval: ApprovalRequest; escalated: readonly ApprovalLevel[] }> {
  if (approval.state !== "pending") return { approval, escalated: [] };
  const now = deps.now();
  const preview = materialiseEscalations(approval, now);
  if (preview.approval === approval) return { approval, escalated: [] };

  let won: readonly ApprovalLevel[] = [];
  let written: ApprovalRequest;
  try {
    written = await deps.store.mutateApproval(approval.id, (current) => {
      // Re-run on every CAS attempt: only the attempt that is finally written counts.
      const r = materialiseEscalations(current, now);
      won = r.escalated;
      return r.approval;
    });
  } catch (err) {
    if (err instanceof ConcurrentUpdateError) {
      // Someone else is writing this request right now; they own its notifications.
      return { approval: preview.approval, escalated: [] };
    }
    throw err;
  }

  if (won.length > 0) await notifyEscalations(deps, written, won);
  return { approval: written, escalated: won };
}

// ---------- views ----------

export async function buildApprovalView(
  deps: ApprovalDeps,
  approval: ApprovalRequest,
  lookup: TravellerLookup = travellerLookup(deps.store),
): Promise<ApprovalView> {
  const booking = await deps.store.getBooking(approval.bookingId);
  if (booking === null) throw new NotFoundError("bookings", approval.bookingId);
  const traveller = await lookup(approval.travellerId);
  const people = await Promise.all(approval.chain.map((id) => lookup(id)));
  const nameOf = (id: string | null): string | null => {
    if (id === null) return null;
    const index = approval.chain.indexOf(id);
    return (index >= 0 ? people[index]?.name : undefined) ?? "Unknown approver";
  };

  const s = slaView(approval, deps.now());
  return {
    ...approval,
    booking,
    traveller: {
      id: approval.travellerId,
      name: traveller?.name ?? "Unknown traveller",
      email: traveller?.email ?? "",
    },
    approvers: approval.chain.map((id, level) => ({
      id,
      name: people[level]?.name ?? "Unknown approver",
      email: people[level]?.email ?? "",
      level,
    })),
    sla: {
      level: s.level,
      approverId: s.approverId,
      approverName: nameOf(s.approverId) ?? "Unknown approver",
      dueAt: s.dueAt,
      remainingMs: s.remainingMs,
      breached: s.breached,
      atTop: s.atTop,
      nextApproverName: nameOf(s.nextApproverId),
    },
  };
}

export async function readApprovalView(
  deps: ApprovalDeps,
  approval: ApprovalRequest,
  lookup?: TravellerLookup,
): Promise<ApprovalView> {
  const { approval: fresh } = await refreshApproval(deps, approval);
  return buildApprovalView(deps, fresh, lookup);
}

export async function listApprovalViews(
  deps: ApprovalDeps,
  entityId: string,
  opts: { state?: ApprovalState; include?: (a: ApprovalRequest) => boolean } = {},
): Promise<ApprovalView[]> {
  // Materialise before filtering: a state filter on stale documents is wrong, and an
  // escalation can widen who a request belongs to.
  const stored = await deps.store.listApprovals(entityId);
  const refreshed = await Promise.all(stored.map(async (a) => (await refreshApproval(deps, a)).approval));
  const lookup = travellerLookup(deps.store);
  const chosen = refreshed
    .filter((a) => opts.state === undefined || a.state === opts.state)
    .filter((a) => opts.include === undefined || opts.include(a))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const views: ApprovalView[] = [];
  for (const a of chosen) {
    try {
      views.push(await buildApprovalView(deps, a, lookup));
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  return views;
}

/** `scope=mine`: the caller is in the chain at or below the current level. */
export function inMyScope(approval: ApprovalRequest, travellerId: string): boolean {
  const position = approval.chain.indexOf(travellerId);
  return position >= 0 && position <= currentLevel(approval).level;
}

export function canView(approval: ApprovalRequest, traveller: Traveller): boolean {
  if (approval.travellerId === traveller.id) return true;
  if (approval.chain.includes(traveller.id)) return true;
  return traveller.isAdmin && traveller.entityId === approval.entityId;
}

export async function countDecidable(deps: ApprovalDeps, traveller: Traveller): Promise<number> {
  const pending = await deps.store.listApprovals(traveller.entityId, { state: "pending" });
  let count = 0;
  for (const a of pending) {
    if (!a.chain.includes(traveller.id)) continue;
    const { approval } = await refreshApproval(deps, a);
    if (canDecide(approval, traveller.id)) count += 1;
  }
  return count;
}

// ---------- approver notifications ----------

function when(iso: IsoDateTime): string {
  return formatDeadline(iso, NOTIFY_TIME_ZONE);
}

export function decisionLinks(
  deps: ApprovalDeps,
  approvalId: string,
  approverId: string,
): { approveUrl: string; rejectUrl: string } {
  const now = deps.now();
  return {
    approveUrl: actionUrl(
      deps.publicBaseUrl,
      issueActionToken({ approvalId, approverId, decision: "approve", now }),
    ),
    rejectUrl: actionUrl(
      deps.publicBaseUrl,
      issueActionToken({ approvalId, approverId, decision: "reject", now }),
    ),
  };
}

function requestSummary(approval: ApprovalRequest, booking: Booking): string {
  return [
    `${booking.offer.property.name}, ${booking.offer.property.city} · ${booking.offer.rate.checkIn} to ${booking.offer.rate.checkOut}`,
    approval.verdict.reason,
    `Reason given: "${approval.justificationText}"`,
  ].join("\n");
}

export async function notifyApprovalRequested(
  deps: ApprovalDeps,
  approval: ApprovalRequest,
  booking: Booking,
  traveller: Traveller,
): Promise<void> {
  const level = currentLevel(approval);
  const approver = await deps.store.getTraveller(level.approverId);
  if (approver === null) return;
  const links = decisionLinks(deps, approval.id, approver.id);
  await withCorrelationId(booking.id, () =>
    notify(deps, {
      recipient: approver,
      kind: "approval_requested",
      subject: `${traveller.name} needs your approval · ${booking.offer.property.name}`,
      body: [
        requestSummary(approval, booking),
        `Decide by ${when(level.dueAt)}.`,
        `Approve: ${links.approveUrl}`,
        `Reject: ${links.rejectUrl}`,
      ].join("\n"),
      actionUrl: links.approveUrl,
      approvalId: approval.id,
      bookingId: booking.id,
    }),
  );
}

async function notifyEscalations(
  deps: ApprovalDeps,
  approval: ApprovalRequest,
  levels: readonly ApprovalLevel[],
): Promise<void> {
  const booking = await deps.store.getBooking(approval.bookingId);
  if (booking === null) return;
  const traveller = await deps.store.getTraveller(approval.travellerId);
  for (const level of levels) {
    const approver = await deps.store.getTraveller(level.approverId);
    if (approver === null) continue;
    const previousId = approval.chain[level.level - 1];
    const previous = previousId === undefined ? null : await deps.store.getTraveller(previousId);
    const links = decisionLinks(deps, approval.id, approver.id);
    await withCorrelationId(booking.id, () =>
      notify(deps, {
        recipient: approver,
        kind: "approval_escalated",
        subject: `Escalated to you · ${traveller?.name ?? "A traveller"} · ${booking.offer.property.name}`,
        body: [
          `${previous?.name ?? "The previous approver"} didn't decide by ${when(level.startedAt)}, so this request has moved up to you.`,
          requestSummary(approval, booking),
          `Decide by ${when(level.dueAt)}.`,
          `Approve: ${links.approveUrl}`,
          `Reject: ${links.rejectUrl}`,
        ].join("\n"),
        actionUrl: links.approveUrl,
        approvalId: approval.id,
        bookingId: booking.id,
      }),
    );
  }
}
