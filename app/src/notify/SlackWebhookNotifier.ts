/**
 * Slack incoming-webhook delivery. Best-effort on top of the in-app inbox,
 * which is the channel of record (Notifier.ts): this throws on failure and the
 * caller records the failure and carries on.
 *
 * Wire format per Slack's incoming-webhook reference: POST, JSON body with a
 * `text` fallback plus Block Kit `blocks`; success is HTTP 200 with body "ok";
 * failures come back as non-200 with a short error string (invalid_payload,
 * no_text, channel_not_found, action_prohibited). Links use `<url|label>`.
 */
import type { Notifier, OutgoingNotification } from "./Notifier.ts";

export class SlackDeliveryError extends Error {
  constructor(readonly status: number | null, readonly slackError: string) {
    super(`slack webhook delivery failed${status === null ? "" : ` (${status})`}: ${slackError}`);
    this.name = "SlackDeliveryError";
  }
}

/** Slack mrkdwn needs &, < and > escaped, or a traveller's text can forge a link. */
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slackPayloadFor(n: OutgoingNotification): { text: string; blocks: unknown[] } {
  const subject = escapeMrkdwn(n.subject);
  const body = escapeMrkdwn(n.body);
  const link = n.actionUrl ? `\n<${n.actionUrl}|Open in Strict Mode>` : "";
  const text = `*${subject}*\n${body}${link}`;
  return {
    text: `${n.subject} — ${n.body}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  };
}

export function createSlackWebhookNotifier(cfg: { webhookUrl: string; fetch?: typeof fetch }): Notifier {
  const doFetch = cfg.fetch ?? fetch;
  return {
    id: "slack-webhook",
    channel: "slack",
    live: true,

    async send(n: OutgoingNotification): Promise<void> {
      let res: Response;
      try {
        res = await doFetch(cfg.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(slackPayloadFor(n)),
        });
      } catch (err) {
        throw new SlackDeliveryError(null, err instanceof Error ? err.message : "network error");
      }
      const bodyText = await res.text().catch(() => "");
      if (res.status !== 200) {
        throw new SlackDeliveryError(res.status, bodyText.trim() || "unknown_error");
      }
    },
  };
}
