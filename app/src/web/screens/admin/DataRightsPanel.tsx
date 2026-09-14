/**
 * Data rights — export one traveller's data as JSON, or erase them. Erasure asks
 * for their email typed out, then shows the receipt: what was deleted, what was
 * kept with personal fields stripped, and the legal basis for keeping it.
 */

import { useId, useState } from "react";
import type { ErasureReceipt } from "../../../core/types.ts";
import { Notice } from "../../components/Notice.tsx";
import { isApiError, messageOf } from "../../lib/api.ts";
import { formatStamp, plural } from "../../lib/fmt.ts";
import { eraseTraveller, exportTraveller, getDirectory, type DirectoryTraveller } from "./api.ts";
import { downloadJson, fileSlug } from "./download.ts";
import { firstName, todayInKolkata } from "./format.ts";
import { Loading, LoadFault, useLoad } from "./useLoad.tsx";

export function DataRightsPanel(): JSX.Element {
  const dir = useLoad(getDirectory, []);
  const [selectedId, setSelectedId] = useState("");
  const id = useId();

  return (
    <div className="apanel">
      <div className="apanel__head">
        <h2 className="h2">Data rights</h2>
        <p className="prose prose--quiet">Answer a traveller&rsquo;s request to see or erase what we hold about them.</p>
      </div>

      {dir.load.k === "loading" ? <Loading what="travellers" /> : null}
      {dir.load.k === "fault" ? <LoadFault {...dir.load} what="travellers" onRetry={() => dir.reload()} /> : null}
      {dir.load.k === "ready" ? (
        <>
          <div className="afield">
            <label className="afield__label" htmlFor={`${id}-who`}>
              Traveller
            </label>
            <select
              id={`${id}-who`}
              className="aselect aselect--wide"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              <option value="">Choose a traveller</option>
              {[...dir.load.data.travellers]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.email}
                    {t.erasedAt !== null ? " · erased" : ""}
                  </option>
                ))}
            </select>
          </div>
          {(() => {
            const t = dir.load.data.travellers.find((x) => x.id === selectedId);
            return t === undefined ? null : (
              <SubjectRights key={t.id} traveller={t} onErased={() => dir.reload(true)} />
            );
          })()}
        </>
      ) : null}
    </div>
  );
}

type Exporting =
  | { readonly k: "idle" }
  | { readonly k: "busy" }
  | { readonly k: "done"; readonly summary: string }
  | { readonly k: "failed"; readonly code: string; readonly message: string };

type Erasing =
  | { readonly k: "idle" }
  | { readonly k: "busy" }
  | { readonly k: "done"; readonly receipt: ErasureReceipt }
  | { readonly k: "failed"; readonly status: number; readonly code: string; readonly message: string };

