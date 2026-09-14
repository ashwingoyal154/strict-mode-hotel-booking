/**
 * Search — one anchor, two dates, everything else already decided.
 *
 * The only question on the page is where the meeting is. Guests and rooms arrive
 * pre-decided; the dates are machine-voice controls; the last three anchors are
 * chips. Submitting starts the fan-out and hands straight off to the stream.
 *
 * Slice 2 adds one line beneath the form — `Or ask in a sentence` — which is a
 * field, not a conversation. Its Search button runs exactly the same `runSearch`
 * as the form. Arriving from a trip ("search these dates again") pre-fills the
 * anchor and dates.
 */

import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Traveller } from "../../core/types.ts";
import { createSearch, isApiError, messageOf, type CreateSearchBody } from "../lib/api.ts";
import { addDaysIso, nightsBetween, todayIso } from "../lib/fmt.ts";
import { AnchorInput, type AnchorDraft, type RecentAnchor } from "../components/AnchorInput.tsx";
import { ChatEntry } from "../components/ChatEntry.tsx";
import { Notice } from "../components/Notice.tsx";

const RECENT_KEY = "verdict.recentAnchors";
const RECENT_MAX = 3;

function readRecent(): readonly RecentAnchor[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RecentAnchor[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const label = rec["label"];
      const checkIn = rec["checkIn"];
      const checkOut = rec["checkOut"];
      if (typeof label !== "string" || typeof checkIn !== "string" || typeof checkOut !== "string") {
        continue;
      }
      out.push({ label, checkIn, checkOut });
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function writeRecent(next: readonly RecentAnchor[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, RECENT_MAX)));
  } catch {
    /* per-viewer convenience only; losing it changes nothing */
  }
}

/** `{ prefill: { anchorQuery, checkIn, checkOut } }`, handed over by a trip page. */
function readPrefill(state: unknown): RecentAnchor | null {
  if (typeof state !== "object" || state === null) return null;
  const prefill = (state as Record<string, unknown>)["prefill"];
  if (typeof prefill !== "object" || prefill === null) return null;
  const rec = prefill as Record<string, unknown>;
  const label = rec["anchorQuery"];
  const checkIn = rec["checkIn"];
  const checkOut = rec["checkOut"];
  if (typeof label !== "string" || typeof checkIn !== "string" || typeof checkOut !== "string") {
    return null;
  }
  return { label, checkIn, checkOut };
}

export function SearchScreen({ traveller }: { readonly traveller: Traveller }): JSX.Element {
  const navigate = useNavigate();
  const prefill = readPrefill(useLocation().state);
  const [recent, setRecent] = useState<readonly RecentAnchor[]>(() => readRecent());
  const [draft, setDraft] = useState<AnchorDraft>(() => {
    const today = todayIso();
    // A past stay's dates are no use to search; keep the anchor, move the dates.
    if (prefill !== null && nightsBetween(today, prefill.checkIn) >= 0 && prefill.checkIn >= today) {
      return {
        anchorQuery: prefill.label,
        checkIn: prefill.checkIn,
        checkOut: prefill.checkOut,
        guests: 1,
        rooms: 1,
      };
    }
    const checkIn = addDaysIso(today, 14);
    return {
      anchorQuery: prefill?.label ?? "",
      checkIn,
      checkOut: addDaysIso(checkIn, 4),
      guests: 1,
      rooms: 1,
    };
  });
  const [busy, setBusy] = useState(false);
  const [anchorError, setAnchorError] = useState<string | null>(null);
  const [fault, setFault] = useState<{ code: string; message: string } | null>(null);

  const canSubmit = useMemo(
    () => draft.anchorQuery.trim().length > 1 && !busy,
    [draft.anchorQuery, busy],
  );

  /** The one search flow. The form and the chat entry both call it. */
  const runSearch = async (body: CreateSearchBody, from: "form" | "chat"): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setAnchorError(null);
    setFault(null);
    try {
      const created = await createSearch(body);

      const entry: RecentAnchor = {
        label: created.anchor.label,
        checkIn: body.checkIn,
        checkOut: body.checkOut,
      };
      const nextRecent = [entry, ...recent.filter((r) => r.label !== entry.label)].slice(
        0,
        RECENT_MAX,
      );
      setRecent(nextRecent);
      writeRecent(nextRecent);

      navigate(`/results/${encodeURIComponent(created.searchId)}`, {
        state: { sources: created.sources, anchor: created.anchor, query: created.query },
      });
    } catch (err) {
      if (from === "form" && isApiError(err) && err.code === "anchor_not_found") {
        setAnchorError(err.message);
      } else {
        setFault({ code: isApiError(err) ? err.code : "unexpected_error", message: messageOf(err) });
      }
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!canSubmit) return;
    void runSearch(
      {
        anchorQuery: draft.anchorQuery.trim(),
        checkIn: draft.checkIn,
        checkOut: draft.checkOut,
        guests: draft.guests,
        rooms: draft.rooms,
      },
      "form",
    );
  };

  return (
    <div className="screen">
      <div className="screen__head">
        <h1 className="h1 h1--lead">Where is your meeting?</h1>
        <p className="prose">
          We rank what is near it, price the whole stay, and check your policy before you
          tap. {traveller.name.split(" ")[0] ?? "You"} pays nothing and files nothing.
        </p>
      </div>

      {fault !== null ? (
        <Notice tone="blocked" code={fault.code}>
          <p className="prose">{fault.message}</p>
        </Notice>
      ) : null}

      <form className="search__form" onSubmit={submit}>
        <AnchorInput
          draft={draft}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          recent={recent}
          onPickRecent={(r) =>
            setDraft((d) => ({
              ...d,
              anchorQuery: r.label,
              checkIn: r.checkIn,
              checkOut: r.checkOut,
            }))
          }
          invalid={anchorError !== null}
          describedBy={anchorError !== null ? "anchor-error" : undefined}
        />

        {anchorError !== null ? (
          <div className="search__error" id="anchor-error">
            <span className="label label--blocked">anchor_not_found</span>
            <p className="prose">{anchorError}</p>
          </div>
        ) : null}

        <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
          {busy ? "Searching…" : "Find somewhere near it"}
        </button>
      </form>

      <ChatEntry searching={busy} onSearch={(body) => void runSearch(body, "chat")} />
    </div>
  );
}
