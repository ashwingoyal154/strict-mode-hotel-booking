import type { NotificationChannel, NotificationKind } from "../core/types.ts";

/**
 * Outbound notification port. The in-app inbox is always written first, through
 * the Store, and is the channel of record; every Notifier here is best-effort
 * delivery on top of it. A failed Slack post must never lose an approval request.
 */
export interface OutgoingNotification {
  readonly recipient: { readonly id: string; readonly name: string; readonly email: string };
  readonly kind: NotificationKind;
  readonly subject: string;
  readonly body: string;
  readonly actionUrl: string | null;
}

export interface Notifier {
  readonly id: string;
  readonly channel: Exclude<NotificationChannel, "in_app">;
  readonly live: boolean;
  /** Throws on delivery failure; the caller records the failure and carries on. */
  send(n: OutgoingNotification): Promise<void>;
}
