/**
 * Claude-backed chat entry. Used only when an API key is configured; the rules
 * parser stays the fallback and the one A8 is measured against.
 *
 * Claude extracts; this code decides. The model returns fields through a structured
 * output schema, and the same resolver and clarification rule as the rules parser
 * turn them into a ParsedIntent. So the model can never book, never invent a place
 * the resolver does not know, and never skip the one clarifying question. Any
 * refusal, unparseable output, API error or timeout falls back to the rules parser.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK helper consumes zod v4 schemas; zod 3.25 ships v4 at "zod/v4".
import { z } from "zod/v4";

import type { ClarifyingQuestion, ParsedIntent } from "../core/types.ts";
import type { IntentContext, IntentParser } from "./IntentParser.ts";

const DEFAULT_MODEL = "claude-opus-5";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const Extraction = z.object({
  anchorQuery: z.string().nullable(),
  checkIn: z.string().nullable(),
  checkOut: z.string().nullable(),
  guests: z.number().int().nullable(),
  rooms: z.number().int().nullable(),
  inPolicyOnly: z.boolean(),
  workReady: z.boolean(),
  freeCancellation: z.boolean(),
  breakfast: z.boolean(),
  maxCommuteMinutes: z.number().int().nullable(),
});

type ExtractionT = z.infer<typeof Extraction>;

/** The minimal SDK surface used here, so tests inject a fake without a network. */
export interface IntentClient {
  readonly messages: {
    parse(
      params: Parameters<Anthropic["messages"]["parse"]>[0],
      options?: { timeout?: number },
    ): Promise<{ stop_reason: string | null; parsed_output: ExtractionT | null }>;
  };
}

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] ?? "";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()] ?? "";
  return `${day} ${d.getUTCDate()} ${mon}`;
}

export function createClaudeIntentParser(cfg: {
  client?: IntentClient;
  model?: string;
  timeoutMs?: number;
  fallback: IntentParser;
}): IntentParser {
  const client: IntentClient = cfg.client ?? (new Anthropic() as unknown as IntentClient);
  const model = cfg.model ?? DEFAULT_MODEL;

  return {
    id: "claude",
    async parse(text: string, ctx: IntentContext): Promise<ParsedIntent> {
      try {
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timeZone }).format(ctx.now);
        const response = await client.messages.parse(
          {
            model,
            max_tokens: 1024,
            output_config: { effort: "low", format: zodOutputFormat(Extraction) },
            system:
              "You extract a hotel search from one sentence a business traveller typed. " +
              `Today is ${today} in ${ctx.timeZone}; resolve relative dates against it. ` +
              "anchorQuery is the meeting place or district as the traveller named it. " +
              "checkIn and checkOut are YYYY-MM-DD, with checkOut the morning they leave. " +
              "Use null for anything the sentence does not say. Never guess a date.",
            messages: [{ role: "user", content: text }],
          },
          { timeout: cfg.timeoutMs ?? 4_000 },
        );
        const x = response.parsed_output;
        if (response.stop_reason === "refusal" || x === null) return cfg.fallback.parse(text, ctx);

        const anchor = x.anchorQuery === null ? null : ctx.resolveAnchor(x.anchorQuery);
        const checkIn = x.checkIn !== null && ISO.test(x.checkIn) ? x.checkIn : null;
        const checkOut = x.checkOut !== null && ISO.test(x.checkOut) && checkIn !== null && x.checkOut > checkIn ? x.checkOut : null;

        let clarification: ClarifyingQuestion | null = null;
        if (anchor === null) {
          clarification = {
            field: "anchor",
            question: "Where is your meeting?",
            options: ctx.anchors.slice(0, 4).map((a) => a.label),
          };
        } else if (checkIn === null || checkOut === null) {
          clarification = {
            field: "dates",
            question: "Which nights do you need?",
            options: ["Tomorrow · 1 night", "Mon–Wed next week", "Mon–Fri next week"],
          };
        }

        const parts = [
          anchor === null ? null : `${anchor.label}`,
          checkIn !== null && checkOut !== null ? `${dayLabel(checkIn)} – ${dayLabel(checkOut)}` : null,
          x.guests === null ? null : `${x.guests} guest${x.guests === 1 ? "" : "s"}`,
          x.inPolicyOnly ? "in policy" : null,
        ].filter((p): p is string => p !== null);

        return {
          text,
          anchorQuery: x.anchorQuery,
          anchor,
          checkIn,
          checkOut,
          guests: x.guests,
          rooms: x.rooms,
          constraints: {
            inPolicyOnly: x.inPolicyOnly,
            workReady: x.workReady,
            freeCancellation: x.freeCancellation,
            breakfast: x.breakfast,
            maxCommuteMinutes: x.maxCommuteMinutes,
          },
          confidence: { anchor: anchor === null ? 0 : 1, dates: checkIn !== null && checkOut !== null ? 1 : 0 },
          clarification,
          readBack: parts.join(" · "),
          parser: "claude",
        };
      } catch (err) {
        if (err instanceof Anthropic.APIError || err instanceof Error) return cfg.fallback.parse(text, ctx);
        throw err;
      }
    },
  };
}
