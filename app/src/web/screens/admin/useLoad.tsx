/**
 * One load lifecycle for every admin panel, and the one designed fault state.
 * A 401/403 is not an error to an admin surface: it is "this page is not for you".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError, messageOf } from "../../lib/api.ts";
import { Notice } from "../../components/Notice.tsx";

export type Load<T> =
  | { readonly k: "loading" }
  | { readonly k: "ready"; readonly data: T; readonly fetchedAt: number }
  | { readonly k: "fault"; readonly status: number; readonly code: string; readonly message: string };

export function faultOf(err: unknown): { status: number; code: string; message: string } {
  return {
    status: isApiError(err) ? err.status : 0,
    code: isApiError(err) ? err.code : "unexpected_error",
    message: messageOf(err),
  };
}

/**
 * `reload(true)` refreshes without dropping back to the loading state, so a
 * table never blanks while it refreshes.
 */
export function useLoad<T>(fetcher: () => Promise<T>, deps: readonly unknown[]): {
  readonly load: Load<T>;
  readonly reload: (silent?: boolean) => void;
  readonly set: (data: T) => void;
} {
  const [load, setLoad] = useState<Load<T>>({ k: "loading" });
  const seq = useRef(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const reload = useCallback((silent = false): void => {
    const mine = ++seq.current;
    if (!silent) setLoad({ k: "loading" });
    void fetchRef
      .current()
      .then((data) => {
        if (mine === seq.current) setLoad({ k: "ready", data, fetchedAt: Date.now() });
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        // A silent refresh that fails keeps what is on screen.
        if (silent) return;
        setLoad({ k: "fault", ...faultOf(err) });
      });
  }, []);

  useEffect(() => {
    reload(false);
    return () => {
      seq.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const set = useCallback((data: T): void => {
    seq.current += 1;
    setLoad({ k: "ready", data, fetchedAt: Date.now() });
  }, []);

  return { load, reload, set };
}

export function Loading({ what }: { readonly what: string }): JSX.Element {
  return (
    <p className="mono mono--muted" role="status">
      loading {what}&hellip;
    </p>
  );
}

export function LoadFault({
  status,
  code,
  message,
  what,
  onRetry,
}: {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly what: string;
  readonly onRetry?: () => void;
}): JSX.Element {
  if (status === 401 || status === 403) {
    return (
      <Notice tone="neutral" code={`${status} ${code}`} title="This is for travel managers">
        <p className="prose">
          Your account is not an administrator, so there is nothing here for you to see.
        </p>
      </Notice>
    );
  }
  return (
    <Notice
      tone="blocked"
      code={status === 0 ? code : `${status} ${code}`}
      title={`We could not load ${what}`}
      actions={
        onRetry !== undefined ? (
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        ) : undefined
      }
    >
      <p className="prose">{message}</p>
    </Notice>
  );
}

/** A clock that re-renders at most once per `everyMs`. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}
