/**
 * DecidedLine — `label · value · Edit`.
 *
 * The system already decided. This shows what it decided in machine voice, with
 * an edit affordance where editing is meaningful. Never an empty form field for
 * something already known.
 */

import { useId, useState, type ReactNode } from "react";

interface DecidedLineProps {
  readonly label: string;
  readonly value: string;
  /** Rendered when the traveller opens the editor. Omit for a read-only line. */
  readonly editor?: (close: () => void) => ReactNode;
  readonly editLabel?: string;
}

export function DecidedLine({ label, value, editor, editLabel }: DecidedLineProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="decided">
      <span className="label decided__label">{label}</span>
      <span className="decided__value">{value}</span>
      {editor !== undefined ? (
        <button
          type="button"
          className="btn-text decided__edit"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Done" : (editLabel ?? "Edit")}
        </button>
      ) : null}
      {editor !== undefined && open ? (
        <div className="decided__editor" id={panelId}>
          {editor(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
