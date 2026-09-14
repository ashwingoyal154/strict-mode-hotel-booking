/**
 * /a/:token — the one-tap page reached from a notification.
 *
 * The GET is a preview with no side effects, so a mail scanner that follows the
 * link decides nothing. The page is the same decision card as the inbox with only
 * the action the token was issued for. Every way a link can be unusable is a
 * designed state with a sentence, never a raw error.
 */

import { Link, useParams } from "react-router-dom";
import { previewActionToken, type ApprovalView } from "./admin/api.ts";
import { DecisionCard } from "./admin/DecisionCard.tsx";
import { ApprovalStateChip, outcomeWord } from "./admin/chips.tsx";
import { formatClock } from "./admin/format.ts";
import { Loading, useLoad } from "./admin/useLoad.tsx";
import { Notice } from "../components/Notice.tsx";
import "../design/admin.css";

interface InvalidCopy {
  readonly code: string;
  readonly title: string;
  readonly sentence: string;
}

/** The contract gives `reason` as a free string, so it is read by what it says. */
function describeInvalid(reason: string): InvalidCopy {
  const r = reason.toLowerCase();
  if (/expir/.test(r)) {
    return {
      code: "link expired",
      title: "This link has expired",
      sentence:
        "One-tap links only work for a short while, so an old message cannot decide a request after the facts have moved. Nothing was recorded.",
    };
  }
  if (/used|consumed|replay/.test(r)) {
    return {
      code: "link already used",
      title: "This link has already been used",
      sentence: "Each one-tap link works exactly once, and this one already has. Nothing new was recorded.",
    };
  }
  if (/decided|not_pending|not pending|withdrawn/.test(r)) {
    return {
      code: "already decided",
      title: "This request is already decided",
      sentence:
        "It was decided, or the traveller withdrew it, before this link was opened. Nothing was recorded.",
    };
  }
  if (/approver|escalat/.test(r)) {
    return {
      code: "moved on",
      title: "This request has moved on",
      sentence:
        "It escalated to the next approver when the time ran out, so this link can no longer decide it. Nothing was recorded.",
    };
  }
  if (/tamper|signature|invalid|malformed|unknown|not.?found/.test(r)) {
    return {
      code: "link not valid",
      title: "This link is not one we issued",
      sentence:
        "It does not match any link we sent, which usually means it was cut short when it was copied. Nothing was recorded.",
    };
  }
  return {
    code: "link unusable",
    title: "This link cannot decide anything",
    sentence: "Nothing was recorded.",
  };
}

const openApprovals = (
  <Link className="btn" to="/approvals">
    Open approvals
  </Link>
);

export function ActionTokenScreen(): JSX.Element {
  const { token = "" } = useParams<{ token: string }>();
  const preview = useLoad(() => previewActionToken(token), [token]);

  return (
    <div className="appr appr--token">
      {preview.load.k === "loading" ? <Loading what="this request" /> : null}

      {preview.load.k === "fault" ? (
        <Notice
          tone={preview.load.status === 0 || preview.load.status >= 500 ? "blocked" : "neutral"}
          code={preview.load.status === 0 ? preview.load.code : `${preview.load.status} ${preview.load.code}`}
          title="We could not open this request"
          actions={
            <button type="button" className="btn" onClick={() => preview.reload()}>
              Try again
            </button>
          }
        >
          <p className="prose">{preview.load.message} Nothing was recorded.</p>
        </Notice>
      ) : null}

      {preview.load.k === "ready" && !preview.load.data.valid ? (
        <InvalidLink reason={preview.load.data.reason} />
      ) : null}

      {preview.load.k === "ready" && preview.load.data.valid ? (
        preview.load.data.approval.state !== "pending" ? (
          <AlreadyDecided view={preview.load.data.approval} />
        ) : (
          <>
            <div className="screen__head">
              <span className="label">One-tap decision</span>
              <h1 className="h1">
                {preview.load.data.decision === "approve" ? "Approve this request" : "Reject this request"}
              </h1>
              <p className="mono mono--muted">deciding as {preview.load.data.approverName}</p>
            </div>
            <DecisionCard
              view={preview.load.data.approval}
              fetchedAt={preview.load.fetchedAt}
              actions={preview.load.data.decision}
              actionToken={token}
              onStale={() => preview.reload()}
            />
          </>
        )
      ) : null}
    </div>
  );
}

function InvalidLink({ reason }: { readonly reason: string }): JSX.Element {
  const copy = describeInvalid(reason);
  return (
    <Notice tone="neutral" code={copy.code} title={copy.title} actions={openApprovals}>
      <p className="prose">{copy.sentence}</p>
      <p className="mono mono--muted">reason · {reason}</p>
    </Notice>
  );
}

function AlreadyDecided({ view }: { readonly view: ApprovalView }): JSX.Element {
  const decider = view.approvers.find((a) => a.id === view.decidedBy)?.name ?? null;
  const when = view.decidedAt !== null ? ` at ${formatClock(view.decidedAt)}` : "";
  const sentence =
    view.state === "withdrawn"
      ? `${view.traveller.name} withdrew this request${when}, so there is nothing left to decide.`
      : `${decider ?? "Another approver"} ${view.state} this request${when}, before this link was used.`;
  return (
    <Notice tone="neutral" code="already decided" title="This request is already decided" actions={openApprovals}>
      <div className="row">
        <ApprovalStateChip state={view.state} outcome={view.outcome} />
        <span className="mono mono--muted">
          {view.traveller.name} · {view.booking.offer.property.name}
          {view.state === "approved" ? ` · ${outcomeWord(view.outcome)}` : ""}
        </span>
      </div>
      <p className="prose">{sentence} Nothing was recorded from this link.</p>
    </Notice>
  );
}
