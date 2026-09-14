/**
 * HoldLine — never claim a hold that does not exist.
 *
 * It sits directly under the total on a pending request and takes exactly one of
 * two forms:
 *   `Held until 6:00 pm · the price above is guaranteed until then`
 *   `Not held · this hotel can't hold rates, so the price may move before approval`
 * The second is in the `over` tone.
 *
 * The head ("Held until …" / "Not held") is derived from the structured fields,
 * so it cannot drift from the truth. The tail is the server's own message, shown
 * verbatim — unless the hold has since lapsed, because a message written when the
 * hold was granted would then be a claim that is no longer true.
 */

import { useEffect, useState } from "react";
import type { HoldStatus } from "../../core/types.ts";
import { formatClock } from "../lib/fmt.ts";

const HELD_TAIL = "the price above is guaranteed until then";
const NOT_HELD_TAIL = "this hotel can't hold rates, so the price may move before approval";

export function HoldLine({ hold }: { readonly hold: HoldStatus | null }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const until = hold?.heldUntil ?? null;
  const untilMs = until === null ? Number.NaN : new Date(until).getTime();
  const lapsed = hold !== null && hold.held && !Number.isNaN(untilMs) && untilMs <= now;
  const held = hold !== null && hold.held && !lapsed;

  const message = hold?.message.trim() ?? "";
  const messageIsWhole = /^(held|not held)\b/i.test(message);

  let text: string;
  if (held) {
    const head = until === null ? "Held" : `Held until ${formatClock(until, new Date(now))}`;
    text = messageIsWhole ? message : `${head} · ${message.length > 0 ? message : HELD_TAIL}`;
  } else if (lapsed && until !== null) {
    text = `Not held · the hold ended at ${formatClock(until, new Date(now))}, so the price may move before approval`;
  } else {
    text = messageIsWhole ? message : `Not held · ${message.length > 0 ? message : NOT_HELD_TAIL}`;
  }

  return (
    <p className="hold" data-held={held ? "true" : "false"}>
      {text}
    </p>
  );
}
