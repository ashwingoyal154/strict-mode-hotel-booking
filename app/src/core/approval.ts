/**
 * Hard approval for over-cap bookings (§2.6, A5).
 *
 * The request is a value, not a timer. Nothing here schedules anything: SLA
 * escalation is *materialised* from history whenever the request is read, so a
 * cron tick, an approver opening a link and an admin loading the exception list
 * all compute the same levels. The rule that makes that true is that a new level
 * starts at the previous level's `dueAt`, never at `now` — a request read seven
 * hours late carries exactly the history it would have had if someone had been
 * watching it every minute.
 *
 * And it never expires (§2.6: "It never silently expires"). Past the last
 * approver it is flagged `slaBreachedAtTop` and stays pending for a human.
 */

import type {
  ApprovalLevel,
  ApprovalOutcome,
  ApprovalRequest,
  Booking,
  IsoDateTime,
  Money,
  Policy,
  Traveller,
} from "./types.ts";
import { money, multiplyMoney } from "./money.ts";

/** Thrown when someone outside the chain, or above the current level, tries to decide. */
export class NotCurrentApproverError extends Error {
  readonly approvalId: string;
  readonly approverId: string;

  constructor(approvalId: string, approverId: string) {
    super(`${approverId} cannot decide approval ${approvalId} at its current level`);
    this.name = "NotCurrentApproverError";
    this.approvalId = approvalId;
    this.approverId = approverId;
  }
}

/** Thrown when a decision, withdrawal or outcome is applied to a request that is no longer open to it. */
export class AlreadyDecidedError extends Error {
  readonly approvalId: string;
  readonly state: ApprovalRequest["state"];

  constructor(approvalId: string, state: ApprovalRequest["state"]) {
    super(`Approval ${approvalId} is already ${state}`);
    this.name = "AlreadyDecidedError";
    this.approvalId = approvalId;
    this.state = state;
  }
}

/** Thrown when a rejection arrives without a note — the traveller is owed a reason. */
export class RejectionNoteRequiredError extends Error {
  constructor() {
    super("A rejection needs a note explaining why");
    this.name = "RejectionNoteRequiredError";
  }
}

const MIN_JUSTIFICATION_CHARS = 10;
const MS_PER_MINUTE = 60_000;

/**
 * Valid when the code is one of the policy's reasons and the trimmed text has at
 * least 10 characters (§2.6); otherwise a message the traveller can act on.
 */
export function validateJustification(
  policy: Policy,
  j: { code: string; text: string },
): { ok: true } | { ok: false; message: string } {
  if (!policy.approval.justificationReasons.some((r) => r.code === j.code)) {
    return { ok: false, message: "Choose one of the reasons your travel policy lists" };
  }
  // Counted in code points, so "Café à côté" is not penalised for its accents' encoding.
  if ([...j.text.trim()].length < MIN_JUSTIFICATION_CHARS) {
    return {
      ok: false,
      message: `Add a few words on why this hotel — at least ${MIN_JUSTIFICATION_CHARS} characters`,
    };
  }
  return { ok: true };
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Approver ids in escalation order: the manager chain upward (skipping erased
 * people and the traveller, cycle-safe, at most maxEscalations + 1), else fallback
 * approvers by email, else other admins, else [].
 */
export function resolveApproverChain(args: {
  traveller: Traveller;
  directory: readonly Traveller[];
  policy: Policy;
}): string[] {
  const { traveller, directory, policy } = args;
  const limit = Math.max(0, Math.floor(policy.approval.maxEscalations)) + 1;
  const byId = new Map<string, Traveller>();
  for (const person of directory) byId.set(person.id, person);

  const eligible = (p: Traveller): boolean => p.erasedAt === null && p.id !== traveller.id;

  const chain: string[] = [];
  // `visited` starts with the traveller, so a directory where someone's manager
  // chain loops back to the traveller terminates instead of approving themself.
  const visited = new Set<string>([traveller.id]);
  let next = traveller.managerId;
  while (next !== null && chain.length < limit && !visited.has(next)) {
    visited.add(next);
    const manager = byId.get(next);
    if (manager === undefined) break;
    // An erased manager cannot approve, but their own manager still can — the
    // walk continues past them rather than stranding the request.
    if (eligible(manager)) chain.push(manager.id);
    next = manager.managerId;
  }
  if (chain.length > 0) return chain;

  // Fallbacks stay inside the traveller's entity: approvals, like charges, never cross entities.
  const inEntity = directory.filter((p) => p.entityId === traveller.entityId && eligible(p));

  const fallback: string[] = [];
  for (const email of policy.approval.fallbackApproverEmails) {
    const person = inEntity.find((p) => sameEmail(p.email, email));
    if (person !== undefined && !fallback.includes(person.id) && fallback.length < limit) {
      fallback.push(person.id);
    }
  }
  if (fallback.length > 0) return fallback;

  return inEntity
    .filter((p) => p.isAdmin)
    .sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id))
    .slice(0, limit)
    .map((p) => p.id);
}

