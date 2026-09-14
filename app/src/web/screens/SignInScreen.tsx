/**
 * The dev SSO stub standing in for OIDC (API_CONTRACT.md § Auth). Not a product
 * screen and not an account wall — it exists so the rest of the app has a session
 * until the real identity provider is wired in.
 *
 * Slice 2: when the server's demo flag is on, three square persona chips sit under
 * the email field (traveller, manager, admin), each with a one-line machine-voice
 * role, so a demo can play every part of an approval without inventing accounts.
 */

import { useEffect, useState } from "react";
import type { Traveller } from "../../core/types.ts";
import { getDemoPersonas, login, messageOf, type DemoPersona } from "../lib/api.ts";
import { Notice } from "../components/Notice.tsx";

export function SignInScreen({
  onSignedIn,
}: {
  readonly onSignedIn: (t: Traveller) => void;
}): JSX.Element {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [personas, setPersonas] = useState<readonly DemoPersona[]>([]);

  useEffect(() => {
    let live = true;
    void getDemoPersonas()
      .then((res) => {
        if (live && res.enabled) setPersonas(res.personas);
      })
      .catch(() => {
        /* no demo flag, or an older server: sign-in works without personas */
      });
    return () => {
      live = false;
    };
  }, []);

  const signIn = async (address: string, displayName: string): Promise<void> => {
    if (address.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await login(address.trim(), displayName);
      onSignedIn(res.traveller);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <div className="screen__head">
        <h1 className="h1">Sign in</h1>
        <p className="prose">
          Your company signs you in through SSO. This build stands that in with a work
          email, so there is no password and no account to set up.
        </p>
      </div>

      {error !== null ? (
        <Notice tone="blocked" code="sign-in failed">
          <p className="prose">{error}</p>
        </Notice>
      ) : null}

      <form
        className="signin__form"
        onSubmit={(e) => {
          e.preventDefault();
          void signIn(email, name);
        }}
      >
        <div className="field">
          <label className="label" htmlFor="email">
            Work email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        {personas.length > 0 ? (
          <div className="field">
            <span className="label" id="persona-label">
              Demo &middot; sign in as
            </span>
            <div className="personas" role="group" aria-labelledby="persona-label">
              {personas.map((p) => (
                <button
                  key={p.email}
                  type="button"
                  className="persona"
                  disabled={busy}
                  onClick={() => void signIn(p.email, p.name)}
                >
                  <span className="persona__name">{p.name}</span>
                  <span className="persona__role">
                    {p.role}
                    {p.blurb.length > 0 ? ` · ${p.blurb}` : ""}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="field">
          <label className="label" htmlFor="name">
            Name (first sign-in only)
          </label>
          <input
            id="name"
            className="input"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "Signing in…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
