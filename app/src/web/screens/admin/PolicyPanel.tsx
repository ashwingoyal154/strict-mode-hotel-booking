/**
 * Policy — caps with their own currency, the approval SLA and escalation depth,
 * justification reasons, fallback approvers and travel advisories, saved through
 * PUT /api/admin/policy. Fields this tab does not edit are sent back unchanged.
 *
 * Amounts are typed as decimals and converted to integer minor units by string
 * arithmetic, so "8000.50" is exactly 800050 paise.
 */

import { useId, useMemo, useRef, useState } from "react";
import type { Policy, TravelAdvisory } from "../../../core/types.ts";
import { DecidedLine } from "../../components/DecidedLine.tsx";
import { Notice } from "../../components/Notice.tsx";
import { isApiError, messageOf } from "../../lib/api.ts";
import { formatMoney, formatStamp } from "../../lib/fmt.ts";
import { getPolicy, putPolicy, type PolicyBody } from "./api.ts";
import { Chip } from "./chips.tsx";
import { decimalToMinor, isCurrencyCode, minorToDecimal } from "./format.ts";
import { Loading, LoadFault, useLoad } from "./useLoad.tsx";

// ---------- draft ----------

interface CapRow {
  readonly key: string;
  readonly cityTier: string;
  readonly city: string;
  readonly amount: string;
  readonly currency: string;
}

interface ReasonRow {
  readonly key: string;
  readonly code: string;
  readonly label: string;
}

interface AdvisoryRow {
  readonly key: string;
  readonly countryCode: string;
  readonly city: string;
  readonly level: TravelAdvisory["level"];
  readonly note: string;
  /** The stored stamp, and the signature it was stamped for. null on a new row. */
  readonly updatedAt: string | null;
  readonly signature: string | null;
}

interface Draft {
  readonly caps: readonly CapRow[];
  readonly slaMinutes: string;
  readonly maxEscalations: string;
  readonly reasons: readonly ReasonRow[];
  readonly fallbackEmails: string;
  readonly advisories: readonly AdvisoryRow[];
}

function advisorySignature(a: { countryCode: string; city: string; level: string; note: string }): string {
  return JSON.stringify([a.countryCode.trim().toUpperCase(), a.city.trim(), a.level, a.note.trim()]);
}

function toDraft(p: Policy): Draft {
  return {
    caps: p.caps.map((c, i) => ({
      key: `cap-${i}`,
      cityTier: c.cityTier,
      city: c.city ?? "",
      amount: minorToDecimal(c.perNight.minor, c.perNight.currency),
      currency: c.perNight.currency,
    })),
    slaMinutes: String(p.approval.slaMinutes),
    maxEscalations: String(p.approval.maxEscalations),
    reasons: p.approval.justificationReasons.map((r, i) => ({ key: `reason-${i}`, code: r.code, label: r.label })),
    fallbackEmails: p.approval.fallbackApproverEmails.join("\n"),
    advisories: p.advisories.map((a, i) => {
      const row = { countryCode: a.countryCode, city: a.city ?? "", level: a.level, note: a.note };
      return { key: `adv-${i}`, ...row, updatedAt: a.updatedAt, signature: advisorySignature(row) };
    }),
  };
}

/** Everything that matters for "is there anything to save", without row keys. */
function signatureOf(d: Draft): string {
  return JSON.stringify([
    d.caps.map((c) => [c.cityTier, c.city, c.amount, c.currency]),
    d.slaMinutes,
    d.maxEscalations,
    d.reasons.map((r) => [r.code, r.label]),
    d.fallbackEmails
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    d.advisories.map((a) => advisorySignature(a)),
  ]);
}

type Errors = Readonly<Record<string, string>>;

