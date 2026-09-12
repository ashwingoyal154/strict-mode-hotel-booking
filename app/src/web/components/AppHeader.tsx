/**
 * The shell header: the mark, the three destinations, and a quiet theme control.
 * Admin only appears for an admin, because a link that 403s is a lie.
 */

import { NavLink } from "react-router-dom";
import type { Traveller } from "../../core/types.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  `app-nav__link${isActive ? " is-active" : ""}`;

export function AppHeader({ traveller }: { readonly traveller: Traveller | null }): JSX.Element {
  return (
    <header className="app-header">
      {/*
        DESIGN.md forbids banners, and this is the one exception, because it is not
        promotion — it is the truth about what the page is. On a public URL a hotel
        booking product whose hotels are invented and whose cards are sandbox-issued
        must say so, in the shell, on every screen. Quiet, machine voice, never
        dismissible.
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
          <NavLink to="/trips" className={linkClass}>
            trips
          </NavLink>
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