function isoAt(ms: number): IsoDateTime {
  return new Date(ms).toISOString();
}

function parseInstant(iso: IsoDateTime, what: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`${what} is not a valid instant: "${iso}"`);
  return ms;
}

/** The overage the approver is asked about, in the cap currency; zero when the verdict could not compute one. */
function overagePerNightOf(booking: Booking): Money {
  const verdict = booking.verdict;
  if (verdict.overage !== undefined && verdict.overage !== null) return verdict.overage;
  const currency = verdict.capPerNight?.currency ?? booking.offer.rate.currency;
  return money(verdict.overageMinor ?? 0, currency);
}

/**
 * Opens a pending request at level 0, due `slaMinutes` from `now`. Throws when the
 * chain is empty or the justification is invalid — both are refused before a
 * request exists, never discovered after.
 */
export function openApproval(args: {
  id: string;
  booking: Booking;
  justification: { code: string; text: string };
  chain: readonly string[];
  policy: Policy;
  now: Date;
}): ApprovalRequest {
  const { id, booking, justification, chain, policy, now } = args;
  const first = chain[0];
  if (first === undefined) throw new RangeError("An approval needs at least one approver");

  const valid = validateJustification(policy, justification);
  if (!valid.ok) throw new RangeError(valid.message);

  const slaMinutes = policy.approval.slaMinutes;
  if (!Number.isInteger(slaMinutes) || slaMinutes < 1) {
    throw new RangeError(`slaMinutes must be a positive integer, received ${String(slaMinutes)}`);
  }

  const startMs = now.getTime();
  const overagePerNight = overagePerNightOf(booking);

  return {
    id,
    bookingId: booking.id,
    travellerId: booking.travellerId,
    entityId: booking.entityId,
    state: "pending",
    justificationCode: justification.code,
    justificationText: justification.text.trim(),
    verdict: booking.verdict,
    overagePerNight,
    overageStay: multiplyMoney(overagePerNight, booking.offer.rate.nights),
    slaMinutes,
    chain: [...chain],
    levels: [
      {
        level: 0,
        approverId: first,
        startedAt: isoAt(startMs),
        dueAt: isoAt(startMs + slaMinutes * MS_PER_MINUTE),
        cause: "initial",
      },
    ],
    slaBreachedAtTop: false,
    createdAt: isoAt(startMs),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    outcome: null,
  };
}

/** The level the request currently sits at — the last materialised one. */
export function currentLevel(req: ApprovalRequest): ApprovalLevel {
  const last = req.levels[req.levels.length - 1];
  if (last === undefined) throw new RangeError(`Approval ${req.id} has no levels`);
  return last;
}

/**
 * Brings the level history up to `now`. Each breached level hands over at its own
 * `dueAt`, so any number of late reads yield the same levels as on-time ones.
 * The chain was capped at maxEscalations + 1 when it was resolved, so its length
 * is the escalation limit. Only pending requests escalate.
 */
