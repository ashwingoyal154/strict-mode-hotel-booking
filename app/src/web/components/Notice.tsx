/**
 * Notice — the shape every designed failure state takes. A machine-voice code, a
 * human-voice sentence, and explicit actions. Never an alert().
 */

import type { ReactNode } from "react";

export type NoticeTone = "neutral" | "in" | "over" | "blocked";

interface NoticeProps {
  readonly tone?: NoticeTone;
  /** Machine voice: `409 price_drift`, `source unavailable`. */
  readonly code: string;
  readonly title?: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
}

export function Notice({
  tone = "neutral",
  code,
  title,
  children,
  actions,
}: NoticeProps): JSX.Element {
  return (
    <section className={`notice notice--${tone}`}>
      <div className="notice__head">
        <span className="notice__code">{code}</span>
        {title !== undefined ? <h2 className="h3">{title}</h2> : null}
      </div>
      {children !== undefined ? <div className="stack stack--tight">{children}</div> : null}
      {actions !== undefined ? <div className="notice__actions">{actions}</div> : null}
    </section>
  );
}
