/**
 * Development email channel: writes the email it would have sent to a log line
 * instead of an SMTP server. `live: false` so /api/version and health are
 * honest that no real email left the building.
 */
import type { Notifier, OutgoingNotification } from "./Notifier.ts";

export function formatEmailLines(n: OutgoingNotification): string[] {
  const lines = [
    `[email] to: ${n.recipient.name} <${n.recipient.email}>`,
    `[email] kind: ${n.kind}`,
    `[email] subject: ${n.subject}`,
    ...n.body.split("\n").map((l) => `[email] | ${l}`),
  ];
  if (n.actionUrl) lines.push(`[email] action: ${n.actionUrl}`);
  return lines;
}

export function createConsoleEmailNotifier(cfg?: { log?: (line: string) => void }): Notifier {
  const log = cfg?.log ?? ((line: string) => console.log(line));
  return {
    id: "console-email",
    channel: "email",
    live: false,

    async send(n: OutgoingNotification): Promise<void> {
      for (const line of formatEmailLines(n)) log(line);
    },
  };
}
