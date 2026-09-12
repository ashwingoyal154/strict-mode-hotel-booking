/**
 * CancelWindow — a mono countdown to the free-cancellation deadline, the deadline
 * spelled out in the traveller's local time, and a Cancel button that is quiet
 * until hover. Cancelling inside the window costs zero and that is stated, not
 * implied.
 */

import { useEffect, useState } from "react";
import type { IsoDateTime } from "../../core/types.ts";
import { formatCountdown, formatDeadline } from "../lib/fmt.ts";

interface CancelWindowProps {
  readonly deadline: IsoDateTime;
  readonly onCancel: () => void;
  readonly busy?: boolean;
}

export function CancelWindow({ deadline, onCancel, busy = false }: CancelWindowProps): JSX.Element {
  const target = new Date(deadline).getTime();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const msLeft = Number.isNaN(target) ? 0 : target - now;
  const open = msLeft > 0;

  return (
    <div className="cancelwin">
      <span className="label">Free cancellation</span>
      <span className="cancelwin__count">
        {open ? `${formatCountdown(msLeft)} left` : "window closed"}
      </span>
      <span className="cancelwin__deadline">until {formatDeadline(deadline)}, local time</span>
      <p className="prose prose--quiet">
        {open
          ? "Cancelling now costs nothing. The virtual card is voided with it."
          : "The free window has closed. Cancelling here is no longer free, so this slice does not offer it — ask the 24/7 desk."}
      </p>
      <button type="button" className="btn-quiet-danger" onClick={onCancel} disabled={busy || !open}>
        {busy ? "Cancelling…" : "Cancel this trip"}
      </button>
    </div>
  );
}