function SubjectRights({
  traveller,
  onErased,
}: {
  readonly traveller: DirectoryTraveller;
  readonly onErased: () => void;
}): JSX.Element {
  const [exp, setExp] = useState<Exporting>({ k: "idle" });
  const [erase, setErase] = useState<Erasing>({ k: "idle" });
  /** The email as it was when chosen: erasure pseudonymises it on the next directory read. */
  const [email] = useState(traveller.email);
  const [confirm, setConfirm] = useState("");
  const id = useId();
  const matches = confirm.trim() === email;
  const erased = traveller.erasedAt !== null || erase.k === "done";

  const doExport = (): void => {
    setExp({ k: "busy" });
    void exportTraveller(traveller.id)
      .then((data) => {
        downloadJson(`data-export-${fileSlug(email)}-${todayInKolkata()}.json`, data);
        setExp({
          k: "done",
          summary: [
            plural(data.bookings.length, "booking"),
            plural(data.approvals.length, "approval"),
            plural(data.invoices.length, "invoice"),
            plural(data.notifications.length, "notification"),
            plural(data.searches.length, "search", "searches"),
          ].join(" · "),
        });
      })
      .catch((err: unknown) =>
        setExp({
          k: "failed",
          code: isApiError(err) ? `${err.status} ${err.code}` : "unexpected_error",
          message: messageOf(err),
        }),
      );
  };

  const doErase = (): void => {
    if (!matches) return;
    setErase({ k: "busy" });
    void eraseTraveller(traveller.id, confirm.trim())
      .then((receipt) => {
        setErase({ k: "done", receipt });
        onErased();
      })
      .catch((err: unknown) =>
        setErase({
          k: "failed",
          status: isApiError(err) ? err.status : 0,
          code: isApiError(err) ? err.code : "unexpected_error",
          message: messageOf(err),
        }),
      );
  };

  return (
    <div className="stack">
      <div className="kv">
        <div className="kv__row">
          <span className="kv__key">name</span>
          <span className="kv__val">{traveller.name}</span>
        </div>
        <div className="kv__row">
          <span className="kv__key">email</span>
          <span className="kv__val">{traveller.email}</span>
        </div>
        <div className="kv__row">
          <span className="kv__key">manager</span>
          <span className="kv__val">{traveller.managerName ?? "none"}</span>
        </div>
        <div className="kv__row">
          <span className="kv__key">added</span>
          <span className="kv__val">{formatStamp(traveller.createdAt)}</span>
        </div>
        {traveller.erasedAt !== null ? (
          <div className="kv__row">
            <span className="kv__key">erased</span>
            <span className="kv__val">{formatStamp(traveller.erasedAt)}</span>
          </div>
        ) : null}
      </div>

      <section className="apanel__section" aria-labelledby={`${id}-exp`}>
        <h3 className="h3" id={`${id}-exp`}>
          Export
        </h3>
        <p className="prose prose--quiet">
          Everything held about this traveller, as one JSON file: profile, bookings, approvals, invoices,
          notifications, searches, card events and supplier log entries.
        </p>
        <div className="row">
          <button type="button" className="btn" onClick={doExport} disabled={exp.k === "busy"}>
            {exp.k === "busy" ? "Exporting…" : "Export JSON"}
          </button>
          <span className="mono mono--muted" role="status">
            {exp.k === "done" ? `downloaded · ${exp.summary}` : ""}
          </span>
        </div>
        {exp.k === "failed" ? (
          <Notice tone="blocked" code={exp.code} title="The export did not download">
            <p className="prose">{exp.message}</p>
          </Notice>
        ) : null}
      </section>

      <section className="apanel__section" aria-labelledby={`${id}-erase`}>
        <h3 className="h3" id={`${id}-erase`}>
          Erase
        </h3>

        {erase.k === "done" ? (
          <Receipt receipt={erase.receipt} name={traveller.name} />
        ) : erased ? (
          <p className="prose">This traveller was already erased on {formatStamp(traveller.erasedAt ?? "")}.</p>
        ) : (
          <form
            className="stack stack--tight"
            onSubmit={(e) => {
              e.preventDefault();
              doErase();
            }}
          >
            <p className="prose">
              Erasure replaces {firstName(traveller.name)}&rsquo;s personal details with a pseudonym. Bookings and
              invoices are kept without them, because tax law requires it; searches and notifications are deleted.
              It cannot be undone.
            </p>
            <label className="afield__label" htmlFor={`${id}-confirm`}>
              Type {email} to confirm
            </label>
            <input
              id={`${id}-confirm`}
              className="ainput"
              value={confirm}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => {
                setConfirm(e.target.value);
                if (erase.k === "failed") setErase({ k: "idle" });
              }}
            />
            <div className="row">
              <button type="submit" className="btn-quiet-danger" disabled={!matches || erase.k === "busy"}>
                {erase.k === "busy" ? "Erasing…" : `Erase ${firstName(traveller.name)}`}
              </button>
            </div>
            {erase.k === "failed" ? (
              <Notice
                tone={erase.code === "confirmation_mismatch" || erase.code === "already_erased" ? "neutral" : "blocked"}
                code={erase.status === 0 ? erase.code : `${erase.status} ${erase.code}`}
                title={
                  erase.code === "confirmation_mismatch"
                    ? "The email did not match"
                    : erase.code === "already_erased"
                      ? "Already erased"
                      : "Nothing was erased"
                }
              >
                <p className="prose">
                  {erase.code === "confirmation_mismatch"
                    ? "The email must match their current address exactly. Nothing was erased."
                    : erase.code === "already_erased"
                      ? "This traveller was erased before. There is nothing more to remove."
                      : `${erase.message} Nothing was erased.`}
                </p>
              </Notice>
            ) : null}
          </form>
        )}
      </section>
    </div>
  );
}

function Receipt({ receipt, name }: { readonly receipt: ErasureReceipt; readonly name: string }): JSX.Element {
  return (
    <Notice tone="neutral" code={`erased · ${receipt.pseudonym}`} title={`${name} is erased`}>
      <div className="receipt">
        <div className="kv">
          <div className="kv__row">
            <span className="kv__key">erased at</span>
            <span className="kv__val">{formatStamp(receipt.erasedAt)}</span>
          </div>
          <div className="kv__row">
            <span className="kv__key">now known as</span>
            <span className="kv__val">{receipt.pseudonym}</span>
          </div>
        </div>
        <span className="label">Deleted</span>
        <div className="kv">
          <div className="kv__row">
            <span className="kv__key">searches</span>
            <span className="kv__val">{receipt.deleted.searches}</span>
          </div>
          <div className="kv__row">
            <span className="kv__key">notifications</span>
            <span className="kv__val">{receipt.deleted.notifications}</span>
          </div>
        </div>
        <span className="label">Retained, personal fields stripped</span>
        <div className="kv">
          <div className="kv__row">
            <span className="kv__key">bookings</span>
            <span className="kv__val">{receipt.retained.bookings}</span>
          </div>
          <div className="kv__row">
            <span className="kv__key">invoices</span>
            <span className="kv__val">{receipt.retained.invoices}</span>
          </div>
        </div>
        <span className="label">Legal basis for retaining</span>
        <p className="prose">{receipt.retained.basis}</p>
      </div>
    </Notice>
  );
}
