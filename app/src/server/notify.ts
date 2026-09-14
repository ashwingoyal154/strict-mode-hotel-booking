/**
 * Notifications. The in-app inbox is the channel of record and is written
 * **before** any external channel is attempted, so a Slack outage can never lose
 * an approval request. Every external attempt is recorded as its own
 * `NotificationRecord` with `delivery: "sent" | "failed"`; a failure is recorded,
 * never thrown. This module never throws at all — a notification is a consequence
 * of a booking decision, and must not be able to undo one.
 */

import { newId } from "../core/ids.ts";
import type { NotificationKind, NotificationRecord, Traveller } from "../core/types.ts";
import type { Notifier } from "../notify/Notifier.ts";
import type { Store } from "../store/Store.ts";
import { errorMessage } from "./time.ts";

export interface NotifyDeps {
  readonly store: Store;
  readonly notifiers: readonly Notifier[];
  readonly now: () => Date;
}

export interface NotificationInput {
  readonly recipient: Traveller;
  readonly kind: NotificationKind;
  readonly subject: string;
  readonly body: string;
  readonly actionUrl: string | null;
  readonly approvalId: string | null;
  readonly bookingId: string | null;
}

export async function notify(deps: NotifyDeps, input: NotificationInput): Promise<NotificationRecord | null> {
  const at = deps.now().toISOString();
  const inApp: NotificationRecord = {
    id: newId("ntf"),
    at,
    recipientId: input.recipient.id,
    channel: "in_app",
    kind: input.kind,
    subject: input.subject,
    body: input.body,
    actionUrl: input.actionUrl,
    approvalId: input.approvalId,
    bookingId: input.bookingId,
    delivery: "sent",
    deliveryError: null,
    readAt: null,
  };

  try {
    await deps.store.putNotification(inApp);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`in-app notification ${input.kind} for ${input.recipient.id} failed: ${errorMessage(err)}`);
    return null;
  }

  // An erased person has no email or Slack identity left to reach.
  if (input.recipient.erasedAt !== null) return inApp;

  await Promise.all(
    deps.notifiers.map(async (notifier) => {
      let failure: string | null = null;
      try {
        await notifier.send({
          recipient: { id: input.recipient.id, name: input.recipient.name, email: input.recipient.email },
          kind: input.kind,
          subject: input.subject,
          body: input.body,
          actionUrl: input.actionUrl,
        });
      } catch (err) {
        failure = errorMessage(err);
      }
      try {
        await deps.store.putNotification({
          ...inApp,
          id: newId("ntf"),
          channel: notifier.channel,
          delivery: failure === null ? "sent" : "failed",
          deliveryError: failure,
        });
      } catch {
        // The in-app record already exists; a lost delivery receipt is not a lost request.
      }
    }),
  );

  return inApp;
}

export async function notifyAdmins(
  deps: NotifyDeps,
  entityId: string,
  input: Omit<NotificationInput, "recipient">,
): Promise<number> {
  const travellers = await deps.store.listTravellers(entityId).catch(() => [] as Traveller[]);
  const admins = travellers.filter((t) => t.isAdmin && t.erasedAt === null);
  await Promise.all(admins.map((recipient) => notify(deps, { ...input, recipient })));
  return admins.length;
}
