/**
 * EscalationLadder — the approver chain as a vertical list, and the audit trail
 * made visible.
 *
 * Past levels are struck through in muted mono with the time they were passed
 * over; the current level is at full ink; future levels are faint. Strike-through
 * is not announced by screen readers, so every row also says what happened in
 * words. Anyone at or below the current level may still decide, so whoever decided
 * is shown at full ink wherever they sit in the chain.
 */

import type { ApprovalPerson, ApprovalView } from "../lib/api.ts";
import { formatClock } from "../lib/fmt.ts";

type StepStatus = "past" | "current" | "future" | "decider";

function describeStep(
  approval: ApprovalView,
  person: ApprovalPerson,
  status: StepStatus,
  now: Date,
): string {
  const { sla } = approval;
  if (status === "decider") {
    const at = approval.decidedAt === null ? "" : ` ${formatClock(approval.decidedAt, now)}`;
    return `${approval.state}${at}`;
  }
  if (status === "past") {
    const next = approval.levels.find((l) => l.level === person.level + 1);
    const own = approval.levels.find((l) => l.level === person.level);
    const at = next?.startedAt ?? own?.dueAt ?? null;
    return at === null ? "passed over" : `passed over ${formatClock(at, now)}`;
  }
  if (status === "current") {
    if (approval.state === "withdrawn") return "request withdrawn";
    if (approval.state !== "pending") return "not needed";
    if (sla.breached) return sla.atTop ? "overdue · top of the chain" : "overdue";
    return `deciding · due ${formatClock(sla.dueAt, now)}`;
  }
  if (approval.state !== "pending") return "not reached";
  return person.level === sla.level + 1 ? "next, if overdue" : "after that";
}

export function EscalationLadder({ approval }: { readonly approval: ApprovalView }): JSX.Element | null {
  const people = [...approval.approvers].sort((a, b) => a.level - b.level);
  if (people.length === 0) return null;
  const now = new Date();

  return (
    <section className="esc-ladder" aria-labelledby={`ladder-${approval.id}`}>
      <span className="label" id={`ladder-${approval.id}`}>
        Escalation ladder
      </span>
      <ol className="esc-ladder__list">
        {people.map((p) => {
          const status: StepStatus =
            approval.decidedBy !== null && approval.decidedBy === p.id
              ? "decider"
              : p.level < approval.sla.level
                ? "past"
                : p.level === approval.sla.level
                  ? "current"
                  : "future";
          return (
            <li key={`${p.id}-${p.level}`} className="esc-ladder__step" data-status={status}>
              <span className="esc-ladder__level">L{p.level + 1}</span>
              <span className="esc-ladder__name">{status === "past" ? <s>{p.name}</s> : p.name}</span>
              <span className="esc-ladder__note">{describeStep(approval, p, status, now)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