function build(d: Draft, p: Policy): { body: PolicyBody | null; errors: Errors } {
  const errors: Record<string, string> = {};
  const now = new Date().toISOString();

  const seenCaps = new Set<string>();
  const caps = d.caps.map((c) => {
    const tier = c.cityTier.trim();
    const city = c.city.trim();
    const currency = c.currency.trim().toUpperCase();
    if (tier.length === 0) errors[`${c.key}-tier`] = "Name the city tier.";
    if (!isCurrencyCode(currency)) errors[`${c.key}-currency`] = "Use a three-letter code, like INR.";
    let minor = 0;
    if (isCurrencyCode(currency)) {
      const parsed = decimalToMinor(c.amount, currency, "The cap");
      if (!parsed.ok) errors[`${c.key}-amount`] = parsed.error;
      else if (parsed.value <= 0) errors[`${c.key}-amount`] = "The cap must be more than zero.";
      else minor = parsed.value;
    }
    const k = `${tier.toLowerCase()}|${city.toLowerCase()}`;
    if (tier.length > 0 && seenCaps.has(k)) errors[`${c.key}-tier`] = "This tier and city already have a cap.";
    seenCaps.add(k);
    return { cityTier: tier, city: city.length === 0 ? null : city, perNight: { minor, currency } };
  });
  if (caps.length === 0) errors["caps"] = "Keep at least one cap, or nothing can be judged.";

  let slaMinutes = 0;
  if (!/^\d+$/.test(d.slaMinutes.trim()) || Number(d.slaMinutes) < 1) {
    errors["slaMinutes"] = "Whole minutes, at least 1.";
  } else slaMinutes = Number(d.slaMinutes);

  let maxEscalations = 0;
  if (!/^\d+$/.test(d.maxEscalations.trim())) errors["maxEscalations"] = "A whole number, 0 or more.";
  else maxEscalations = Number(d.maxEscalations);

  const seenReasons = new Set<string>();
  const justificationReasons = d.reasons.map((r) => {
    const code = r.code.trim();
    const label = r.label.trim();
    if (!/^[a-z0-9_]+$/.test(code)) errors[`${r.key}-code`] = "Lowercase letters, digits and underscores.";
    else if (seenReasons.has(code)) errors[`${r.key}-code`] = "This code is already used.";
    seenReasons.add(code);
    if (label.length === 0) errors[`${r.key}-label`] = "Write the label a traveller picks.";
    return { code, label };
  });
  if (justificationReasons.length === 0) errors["reasons"] = "Keep at least one reason a traveller can give.";

  const fallbackApproverEmails = d.fallbackEmails
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const badEmail = fallbackApproverEmails.find((e) => !/^[^\s@]+@[^\s@]+$/.test(e));
  if (badEmail !== undefined) errors["fallbackEmails"] = `${badEmail} is not an email address.`;

  const advisories: TravelAdvisory[] = d.advisories.map((a) => {
    const countryCode = a.countryCode.trim().toUpperCase();
    const city = a.city.trim();
    const note = a.note.trim();
    if (!/^[A-Z]{2}$/.test(countryCode)) errors[`${a.key}-country`] = "Two letters, like TH.";
    if (note.length === 0) errors[`${a.key}-note`] = "Say what a traveller should know.";
    const unchanged = a.signature !== null && a.signature === advisorySignature(a) && a.updatedAt !== null;
    return {
      countryCode,
      city: city.length === 0 ? null : city,
      level: a.level,
      note,
      updatedAt: unchanged && a.updatedAt !== null ? a.updatedAt : now,
    };
  });

  if (Object.keys(errors).length > 0) return { body: null, errors };

  return {
    body: {
      entityId: p.entityId,
      caps,
      requireFlexible: p.requireFlexible,
      blockedCountries: p.blockedCountries,
      blockedSuppliers: p.blockedSuppliers,
      costCentres: p.costCentres,
      defaultCostCentre: p.defaultCostCentre,
      incidentalsBufferMinor: p.incidentalsBufferMinor,
      reportingCurrency: p.reportingCurrency,
      approval: {
        mode: p.approval.mode,
        slaMinutes,
        maxEscalations,
        justificationReasons,
        fallbackApproverEmails,
      },
      advisories,
    },
    errors,
  };
}

// ---------- panel ----------

type Save =
  | { readonly k: "idle" }
  | { readonly k: "saving" }
  | { readonly k: "saved"; readonly version: number }
  | { readonly k: "failed"; readonly code: string; readonly message: string; readonly detail: unknown };

export function PolicyPanel(): JSX.Element {
  const policy = useLoad(getPolicy, []);
  /** Survives the editor's remount on a new version, so "saved as vN" stays visible. */
  const [justSaved, setJustSaved] = useState<number | null>(null);

  if (policy.load.k === "loading") return <Loading what="the effective policy" />;
  if (policy.load.k === "fault") {
    return <LoadFault {...policy.load} what="the policy" onRetry={() => policy.reload()} />;
  }
  const current = policy.load.data.policy;
  return (
    <PolicyEditor
      key={current.version}
      policy={current}
      justSaved={justSaved === current.version ? justSaved : null}
      onSaved={(p) => {
        setJustSaved(p.version);
        policy.set({ policy: p });
      }}
    />
  );
}

