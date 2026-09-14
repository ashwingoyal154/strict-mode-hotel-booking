/**
 * The shell. Bootstraps the session, then routes.
 *
 * There is no account wall: this only establishes who is asking, because policy and
 * cost centre are per-traveller and a result with no verdict would be a lie.
 *
 * The one exception to "signed in first" is `/a/:token` — the one-tap decision page
 * reached from a notification. The contract authorises that decision by the token
 * itself, so an approver opening it on a phone with no session still gets the card.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useMatch } from "react-router-dom";
import type { Traveller } from "../core/types.ts";
import { isApiError, logout, me, messageOf } from "./lib/api.ts";
import { AppHeader } from "./components/AppHeader.tsx";
import { Notice } from "./components/Notice.tsx";
import { ActionTokenScreen } from "./screens/ActionTokenScreen.tsx";
import { AdminScreen } from "./screens/AdminScreen.tsx";
import { ApprovalsScreen } from "./screens/ApprovalsScreen.tsx";
import { ConfirmScreen } from "./screens/ConfirmScreen.tsx";
import { InvoiceScreen } from "./screens/InvoiceScreen.tsx";
import { ModifyScreen } from "./screens/ModifyScreen.tsx";
import { ResultsScreen } from "./screens/ResultsScreen.tsx";
import { SearchScreen } from "./screens/SearchScreen.tsx";
import { SignInScreen } from "./screens/SignInScreen.tsx";
import { TripScreen } from "./screens/TripScreen.tsx";
import { TripsScreen } from "./screens/TripsScreen.tsx";

type Session =
  | { readonly k: "loading" }
  | { readonly k: "anonymous" }
  | {
      readonly k: "signed-in";
      readonly traveller: Traveller;
      readonly approvalsPending: number;
    }
  | { readonly k: "unreachable"; readonly code: string; readonly message: string };

export function App(): JSX.Element {
  const [session, setSession] = useState<Session>({ k: "loading" });
  const location = useLocation();
  const tokenMatch = useMatch("/a/:token");

  const load = useCallback((): void => {
    setSession({ k: "loading" });
    void me()
      .then((res) =>
        setSession({
          k: "signed-in",
          traveller: res.traveller,
          approvalsPending: res.approvalsPending ?? 0,
        }),
      )
      .catch((err: unknown) => {
        if (isApiError(err) && err.status === 401) {
          setSession({ k: "anonymous" });
          return;
        }
        setSession({
          k: "unreachable",
          code: isApiError(err) ? err.code : "unexpected_error",
          message: messageOf(err),
        });
      });
  }, []);

  useEffect(load, [load]);

  // The approvals badge is a count that others change (a new request, a decision),
  // so it is re-read quietly on each navigation — never by flipping to loading.
  const firstPath = useRef(true);
  const signedIn = session.k === "signed-in";
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    if (!signedIn) return;
    void me()
      .then((res) =>
        setSession((s) =>
          s.k === "signed-in" && s.approvalsPending !== (res.approvalsPending ?? 0)
            ? { ...s, approvalsPending: res.approvalsPending ?? 0 }
            : s,
        ),
      )
      .catch(() => undefined);
  }, [location.pathname, signedIn]);

  const signOut = useCallback((): void => {
    void logout()
      .catch(() => undefined)
      .then(() => setSession({ k: "anonymous" }));
  }, []);

  const traveller = session.k === "signed-in" ? session.traveller : null;

  return (
    <div className="app">
      <AppHeader
        traveller={traveller}
        approvalsPending={session.k === "signed-in" ? session.approvalsPending : 0}
      />

      <main className="app-main">
        {session.k === "loading" ? (
          <p className="mono mono--muted">opening your session&hellip;</p>
        ) : null}

        {session.k === "unreachable" ? (
          <div className="screen">
            <h1 className="h1">The service is not answering</h1>
            <Notice tone="blocked" code={session.code} title="Nothing loaded">
              <p className="prose">{session.message}</p>
              <div className="notice__actions">
                <button type="button" className="btn" onClick={load}>
                  Try again
                </button>
              </div>
            </Notice>
          </div>
        ) : null}

        {session.k === "anonymous" && tokenMatch !== null ? <ActionTokenScreen /> : null}

        {session.k === "anonymous" && tokenMatch === null ? (
          <SignInScreen onSignedIn={load} />
        ) : null}

        {session.k === "signed-in" ? (
          <Routes>
            <Route path="/" element={<SearchScreen traveller={session.traveller} />} />
            <Route path="/results/:searchId" element={<ResultsScreen />} />
            <Route
              path="/confirm/:searchId/:offerId"
              element={<ConfirmScreen traveller={session.traveller} />}
            />
            <Route path="/trip/:bookingId" element={<TripScreen />} />
            <Route path="/trip/:bookingId/invoice" element={<InvoiceScreen />} />
            <Route path="/trip/:bookingId/modify" element={<ModifyScreen />} />
            <Route path="/trip/:bookingId/modify/:searchId/:offerId" element={<ModifyScreen />} />
            <Route path="/trips" element={<TripsScreen />} />
            <Route path="/approvals" element={<ApprovalsScreen />} />
            <Route path="/a/:token" element={<ActionTokenScreen />} />
            <Route path="/admin" element={<AdminScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : null}
      </main>

      {traveller !== null ? (
        <footer className="app-footer">
          <span className="mono mono--muted">
            {traveller.email}
            {traveller.isAdmin ? " · admin" : ""} &middot; {traveller.defaultCostCentre}
          </span>
          <span className="spacer" />
          <Link to="/trips" className="btn-text">
            Your trips
          </Link>
          <button type="button" className="btn-text" onClick={signOut}>
            Sign out
          </button>
        </footer>
      ) : null}
    </div>
  );
}
