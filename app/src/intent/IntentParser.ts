import type { Anchor, ParsedIntent } from "../core/types.ts";

/**
 * Chat entry resolves a sentence into a structured search. It never books
 * (spec §2.3) — this port returns an intent and has no access to booking at all.
 *
 * Two implementations: a deterministic rules parser (always available, and the
 * one A8 is measured against) and a Claude-backed parser used when an API key is
 * configured, which falls back to the rules parser on any failure or refusal.
 */
export interface IntentContext {
  readonly now: Date;
  /** IANA zone the traveller is in, so "Tuesday" means their Tuesday. */
  readonly timeZone: string;
  /** Known anchors, offered as tap-to-answer options when the anchor is unclear. */
  readonly anchors: readonly Anchor[];
  /** The same resolver /api/search uses, so chat and the form agree on what a place is. */
  readonly resolveAnchor: (query: string) => Anchor | null;
}

export interface IntentParser {
  readonly id: "rules" | "claude";
  parse(text: string, ctx: IntentContext): Promise<ParsedIntent>;
}
