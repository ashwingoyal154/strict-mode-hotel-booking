/**
 * "Card declined at the desk?" — the traveller is standing at a hotel counter and
 * the virtual card did not go through. One quiet question, an optional note, and
 * a plain confirmation. It records a `desk_declined` card event and tells the
 * travel desk; it does not pretend to fix anything by itself.
 */

import { useId, useState } from "react";
import type { CardEvent } from "../../core/types.ts";
import { isApiError, messageOf, reportCardDeclined } from "../lib/api.ts";
import { formatStamp } from "../lib/fmt.ts";

type Phase =
  | { readonly k: "closed" }
  | { readonly k: "open" }
  | { readonly k: "sending" }
  | { readonly k: "sent"; readonly event: CardEvent }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

export function DeskDeclined({ bookingId }: { readonly bookingId: string }): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ k: "closed" });
  const [note, setNote] = useState("");
  const noteId = useId();

  const send = async (): Promise<void> => {
    setPhase({ k: "sending" });
    try {
      const res = await reportCardDeclined(bookingId, note);
      setPhase({ k: "sent", event: res.cardEvent });
    } catch (err) {
      setPhase({
        k: "fault",
        code: isApiError(err) ? err.code : "unexpected_error",
        message: messageOf(err),
      });
    }
  };

  if (phase.k === "sent") {
    return (
      <div className="desk" role="status">
        <span className="label">Reported &middot; {formatStamp(phase.event.at)}</span>
        <p className="prose">
          The travel desk has been told the card was declined at the hotel. Show the
          front desk the authorisation letter; it states the card is authorised and the
          hotel must not charge you. Nothing here is for you to pay.
        </p>
      </div>
    );
  }

  if (phase.k === "closed") {
    return (
      <div className="desk">
        <button type="button" className="btn-text" onClick={() => setPhase({ k: "open" })}>
          Card declined at the desk?
        </button>
      </div>
    );
  }

  return (
    <div className="desk">
      <span className="label">Card declined at the desk</span>
      <div className="field">
        <label className="label" htmlFor={noteId}>
          What the hotel said (optional)
        </label>
        <textarea
          id={noteId}
          className="input"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {phase.k === "fault" ? (
        <p className="prose">
          <span className="label label--blocked">{phase.code}</span> {phase.message}
        </p>
      ) : null}
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={phase.k === "sending"}
          onClick={() => void send()}
        >
          {phase.k === "sending" ? "Telling the desk…" : "Tell the travel desk"}
        </button>
        <button type="button" className="btn-text" onClick={() => setPhase({ k: "closed" })}>
          Never mind
        </button>
      </div>
    </div>
  );
}
