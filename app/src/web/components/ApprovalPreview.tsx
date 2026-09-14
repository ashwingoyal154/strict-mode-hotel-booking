/**
 * ApprovalPreview — who will be asked, by when, and what happens to the rate
 * meanwhile. Shown on Confirm *before* a request is sent, because a traveller
 * should know what "Send for approval" sets in motion.
 *
 * Only what is actually known is stated. The frozen contract does not name the
 * approver before a request exists, so unless the server volunteers the chain the
 * line says where the approver comes from rather than inventing a name. The hold
 * line here is an expectation, never a claim: a hold is only real once the request
 * page says `Held until …`.
 */

import { formatClock, formatMinutesSpan } from "../lib/fmt.ts";

interface ApprovalPreviewProps {
  readonly approverNames: readonly string[];
  readonly slaMinutes: number | null;
  readonly holdable: boolean;
  readonly serverMessage: string | null;
}

export function ApprovalPreview({
  approverNames,
  slaMinutes,
  holdable,
  serverMessage,
}: ApprovalPreviewProps): JSX.Element {
  const now = Date.now();
  const [first, ...rest] = approverNames;

  const asked =
    first === undefined
      ? "your manager, from the company directory"
      : rest.length === 0
        ? first
        : `${first} · then ${rest.join(", then ")}`;

  const by =
    slaMinutes === null
      ? "within your company's approval SLA, from the moment you send"
      : `within ${formatMinutesSpan(slaMinutes)} · about ${formatClock(new Date(now + slaMinutes * 60_000).toISOString())} if sent now`;

  return (
    <section className="preview" aria-labelledby="approval-preview-title">
      <h2 className="h3" id="approval-preview-title">
        Who will be asked
      </h2>
      <div className="preview__rows">
        <div className="decided">
          <span className="label decided__label">Asked</span>
          <span className="decided__value">{asked}</span>
        </div>
        <div className="decided">
          <span className="label decided__label">Decides</span>
          <span className="decided__value">{by}</span>
        </div>
        <div className="decided">
          <span className="label decided__label">If late</span>
          <span className="decided__value">
            moves up the manager chain · the request never expires
          </span>
        </div>
        <div className="decided">
          <span className="label decided__label">Rate</span>
          <span className={`decided__value${holdable ? "" : " decided__value--over"}`}>
            {holdable
              ? "a hold is requested when you send · the next screen says whether it was granted"
              : "not holdable · this hotel can't hold rates, so the price may move before approval"}
          </span>
        </div>
        <div className="decided">
          <span className="label decided__label">Card</span>
          <span className="decided__value">none issued until it is approved</span>
        </div>
      </div>
      {serverMessage !== null ? <p className="mono mono--muted">{serverMessage}</p> : null}
    </section>
  );
}
