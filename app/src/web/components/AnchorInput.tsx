/**
 * AnchorInput — one field. Where is your meeting?
 *
 * Dates sit beneath it as two compact machine-voice controls. Guests and rooms are
 * already decided, so they are a DecidedLine rather than two empty inputs. The
 * traveller's last three anchors appear as square chips below.
 */

import type { IsoDate } from "../../core/types.ts";
import { addDaysIso, monthOf, nightsBetween, plural, todayIso } from "../lib/fmt.ts";
import { DecidedLine } from "./DecidedLine.tsx";

export interface AnchorDraft {
  readonly anchorQuery: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly guests: number;
  readonly rooms: number;
}

export interface RecentAnchor {
  readonly label: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
}

interface AnchorInputProps {
  readonly draft: AnchorDraft;
  readonly onChange: (patch: Partial<AnchorDraft>) => void;
  readonly recent: readonly RecentAnchor[];
  readonly onPickRecent: (r: RecentAnchor) => void;
  readonly invalid?: boolean;
  readonly describedBy?: string;
}

export function AnchorInput({
  draft,
  onChange,
  recent,
  onPickRecent,
  invalid = false,
  describedBy,
}: AnchorInputProps): JSX.Element {
  const nights = nightsBetween(draft.checkIn, draft.checkOut);
  const today = todayIso();

  const setCheckIn = (value: IsoDate): void => {
    // Check-out must stay at least one night later, so moving check-in past it
    // drags it along rather than leaving an impossible range on screen.
    const keepsAtLeastOneNight = nightsBetween(value, draft.checkOut) >= 1;
    onChange(
      keepsAtLeastOneNight
        ? { checkIn: value }
        : { checkIn: value, checkOut: addDaysIso(value, 1) },
    );
  };

  return (
    <div className="anchor">
      <div className="field">
        <label className="label" htmlFor="anchor-query">
          Where is your meeting?
        </label>
        <input
          id="anchor-query"
          className="anchor__input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Bandra Kurla Complex, Mumbai"
          value={draft.anchorQuery}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange({ anchorQuery: e.target.value })}
        />
      </div>

      <div className="anchor__dates">
        <div className="anchor__date">
          <label className="label" htmlFor="check-in">
            Check in
          </label>
          <input
            id="check-in"
            className="input input--narrow"
            type="date"
            min={today}
            value={draft.checkIn}
            onChange={(e) => setCheckIn(e.target.value)}
          />
        </div>
        <div className="anchor__date">
          <label className="label" htmlFor="check-out">
            Check out
          </label>
          <input
            id="check-out"
            className="input input--narrow"
            type="date"
            min={addDaysIso(draft.checkIn, 1)}
            value={draft.checkOut}
            onChange={(e) => onChange({ checkOut: e.target.value })}
          />
        </div>
        <span className="mono mono--muted anchor__nights">{plural(nights, "night")}</span>
      </div>

      <div className="search__decided">
        <DecidedLine
          label="Guests / rooms"
          value={`${plural(draft.guests, "guest")} · ${plural(draft.rooms, "room")}`}
          editor={() => (
            <>
              <label className="label" htmlFor="guests">
                Guests
              </label>
              <input
                id="guests"
                className="input input--narrow"
                type="number"
                min={1}
                max={4}
                value={draft.guests}
                onChange={(e) => onChange({ guests: clamp(e.target.value, 1, 4) })}
              />
              <label className="label" htmlFor="rooms">
                Rooms
              </label>
              <input
                id="rooms"
                className="input input--narrow"
                type="number"
                min={1}
                max={3}
                value={draft.rooms}
                onChange={(e) => onChange({ rooms: clamp(e.target.value, 1, 3) })}
              />
            </>
          )}
        />
      </div>

      {recent.length > 0 ? (
        <div className="field">
          <span className="label" id="recent-anchors-label">
            Last three anchors
          </span>
          <div className="anchor__chips" role="group" aria-labelledby="recent-anchors-label">
            {recent.map((r) => (
              <button
                key={`${r.label}|${r.checkIn}`}
                type="button"
                className="anchor-chip"
                onClick={() => onPickRecent(r)}
              >
                {r.label} &middot; {plural(nightsBetween(r.checkIn, r.checkOut), "night")} &middot;{" "}
                {monthOf(r.checkIn)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function clamp(raw: string, lo: number, hi: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