export function materialiseEscalations(
  req: ApprovalRequest,
  now: Date,
): { approval: ApprovalRequest; escalated: readonly ApprovalLevel[] } {
  if (req.state !== "pending") return { approval: req, escalated: [] };

  const nowMs = now.getTime();
  const levels = [...req.levels];
  const escalated: ApprovalLevel[] = [];
  let breachedAtTop = req.slaBreachedAtTop;

  for (;;) {
    const last = levels[levels.length - 1];
    if (last === undefined) throw new RangeError(`Approval ${req.id} has no levels`);
    const dueMs = parseInstant(last.dueAt, "dueAt");
    // At the due instant the SLA is spent: remaining time is zero, not positive.
    if (nowMs < dueMs) break;

    const nextLevel = last.level + 1;
    const nextApprover = req.chain[nextLevel];
    if (nextApprover === undefined) {
      breachedAtTop = true;
      break;
    }
    const level: ApprovalLevel = {
      level: nextLevel,
      approverId: nextApprover,
      startedAt: last.dueAt,
      dueAt: isoAt(dueMs + req.slaMinutes * MS_PER_MINUTE),
      cause: "sla_breach",
    };
    levels.push(level);
    escalated.push(level);
  }

  if (escalated.length === 0 && breachedAtTop === req.slaBreachedAtTop) {
    return { approval: req, escalated };
  }
  return { approval: { ...req, levels, slaBreachedAtTop: breachedAtTop }, escalated };
}

/**
 * Whether this person may decide the request as stored: pending, and a chain
 * member at or below the current level. Escalation widens who may decide; it
 * never revokes an earlier approver.
 */
export function canDecide(req: ApprovalRequest, approverId: string): boolean {
  if (req.state !== "pending") return false;
  const position = req.chain.indexOf(approverId);
  return position >= 0 && position <= currentLevel(req).level;
}

/** The SLA as it stands at `now`, after materialising escalations: who decides, by when, and who is next. */
export function slaView(
  req: ApprovalRequest,
  now: Date,
): {
  level: number;
  approverId: string;
  dueAt: IsoDateTime;
  remainingMs: number;
  breached: boolean;
  atTop: boolean;
  nextApproverId: string | null;
} {
  const current = currentLevel(materialiseEscalations(req, now).approval);
  const remainingMs = parseInstant(current.dueAt, "dueAt") - now.getTime();
  return {
    level: current.level,
    approverId: current.approverId,
    dueAt: current.dueAt,
    remainingMs,
    breached: remainingMs <= 0,
    atTop: current.level >= req.chain.length - 1,
    nextApproverId: req.chain[current.level + 1] ?? null,
  };
}

/**
 * Records an approve or reject as of `now`, after materialising escalations.
 * Throws AlreadyDecidedError, NotCurrentApproverError or RejectionNoteRequiredError,
 * checked in that order.
 */
export function decide(
  req: ApprovalRequest,
  args: { approverId: string; decision: "approve" | "reject"; note: string | null; now: Date },
): ApprovalRequest {
  if (req.state !== "pending") throw new AlreadyDecidedError(req.id, req.state);

  const current = materialiseEscalations(req, args.now).approval;
  if (!canDecide(current, args.approverId)) throw new NotCurrentApproverError(req.id, args.approverId);

  const note = args.note === null ? "" : args.note.trim();
  if (args.decision === "reject" && note === "") throw new RejectionNoteRequiredError();

  return {
    ...current,
    state: args.decision === "approve" ? "approved" : "rejected",
    decidedAt: args.now.toISOString(),
    decidedBy: args.approverId,
    decisionNote: note === "" ? null : note,
  };
}

/** The traveller withdraws a pending request; history is materialised to `now` first so the record is complete. */
export function withdraw(req: ApprovalRequest, now: Date): ApprovalRequest {
  if (req.state !== "pending") throw new AlreadyDecidedError(req.id, req.state);
  const current = materialiseEscalations(req, now).approval;
  return {
    ...current,
    state: "withdrawn",
    decidedAt: now.toISOString(),
    decidedBy: req.travellerId,
    decisionNote: null,
  };
}

/**
 * Records what happened after an approval — an approval can succeed and the rate
 * still be lost. Only approved requests carry an outcome; re-recording the same
 * outcome is a no-op, and a different one throws AlreadyDecidedError.
 */
export function recordOutcome(req: ApprovalRequest, outcome: ApprovalOutcome): ApprovalRequest {
  if (req.state !== "approved") {
    throw new RangeError(`Only an approved request has an outcome; approval ${req.id} is ${req.state}`);
  }
  if (req.outcome === outcome) return req;
  if (req.outcome !== null) throw new AlreadyDecidedError(req.id, req.state);
  return { ...req, outcome };
}
