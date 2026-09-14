/**
 * The deterministic chat-entry parser. A thin port adapter over the pure
 * `core/intent.ts#parseIntent`: always available, no network, and the parser
 * A8 is measured against. It never books — the port has no path to booking.
 */
import { parseIntent } from "../core/intent.ts";
import type { IntentContext, IntentParser } from "./IntentParser.ts";

export function createRuleIntentParser(): IntentParser {
  return {
    id: "rules",
    async parse(text: string, ctx: IntentContext) {
      return parseIntent(text, ctx);
    },
  };
}
