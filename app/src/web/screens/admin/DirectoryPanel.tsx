/**
 * Directory — every traveller and who approves for them, plus a CSV paste that
 * creates and updates people and reports what it could not resolve.
 */

import { useId, useState } from "react";
import { Notice } from "../../components/Notice.tsx";
import { isApiError, messageOf } from "../../lib/api.ts";
import { formatStamp, plural } from "../../lib/fmt.ts";
import { getDirectory, uploadDirectoryCsv, type DirectoryTraveller, type DirectoryUpload } from "./api.ts";
import { Chip } from "./chips.tsx";
import { Loading, LoadFault, useLoad } from "./useLoad.tsx";

const HEADER = "email,name,manager_email,cost_centre,is_admin";

type Upload =
  | { readonly k: "idle" }
  | { readonly k: "sending" }
  | { readonly k: "done"; readonly result: DirectoryUpload }
  | { readonly k: "failed"; readonly code: string; readonly message: string };

/** Checked before sending, because a wrong header is a mistake worth catching locally. */
function checkCsv(csv: string): string | null {
  const lines = csv
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const head = lines[0];
  if (head === undefined) return "Paste the CSV first.";
  if (head.replace(/\s+/g, "").toLowerCase() !== HEADER) {
    return `The first line must be exactly ${HEADER}`;
  }
  if (lines.length < 2) return "There is a header but no people under it.";
  return null;
}

export function DirectoryPanel(): JSX.Element {
  const dir = useLoad(getDirectory, []);
  const [csv, setCsv] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [upload, setUpload] = useState<Upload>({ k: "idle" });
  const id = useId();

  const submit = (): void => {
    const problem = checkCsv(csv);
    setLocalError(problem);
    if (problem !== null) return;
    setUpload({ k: "sending" });
    void uploadDirectoryCsv(csv)
      .then((result) => {
        setUpload({ k: "done", result });
        dir.reload(true);
      })
      .catch((err: unknown) =>
        setUpload({
          k: "failed",
          code: isApiError(err) ? `${err.status} ${err.code}` : "unexpected_error",
          message: messageOf(err),
        }),
      );
  };

  return (
    <div className="apanel">
      <div className="apanel__head">
        <h2 className="h2">Directory</h2>
        <p className="prose prose--quiet">
          Who works here and who approves for them. A traveller with no manager goes to the fallback approvers.
        </p>
      </div>

      {dir.load.k === "loading" ? <Loading what="the directory" /> : null}
      {dir.load.k === "fault" ? <LoadFault {...dir.load} what="the directory" onRetry={() => dir.reload()} /> : null}
      {dir.load.k === "ready" ? <DirectoryTable travellers={dir.load.data.travellers} /> : null}

      <section className="apanel__section" aria-labelledby={`${id}-up`}>
        <h3 className="h3" id={`${id}-up`}>
          Upload
        </h3>
        <form
          className="stack stack--tight"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="afield__label" htmlFor={`${id}-csv`}>
            Paste the directory CSV
          </label>
          <p className="mono mono--muted" id={`${id}-hint`}>
            header · {HEADER}
          </p>
          <textarea
            id={`${id}-csv`}
            className="atextarea atextarea--mono"
            rows={8}
            spellCheck={false}
            value={csv}
            placeholder={`${HEADER}\nmeera.iyer@acme.in,Meera Iyer,rahul.mehta@acme.in,ENG-OPS,false`}
            aria-describedby={localError !== null ? `${id}-hint ${id}-err` : `${id}-hint`}
            aria-invalid={localError !== null}
            onChange={(e) => {
              setCsv(e.target.value);
              if (localError !== null) setLocalError(null);
            }}
          />
          {localError !== null ? (
            <p className="aerror" id={`${id}-err`} role="alert">
              {localError}
            </p>
          ) : null}
          <div className="row">
            <button type="submit" className="btn" disabled={upload.k === "sending" || csv.trim().length === 0}>
              {upload.k === "sending" ? "Uploading…" : "Upload directory"}
            </button>
          </div>
        </form>

        {upload.k === "failed" ? (
          <Notice tone="blocked" code={upload.code} title="The directory was not updated">
            <p className="prose">{upload.message}</p>
          </Notice>
        ) : null}

        {upload.k === "done" ? <UploadResult result={upload.result} /> : null}
      </section>
    </div>
  );
}

function DirectoryTable({ travellers }: { readonly travellers: readonly DirectoryTraveller[] }): JSX.Element {
  if (travellers.length === 0) {
    return (
      <div className="empty">
        <p className="prose">No one is in the directory yet. Paste a CSV below to add people.</p>
      </div>
    );
  }
  const rows = [...travellers].sort((a, b) => a.name.localeCompare(b.name));
  const noManager = rows.filter((t) => t.managerId === null && t.erasedAt === null).length;
  return (
    <>
      <p className="mono mono--muted">
        {plural(rows.length, "traveller")} · {noManager} without a manager
      </p>
      <div className="atable-wrap">
        <table className="atable">
          <caption className="sr-only">Travellers and their managers</caption>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Manager</th>
              <th scope="col">Cost centre</th>
              <th scope="col">Currency</th>
              <th scope="col">Added</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>
                  <Chip tone="neutral">{t.erasedAt !== null ? "Erased" : t.isAdmin ? "Admin" : "Traveller"}</Chip>
                </td>
                <td>{t.name}</td>
                <td className="muted">{t.email}</td>
                <td className={t.managerName === null ? "muted" : undefined}>
                  {t.managerName ?? "none · fallback approvers"}
                </td>
                <td>{t.defaultCostCentre}</td>
                <td>{t.displayCurrency ?? "—"}</td>
                <td className="muted">{formatStamp(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function UploadResult({ result }: { readonly result: DirectoryUpload }): JSX.Element {
  const clean = result.unresolvedManagers.length === 0 && result.cycles.length === 0;
  return (
    <Notice
      tone={clean ? "in" : "over"}
      code={`created ${result.created} · updated ${result.updated}`}
      title={clean ? "Directory updated" : "Directory updated, with gaps"}
    >
      <div className="kv">
        <div className="kv__row">
          <span className="kv__key">created</span>
          <span className="kv__val">{result.created}</span>
        </div>
        <div className="kv__row">
          <span className="kv__key">updated</span>
          <span className="kv__val">{result.updated}</span>
        </div>
        <div className="kv__row">
          <span className="kv__key">unresolved managers</span>
          <span className="kv__val">{result.unresolvedManagers.length}</span>
        </div>
        <div className="kv__row">
          <span className="kv__key">cycles</span>
          <span className="kv__val">{result.cycles.length}</span>
        </div>
      </div>
      {result.unresolvedManagers.length > 0 ? (
        <>
          <p className="prose">
            These manager emails are not in the directory, so the people who report to them have no manager yet:
          </p>
          <ul className="adetail">
            {result.unresolvedManagers.map((m) => (
              <li key={m} className="mono">
                {m}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {result.cycles.length > 0 ? (
        <>
          <p className="prose">These reporting lines loop back on themselves and need fixing in the source file:</p>
          <ul className="adetail">
            {result.cycles.map((c) => (
              <li key={c} className="mono">
                {c}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Notice>
  );
}
