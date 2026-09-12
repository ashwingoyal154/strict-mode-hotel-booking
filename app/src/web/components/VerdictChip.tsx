/**
 * VerdictChip — square, 1px border in its own semantic colour, mono uppercase.
 * Three variants only, and the chip always carries its word: verdict is never
 * conveyed by colour alone.
 *
 * Slice 1's PolicyState is `in | blocked`, so over-cap arrives as
 * `blocked + reasonCode "over_cap"`. It still reads in the `over` colour with the
 * word "Over cap", because "you are above the cap" and "this supplier is not
 * approved" are different facts and the traveller needs to tell them apart.
 */

import type { PolicyVerdict } from "../../core/types.ts";

export type VerdictVariant = "in" | "over" | "blocked";

const WORDS: Readonly<Record<VerdictVariant, string>> = {
  in: "In policy",
  over: "Over cap",
  blocked: "Blocked",
};

export function verdictVariant(verdict: PolicyVerdict): VerdictVariant {
  if (verdict.state === "in") return "in";
  return verdict.reasonCode === "over_cap" ? "over" : "blocked";
}

export function verdictWord(verdict: PolicyVerdict): string {
  return WORDS[verdictVariant(verdict)];
}

export function VerdictChip({ verdict }: { readonly verdict: PolicyVerdict }): JSX.Element {
  const variant = verdictVariant(verdict);
  return <span className={`verdict verdict--${variant}`}>{WORDS[variant]}</span>;
}
