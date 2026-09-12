/**
 * Admin — the policy as it actually is, plus the export.
 *
 * Read-only on purpose: API_CONTRACT.md exposes PUT /api/admin/policy, but editing
 * policy is an authoring surface with its own inheritance story (SPEC §2.9) and
 * this slice's job is to make the effective policy legible. Everything here is the
 * stored Policy object, with its version stamp, so an admin can see exactly which
 * rules the verdicts on Results were produced by.
 */

import { useEffect, useState } from "react";
import type { Policy } from "../../core/types.ts";
import { ADMIN_CSV_HREF, getPolicy, isApiError, messageOf } from "../lib/api.ts";
import { formatMoney, formatStamp, plural } from "../lib/fmt.ts";
import { Notice } from "../components/Notice.tsx";

type Phase =
  | { readonly k: "loading" }
  | { readonly k: "ready"; readonly policy: Policy }
  | { readonly k: "denied" }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

export function AdminScreen(): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ k: "loading" });

  useEffect(() => {
    let live = true;
    void getPolicy()
      .then((res) => {
        if (live) setPhase({ k: "ready", policy: res.policy });
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (isApiError(err) && (err.status === 401 || err.status === 403)) {
          setPhase({ k: "denied" });
          return;
        }
        setPhase({
          k: "fault",
          code: isApiError(err) ? err.code : "unexpected_error",
          message: messageOf(err),
        });
      });
    return () => {
      live = false;
    };
  }, []);

  if (phase.k === "loading") {
    return (
      <div className="screen">
        <h1 className="h1">Policy</h1>
        <p className="mono mono--muted">loading the effective policy&hellip;</p>
      </div>
    );
  }

  if (phase.k === "denied") {
    return (
      <div className="screen">
        <h1 className="h1">Policy</h1>
        <Notice tone="neutral" code="403" title="This page is for travel managers">
          <p className="prose">
            Your account is not an administrator, so there is nothing here for you to see.
          </p>
        </Notice>
      </div>
    );
  }

  if (phase.k === "fault") {
    return (
      <div className="screen">
        <h1 className="h1">Policy</h1>
        <Notice tone="blocked" code={phase.code} title="We could not load the policy">
          <p className="prose">{phase.message}</p>
        </Notice>
      </div>
    );
  }

  const { policy } = phase;

  return (
    <div className="admin">
      <div className="screen__head">
        <h1 className="h1">Policy</h1>
        <p className="mono mono--muted">
          entity {policy.entityId} &middot; version {policy.version} &middot; saved{" "}
          {formatStamp(policy.updatedAt)} by {policy.updatedBy}
        </p>
        <p className="prose">
          Every verdict a traveller sees was produced by exactly this record, and the
          version is stored with each booking so an audit years later reproduces the
          decision.
        </p>
      </div>

      <section className="admin__group">
        <h2 className="h2">Nightly caps</h2>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Per-night caps by city tier and named city</caption>
            <thead>
              <tr>
                <th scope="col">City tier</th>
                <th scope="col">City override</th>
                <th scope="col">Cap per night</th>
              </tr>
            </thead>
            <tbody>
              {policy.caps.map((cap) => (
                <tr key={`${cap.cityTier}|${cap.city ?? ""}`}>
                  <td>{cap.cityTier}</td>
                  <td>{cap.city ?? "—"}</td>
                  <td className="is-numeric">{formatMoney(cap.perNight)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="prose prose--quiet">
          A rate over the applicable cap is not bookable in this slice. It resolves to
          blocked with the arithmetic stated, not to a silent exception.
        </p>
      </section>

      <section className="admin__group">
        <h2 className="h2">Blocked</h2>
        <div className="kv">
          <div className="kv__row">
            <span className="kv__key">Countries</span>
            <span className="kv__val">
              {policy.blockedCountries.length === 0
                ? "none"
                : policy.blockedCountries.join(", ")}
            </span>
          </div>
          <div className="kv__row">
            <span className="kv__key">Suppliers</span>
            <span className="kv__val">
              {policy.blockedSuppliers.length === 0 ? "none" : policy.blockedSuppliers.join(", ")}
            </span>
          </div>
          <div className="kv__row">
            <span className="kv__key">Free cancellation required</span>
            <span className="kv__val">{policy.requireFlexible ? "yes" : "no"}</span>
          </div>
          <div className="kv__row">
            <span className="kv__key">Incidentals buffer</span>
            <span className="kv__val">
              {formatMoney({
                minor: policy.incidentalsBufferMinor,
                currency: policy.caps[0]?.perNight.currency ?? "INR",
              })}
            </span>
          </div>
        </div>
      </section>

      <section className="admin__group">
        <h2 className="h2">Cost centres</h2>
        <div className="admin__chips">
          {policy.costCentres.map((c) => (
            <span key={c} className={`chip${c === policy.defaultCostCentre ? " chip--state" : ""}`}>
              {c}
              {c === policy.defaultCostCentre ? " · default" : ""}
            </span>
          ))}
        </div>
        <p className="prose prose--quiet">
          {plural(policy.costCentres.length, "cost centre")}. A traveller sees theirs
          already chosen on Confirm and may change it there.
        </p>
      </section>

      <section className="admin__group">
        <h2 className="h2">Export</h2>
        <p className="prose">
          One row per booking, with the commute, the cap that applied, the verdict and the
          policy version that produced it.
        </p>
        <a className="btn" href={ADMIN_CSV_HREF} download>
          Download bookings.csv
        </a>
      </section>
    </div>
  );
}
