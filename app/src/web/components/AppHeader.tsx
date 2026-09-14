/**
 * The shell header: the mark, the destinations, and a quiet theme control.
 *
 * `approvals` is shown to every signed-in traveller — `/api/approvals?scope=mine`
 * never 403s, and an approver needs the decided history even with nothing pending.
 * Its count badge appears only when something is waiting. Admin only appears for an
 * admin, because a link that 403s is a lie.
 */

import { NavLink } from "react-router-dom";
import type { Traveller } from "../../core/types.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  `app-nav__link${isActive ? " is-active" : ""}`;

interface AppHeaderProps {
  readonly traveller: Traveller | null;
  readonly approvalsPending?: number;
}

export function AppHeader({ traveller, approvalsPending = 0 }: AppHeaderProps): JSX.Element {
  const pending = Number.isFinite(approvalsPending) && approvalsPending > 0 ? approvalsPending : 0;

  return (
    <header className="app-header">
      {/*
        DESIGN.md forbids banners, and this is the one exception, because it is not
        promotion — it is the truth about what the page is. On a public URL a hotel
        booking product whose hotels are invented and whose cards are sandbox-issued
        must say so, in the shell, on every screen. Quiet, machine voice, never
        dismissible. It is not printed: paper carries only the document.
      */}
      <p className="app-demo-bar m" role="note">
        Demo build · invented hotels, simulated rates, no real booking or payment
      </p>
      <div className="app-header__inner">
        <NavLink to="/" className="app-mark">
          Strict&nbsp;Mode
        </NavLink>
        <nav className="app-nav" aria-label="Main">
          <NavLink to="/" className={linkClass} end>
            search
          </NavLink>
          {traveller !== null ? (
            <NavLink to="/trips" className={linkClass}>
              trips
            </NavLink>
          ) : null}
          {traveller !== null ? (
            <NavLink
              to="/approvals"
              className={linkClass}
              aria-label={pending > 0 ? `approvals, ${pending} waiting for you` : "approvals"}
            >
              approvals
              {pending > 0 ? (
                <span className="app-nav__badge" aria-hidden="true">
                  {pending > 99 ? "99+" : pending}
                </span>
              ) : null}
            </NavLink>
          ) : null}
          {traveller?.isAdmin === true ? (
            <NavLink to="/admin" className={linkClass}>
              admin
            </NavLink>
          ) : null}
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
