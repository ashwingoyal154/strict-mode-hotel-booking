/**
 * The dev SSO stub standing in for OIDC (API_CONTRACT.md § Auth). Not a product
 * screen and not an account wall — it exists so the rest of the app has a session
 * until the real identity provider is wired in.
 */

import { useState } from "react";
import type { Traveller } from "../../core/types.ts";
import { login, messageOf } from "../lib/api.ts";
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

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (email.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await login(email.trim(), name);
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

      <form className="signin__form" onSubmit={submit}>
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
