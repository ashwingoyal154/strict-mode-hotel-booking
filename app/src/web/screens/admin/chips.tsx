/**
 * State chips for the first column of every admin table, and for decided rows.
 *
 * Colour is reserved for verdicts, so only states that ARE verdicts take one:
 * pending (over cap, awaiting a yes) reads `over`, approved-and-booked reads `in`,
 * rejected reads `blocked`. Everything else is greyscale. Each chip carries its
 * word, so colour is never the only signal.
 */

import type { ApprovalOutcome, ApprovalState, BookingState, TravelAdvisory } from "../../../core/types.ts";

export type ChipTone = "in" | "over" | "blocked" | "neutral";

export function Chip({ tone, children }: { readonly tone: ChipTone; readonly children: string }): JSX.Element {
  return <span className={`achip achip--${tone}`}>{children}</span>;
}

export function ApprovalStateChip({
  state,
  outcome,
}: {
  readonly state: ApprovalState;
  readonly outcome: ApprovalOutcome | null;
}): JSX.Element {
  if (state === "pending") return <Chip tone="over">Pending</Chip>;
  if (state === "rejected") return <Chip tone="blocked">Rejected</Chip>;
  if (state === "withdrawn") return <Chip tone="neutral">Withdrawn</Chip>;
  if (outcome === null || outcome === "confirmed") return <Chip tone="in">Approved</Chip>;
  return <Chip tone="over">Approved · not booked</Chip>;
}

const OUTCOME_WORDS: Readonly<Record<ApprovalOutcome, string>> = {
  confirmed: "booked",
  rate_lost: "rate lost",
  sold_out: "sold out",
  card_declined: "card declined",
};

export function outcomeWord(outcome: ApprovalOutcome | null): string {
  return outcome === null ? "—" : OUTCOME_WORDS[outcome];
}

export function BookingStateChip({ state }: { readonly state: BookingState }): JSX.Element {
  const word = state.replace(/_/g, " ");
  if (state === "confirmed" || state === "settled") return <Chip tone="in">{word}</Chip>;
  if (state === "pending_approval") return <Chip tone="over">{word}</Chip>;
  return <Chip tone="neutral">{word}</Chip>;
}

export function AdvisoryChip({ advisory }: { readonly advisory: TravelAdvisory | null }): JSX.Element {
  if (advisory === null) return <Chip tone="neutral">No advisory</Chip>;
  return advisory.level === "high" ? <Chip tone="blocked">High advisory</Chip> : <Chip tone="over">Caution</Chip>;
}