function PolicyEditor({
  policy,
  justSaved,
  onSaved,
}: {
  readonly policy: Policy;
  readonly justSaved: number | null;
  readonly onSaved: (p: Policy) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => toDraft(policy));
  const [save, setSave] = useState<Save>(justSaved === null ? { k: "idle" } : { k: "saved", version: justSaved });
  const [showErrors, setShowErrors] = useState(false);
  const counter = useRef(0);
  const uid = useId();
  const nextKey = (prefix: string): string => `${prefix}-new-${++counter.current}`;

  const original = useMemo(() => signatureOf(toDraft(policy)), [policy]);
  const dirty = signatureOf(draft) !== original;
  const built = build(draft, policy);
  const errors: Errors = showErrors ? built.errors : {};
  const errorCount = Object.keys(built.errors).length;

  const patch = (next: Partial<Draft>): void => {
    setDraft((d) => ({ ...d, ...next }));
    if (save.k === "saved" || save.k === "failed") setSave({ k: "idle" });
  };

  const updateRow = <R extends { key: string }>(rows: readonly R[], key: string, change: Partial<R>): R[] =>
    rows.map((r) => (r.key === key ? { ...r, ...change } : r));

  const submit = (): void => {
    if (built.body === null) {
      setShowErrors(true);
      return;
    }
    setSave({ k: "saving" });
    void putPolicy(built.body)
      .then((res) => {
        setShowErrors(false);
        setDraft(toDraft(res.policy));
        setSave({ k: "saved", version: res.policy.version });
        onSaved(res.policy);
      })
      .catch((err: unknown) => {
        setSave({
          k: "failed",
          code: isApiError(err) ? `${err.status} ${err.code}` : "unexpected_error",
          message: messageOf(err),
          detail: isApiError(err) ? err.detail : undefined,
        });
      });
  };

  const fid = (name: string): string => `${uid}-${name}`;
  const err = (name: string): JSX.Element | null =>
    errors[name] !== undefined ? (
      <span className="aerror" id={`${fid(name)}-err`}>
        {errors[name]}
      </span>
    ) : null;
  const invalid = (name: string): { "aria-invalid": boolean; "aria-describedby"?: string } =>
    errors[name] !== undefined
      ? { "aria-invalid": true, "aria-describedby": `${fid(name)}-err` }
      : { "aria-invalid": false };

  return (
    <form
      className="apanel"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className="apanel__head">
        <h2 className="h2">Policy</h2>
        <p className="mono mono--muted">
          v{policy.version} · saved {formatStamp(policy.updatedAt)} by {policy.updatedBy} · entity {policy.entityId}
        </p>
      </div>

      {/* ---- caps ---- */}
      <section className="apanel__section" aria-labelledby={fid("caps-h")}>
        <h3 className="h3" id={fid("caps-h")}>
          Nightly caps
        </h3>
        <p className="prose prose--quiet">
          A named city overrides its tier. Each cap is argued in the currency it is written in.
        </p>
        <div className="atable-wrap">
          <table className="atable">
            <caption className="sr-only">Per-night caps by city tier and city</caption>
            <thead>
              <tr>
                <th scope="col">Applies to</th>
                <th scope="col">City tier</th>
                <th scope="col">City</th>
                <th scope="col" className="num">
                  Cap per night
                </th>
                <th scope="col">Currency</th>
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.caps.map((c, i) => (
                <tr key={c.key}>
                  <td>
                    <Chip tone="neutral">{c.city.trim().length > 0 ? "City" : "Tier"}</Chip>
                  </td>
                  <td>
                    <label className="sr-only" htmlFor={fid(`${c.key}-tier`)}>
                      City tier, row {i + 1}
                    </label>
                    <input
                      id={fid(`${c.key}-tier`)}
                      className="ainput ainput--short"
                      value={c.cityTier}
                      onChange={(e) => patch({ caps: updateRow(draft.caps, c.key, { cityTier: e.target.value }) })}
                      {...invalid(`${c.key}-tier`)}
                    />
                    {err(`${c.key}-tier`)}
                  </td>
                  <td>
                    <label className="sr-only" htmlFor={fid(`${c.key}-city`)}>
                      City, row {i + 1}, blank for the whole tier
                    </label>
                    <input
                      id={fid(`${c.key}-city`)}
                      className="ainput ainput--short"
                      value={c.city}
                      placeholder="whole tier"
                      onChange={(e) => patch({ caps: updateRow(draft.caps, c.key, { city: e.target.value }) })}
                    />
                  </td>
                  <td className="num">
                    <label className="sr-only" htmlFor={fid(`${c.key}-amount`)}>
                      Cap per night, row {i + 1}
                    </label>
                    <input
                      id={fid(`${c.key}-amount`)}
                      className="ainput ainput--num"
                      inputMode="decimal"
                      value={c.amount}
                      onChange={(e) => patch({ caps: updateRow(draft.caps, c.key, { amount: e.target.value }) })}
                      {...invalid(`${c.key}-amount`)}
                    />
                    {err(`${c.key}-amount`)}
                  </td>
                  <td>
                    <label className="sr-only" htmlFor={fid(`${c.key}-currency`)}>
                      Currency, row {i + 1}
                    </label>
                    <input
                      id={fid(`${c.key}-currency`)}
                      className="ainput ainput--code"
                      value={c.currency}
                      maxLength={3}
                      autoCapitalize="characters"
                      onChange={(e) =>
                        patch({ caps: updateRow(draft.caps, c.key, { currency: e.target.value.toUpperCase() }) })
                      }
                      {...invalid(`${c.key}-currency`)}
                    />
                    {err(`${c.key}-currency`)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-text"
                      onClick={() => patch({ caps: draft.caps.filter((r) => r.key !== c.key) })}
                    >
                      Remove<span className="sr-only"> cap row {i + 1}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {err("caps")}
        <div>
          <button
            type="button"
            className="btn-text"
            onClick={() =>
              patch({
                caps: [
                  ...draft.caps,
                  { key: nextKey("cap"), cityTier: "", city: "", amount: "", currency: policy.reportingCurrency },
                ],
              })
            }
          >
            Add a cap
          </button>
        </div>
      </section>

      {/* ---- approval ---- */}
      <section className="apanel__section" aria-labelledby={fid("appr-h")}>
        <h3 className="h3" id={fid("appr-h")}>
          Approval
        </h3>
        <DecidedLine label="mode" value={`${policy.approval.mode} · nothing over cap books without a yes`} />
        <div className="aform__grid">
          <div className="afield">
            <label className="afield__label" htmlFor={fid("slaMinutes")}>
              Time to decide, per level · minutes
            </label>
            <input
              id={fid("slaMinutes")}
              className="ainput ainput--num"
              inputMode="numeric"
              value={draft.slaMinutes}
              onChange={(e) => patch({ slaMinutes: e.target.value })}
              {...invalid("slaMinutes")}
            />
            {err("slaMinutes")}
          </div>
          <div className="afield">
            <label className="afield__label" htmlFor={fid("maxEscalations")}>
              Escalations before it stops climbing
            </label>
            <input
              id={fid("maxEscalations")}
              className="ainput ainput--num"
              inputMode="numeric"
              value={draft.maxEscalations}
              onChange={(e) => patch({ maxEscalations: e.target.value })}
              {...invalid("maxEscalations")}
            />
            {err("maxEscalations")}
          </div>
        </div>
        <div className="afield">
          <label className="afield__label" htmlFor={fid("fallbackEmails")}>
            Fallback approvers · one email per line, used when a traveller has no manager
          </label>
          <textarea
            id={fid("fallbackEmails")}
            className="atextarea atextarea--mono"
            rows={3}
            value={draft.fallbackEmails}
            spellCheck={false}
            onChange={(e) => patch({ fallbackEmails: e.target.value })}
            {...invalid("fallbackEmails")}
          />
          {err("fallbackEmails")}
        </div>
      </section>

      {/* ---- justification reasons ---- */}
      <section className="apanel__section" aria-labelledby={fid("reasons-h")}>
        <h3 className="h3" id={fid("reasons-h")}>
          Justification reasons
        </h3>
        <p className="prose prose--quiet">What a traveller picks before explaining an over-cap stay in their own words.</p>
        <ul className="alist">
          {draft.reasons.map((r, i) => (
            <li key={r.key} className="alist__row">
              <div className="afield">
                <label className="afield__label" htmlFor={fid(`${r.key}-code`)}>
                  Code {i + 1}
                </label>
                <input
                  id={fid(`${r.key}-code`)}
                  className="ainput"
                  value={r.code}
                  spellCheck={false}
                  onChange={(e) => patch({ reasons: updateRow(draft.reasons, r.key, { code: e.target.value }) })}
                  {...invalid(`${r.key}-code`)}
                />
                {err(`${r.key}-code`)}
              </div>
              <div className="afield afield--grow">
                <label className="afield__label" htmlFor={fid(`${r.key}-label`)}>
                  Label {i + 1}
                </label>
                <input
                  id={fid(`${r.key}-label`)}
                  className="ainput ainput--prose"
                  value={r.label}
                  onChange={(e) => patch({ reasons: updateRow(draft.reasons, r.key, { label: e.target.value }) })}
                  {...invalid(`${r.key}-label`)}
                />
                {err(`${r.key}-label`)}
              </div>
              <button
                type="button"
                className="btn-text alist__remove"
                onClick={() => patch({ reasons: draft.reasons.filter((x) => x.key !== r.key) })}
              >
                Remove<span className="sr-only"> reason {i + 1}</span>
              </button>
            </li>
          ))}
        </ul>
        {err("reasons")}
        <div>
          <button
            type="button"
            className="btn-text"
            onClick={() => patch({ reasons: [...draft.reasons, { key: nextKey("reason"), code: "", label: "" }] })}
          >
            Add a reason
          </button>
        </div>
      </section>

      {/* ---- advisories ---- */}
      <section className="apanel__section" aria-labelledby={fid("adv-h")}>
        <h3 className="h3" id={fid("adv-h")}>
          Travel advisories
        </h3>
        <p className="prose prose--quiet">
          Flagged at confirm and on the in-market view. A blank city covers the whole country.
        </p>
        {draft.advisories.length === 0 ? (
          <p className="mono mono--muted">no advisories</p>
        ) : (
          <div className="atable-wrap">
            <table className="atable">
              <caption className="sr-only">Travel advisories by country and city</caption>
              <thead>
                <tr>
                  <th scope="col">Level</th>
                  <th scope="col">Country</th>
                  <th scope="col">City</th>
                  <th scope="col">Note</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.advisories.map((a, i) => (
                  <tr key={a.key} className={a.level === "high" ? "stripe--blocked" : "stripe--over"}>
                    <td>
                      <div className="stack stack--tight">
                        <Chip tone={a.level === "high" ? "blocked" : "over"}>{a.level === "high" ? "High" : "Caution"}</Chip>
                        <label className="sr-only" htmlFor={fid(`${a.key}-level`)}>
                          Level, advisory {i + 1}
                        </label>
                        <select
                          id={fid(`${a.key}-level`)}
                          className="aselect"
                          value={a.level}
                          onChange={(e) =>
                            patch({
                              advisories: updateRow(draft.advisories, a.key, {
                                level: e.target.value === "high" ? "high" : "caution",
                              }),
                            })
                          }
                        >
                          <option value="caution">caution</option>
                          <option value="high">high</option>
                        </select>
                      </div>
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={fid(`${a.key}-country`)}>
                        Country code, advisory {i + 1}
                      </label>
                      <input
                        id={fid(`${a.key}-country`)}
                        className="ainput ainput--code"
                        maxLength={2}
                        value={a.countryCode}
                        onChange={(e) =>
                          patch({
                            advisories: updateRow(draft.advisories, a.key, { countryCode: e.target.value.toUpperCase() }),
                          })
                        }
                        {...invalid(`${a.key}-country`)}
                      />
                      {err(`${a.key}-country`)}
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={fid(`${a.key}-city`)}>
                        City, advisory {i + 1}, blank for the whole country
                      </label>
                      <input
                        id={fid(`${a.key}-city`)}
                        className="ainput ainput--short"
                        placeholder="whole country"
                        value={a.city}
                        onChange={(e) => patch({ advisories: updateRow(draft.advisories, a.key, { city: e.target.value }) })}
                      />
                    </td>
                    <td className="wrap">
                      <label className="sr-only" htmlFor={fid(`${a.key}-note`)}>
                        Note, advisory {i + 1}
                      </label>
                      <textarea
                        id={fid(`${a.key}-note`)}
                        className="atextarea atextarea--cell"
                        rows={2}
                        value={a.note}
                        onChange={(e) => patch({ advisories: updateRow(draft.advisories, a.key, { note: e.target.value }) })}
                        {...invalid(`${a.key}-note`)}
                      />
                      {err(`${a.key}-note`)}
                    </td>
                    <td className="muted">
                      {a.updatedAt !== null && a.signature === advisorySignature(a) ? formatStamp(a.updatedAt) : "on save"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-text"
                        onClick={() => patch({ advisories: draft.advisories.filter((x) => x.key !== a.key) })}
                      >
                        Remove<span className="sr-only"> advisory {i + 1}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div>
          <button
            type="button"
            className="btn-text"
            onClick={() =>
              patch({
                advisories: [
                  ...draft.advisories,
                  {
                    key: nextKey("adv"),
                    countryCode: "",
                    city: "",
                    level: "caution",
                    note: "",
                    updatedAt: null,
                    signature: null,
                  },
                ],
              })
            }
          >
            Add an advisory
          </button>
        </div>
      </section>

      {/* ---- unchanged here ---- */}
      <section className="apanel__section" aria-labelledby={fid("rest-h")}>
        <h3 className="h3" id={fid("rest-h")}>
          Also in this policy
        </h3>
        <p className="prose prose--quiet">Not edited on this tab. Saved back exactly as they are.</p>
        <div className="kv">
          <KV k="Reporting currency" v={policy.reportingCurrency} />
          <KV k="Blocked countries" v={policy.blockedCountries.length === 0 ? "none" : policy.blockedCountries.join(", ")} />
          <KV k="Blocked suppliers" v={policy.blockedSuppliers.length === 0 ? "none" : policy.blockedSuppliers.join(", ")} />
          <KV k="Free cancellation required" v={policy.requireFlexible ? "yes" : "no"} />
          <KV k="Cost centres" v={`${policy.costCentres.join(", ")} · default ${policy.defaultCostCentre}`} />
          <KV
            k="Incidentals buffer"
            v={formatMoney({ minor: policy.incidentalsBufferMinor, currency: policy.reportingCurrency })}
          />
        </div>
      </section>

      {/* ---- save ---- */}
      <div className="asave">
        {showErrors && errorCount > 0 ? (
          <p className="aerror" role="alert">
            {errorCount === 1 ? "One field needs fixing" : `${errorCount} fields need fixing`} before this can be saved.
          </p>
        ) : null}
        {save.k === "failed" ? (
          <Notice tone="blocked" code={save.code} title="The policy was not saved">
            <p className="prose">{save.message}</p>
            <DetailLines detail={save.detail} />
          </Notice>
        ) : null}
        <div className="asave__bar">
          <button type="submit" className="btn btn--primary asave__primary" disabled={!dirty || save.k === "saving"}>
            {save.k === "saving" ? "Saving…" : "Save policy"}
          </button>
          {dirty && save.k !== "saving" ? (
            <button
              type="button"
              className="btn-text"
              onClick={() => {
                setDraft(toDraft(policy));
                setShowErrors(false);
                setSave({ k: "idle" });
              }}
            >
              Discard changes
            </button>
          ) : null}
          <span className="mono asave__status" role="status">
            {save.k === "saved" ? `saved as v${save.version}` : dirty ? "unsaved changes" : `v${policy.version} · no changes`}
          </span>
        </div>
      </div>
    </form>
  );
}

function KV({ k, v }: { readonly k: string; readonly v: string }): JSX.Element {
  return (
    <div className="kv__row">
      <span className="kv__key">{k}</span>
      <span className="kv__val">{v}</span>
    </div>
  );
}

export function DetailLines({ detail }: { readonly detail: unknown }): JSX.Element | null {
  if (detail === undefined || detail === null) return null;
  const lines: string[] = [];
  if (Array.isArray(detail)) {
    for (const item of detail) lines.push(typeof item === "string" ? item : JSON.stringify(item));
  } else if (typeof detail === "object") {
    for (const [k, v] of Object.entries(detail)) lines.push(`${k} · ${typeof v === "string" ? v : JSON.stringify(v)}`);
  } else {
    lines.push(String(detail));
  }
  if (lines.length === 0) return null;
  return (
    <ul className="adetail">
      {lines.map((l, i) => (
        <li key={i} className="mono">
          {l}
        </li>
      ))}
    </ul>
  );
}
