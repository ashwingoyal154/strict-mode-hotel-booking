/**
 * JustificationForm — why this rate, over the cap.
 *
 * The reasons are the company's own list, delivered by a `422
 * justification_required` (or read from policy for an admin). They are square
 * chips; exactly one is chosen. The text is what a human wrote, so it is the one
 * free-text field on Confirm, and the only required input anywhere in the
 * product — it exists because an approver will read it.
 *
 * The character hint is machine voice and live as you type, counted on the
 * trimmed text because that is what the server counts.
 */

import { useId } from "react";
import type { JustificationReason } from "../../core/types.ts";

export const MIN_JUSTIFICATION_CHARS = 10;
export const MAX_JUSTIFICATION_CHARS = 500;

interface JustificationFormProps {
  /** null until the server has told us the company's reasons. */
  readonly reasons: readonly JustificationReason[] | null;
  readonly code: string | null;
  readonly onCode: (code: string) => void;
  readonly text: string;
  readonly onText: (text: string) => void;
  /** The server's sentence after a 422, shown verbatim. */
  readonly serverMessage: string | null;
  readonly disabled?: boolean;
}

export function justificationReady(
  reasons: readonly JustificationReason[] | null,
  code: string | null,
  text: string,
): boolean {
  const longEnough = text.trim().length >= MIN_JUSTIFICATION_CHARS;
  if (reasons === null) return longEnough;
  return longEnough && code !== null && reasons.some((r) => r.code === code);
}

export function JustificationForm({
  reasons,
  code,
  onCode,
  text,
  onText,
  serverMessage,
  disabled = false,
}: JustificationFormProps): JSX.Element {
  const baseId = useId();
  const chipsLabelId = `${baseId}-reasons`;
  const textId = `${baseId}-text`;
  const hintId = `${baseId}-hint`;

  const count = text.trim().length;
  const enough = count >= MIN_JUSTIFICATION_CHARS;
  const hint = enough
    ? `${count} characters · enough`
    : `${count} of ${MIN_JUSTIFICATION_CHARS} characters · ${MIN_JUSTIFICATION_CHARS - count} to go`;

  const chosen = reasons?.find((r) => r.code === code) ?? null;

  return (
    <fieldset className="justify" disabled={disabled}>
      <legend className="h3 justify__legend">Why this one?</legend>

      {reasons !== null && reasons.length > 0 ? (
        <div className="field">
          <span className="label" id={chipsLabelId}>
            Reason &middot; {chosen === null ? "pick one" : "chosen"}
          </span>
          <div className="sq-chips" role="group" aria-labelledby={chipsLabelId}>
            {reasons.map((r) => (
              <button
                key={r.code}
                type="button"
                className="sq-chip"
                aria-pressed={code === r.code}
                onClick={() => onCode(r.code)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="field">
        <label className="label" htmlFor={textId}>
          In your words, for the approver
        </label>
        <textarea
          id={textId}
          className="input justify__text"
          rows={3}
          maxLength={MAX_JUSTIFICATION_CHARS}
          value={text}
          aria-describedby={hintId}
          aria-invalid={serverMessage !== null && !enough}
          onChange={(e) => onText(e.target.value)}
        />
        <span id={hintId} className="justify__hint" data-ready={enough ? "true" : "false"}>
          {hint}
        </span>
      </div>

      {serverMessage !== null ? (
        <p className="prose justify__message" role="status">
          {serverMessage}
        </p>
      ) : null}
    </fieldset>
  );
}
