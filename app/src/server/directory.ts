/**
 * Directory upload — Slice 2's stand-in for SCIM. The admin uploads the employee
 * list with manager emails, and that manager chain is what approvals walk.
 * Uploads are upserts by email. Unknown managers and manager cycles are reported,
 * never silently repaired (approval chain resolution is cycle-safe regardless).
 */

import { newId } from "../core/ids.ts";
import type { DirectoryEntry, Policy, Traveller } from "../core/types.ts";
import type { Store } from "../store/Store.ts";
import { normaliseEmail } from "./auth.ts";

export interface DirectoryResult {
  readonly created: number;
  readonly updated: number;
  readonly unresolvedManagers: string[];
  readonly cycles: string[];
}

export const DIRECTORY_CSV_HEADER = ["email", "name", "manager_email", "cost_centre", "is_admin"] as const;

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text.charAt(i + 1) === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export function parseDirectoryCsv(csv: string): { entries: DirectoryEntry[] } | { error: string } {
  const rows = parseCsvRows(csv);
  const header = rows[0]?.map((h) => h.trim().toLowerCase());
  if (header === undefined) return { error: "The CSV is empty." };
  const index = (name: string): number => header.indexOf(name);
  for (const required of ["email", "name"]) {
    if (index(required) < 0) return { error: `The CSV header must include "${required}".` };
  }
  const entries: DirectoryEntry[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const cell = (name: string): string => (index(name) < 0 ? "" : (row[index(name)] ?? "").trim());
    const email = cell("email");
    const name = cell("name");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: `Row ${r + 1}: "${email}" is not an email address.` };
    if (name === "") return { error: `Row ${r + 1}: name is required.` };
    const manager = cell("manager_email");
    const costCentre = cell("cost_centre");
    entries.push({
      email,
      name,
      managerEmail: manager === "" ? null : manager,
      costCentre: costCentre === "" ? null : costCentre,
      isAdmin: /^(true|1|yes|y)$/i.test(cell("is_admin")),
    });
  }
  return { entries };
}

export async function applyDirectory(
  store: Store,
  args: { entityId: string; entries: readonly DirectoryEntry[]; policy: Policy; actingAdminId: string; now: Date },
): Promise<DirectoryResult> {
  let created = 0;
  let updated = 0;
  const byEmail = new Map<string, Traveller>();
  for (const t of await store.listTravellers(args.entityId)) byEmail.set(normaliseEmail(t.email), t);

  for (const entry of args.entries) {
    const email = normaliseEmail(entry.email);
    const existing = byEmail.get(email);
    if (existing !== undefined) {
      const next = await store.mutateTraveller(existing.id, (cur) => ({
        ...cur,
        name: entry.name.trim(),
        defaultCostCentre: entry.costCentre ?? cur.defaultCostCentre,
        // An upload can never lock out the admin who is uploading it.
        isAdmin: cur.id === args.actingAdminId ? true : entry.isAdmin,
      }));
      byEmail.set(email, next);
      updated += 1;
    } else {
      const traveller: Traveller = {
        id: newId("trv"),
        email,
        name: entry.name.trim(),
        entityId: args.entityId,
        defaultCostCentre: entry.costCentre ?? args.policy.defaultCostCentre,
        isAdmin: entry.isAdmin,
        createdAt: args.now.toISOString(),
        managerId: null,
        displayCurrency: null,
        erasedAt: null,
      };
      await store.putTraveller(traveller);
      byEmail.set(email, traveller);
      created += 1;
    }
  }

  const unresolved = new Set<string>();
  for (const entry of args.entries) {
    const person = byEmail.get(normaliseEmail(entry.email));
    if (person === undefined) continue;
    let managerId: string | null = null;
    if (entry.managerEmail !== null) {
      const manager = byEmail.get(normaliseEmail(entry.managerEmail));
      if (manager === undefined) unresolved.add(normaliseEmail(entry.managerEmail));
      else managerId = manager.id;
    }
    const next = await store.mutateTraveller(person.id, (cur) => ({ ...cur, managerId }));
    byEmail.set(normaliseEmail(entry.email), next);
  }

  return { created, updated, unresolvedManagers: [...unresolved].sort(), cycles: findCycles([...byEmail.values()]) };
}

/** Each manager cycle once, as "a@x → b@x → a@x", starting from its alphabetically first member. */
export function findCycles(travellers: readonly Traveller[]): string[] {
  const byId = new Map(travellers.map((t) => [t.id, t]));
  const found = new Set<string>();
  for (const start of travellers) {
    const path: string[] = [];
    const seen = new Map<string, number>();
    let cursor: Traveller | undefined = start;
    while (cursor !== undefined && !seen.has(cursor.id)) {
      seen.set(cursor.id, path.length);
      path.push(cursor.id);
      cursor = cursor.managerId === null ? undefined : byId.get(cursor.managerId);
    }
    if (cursor === undefined) continue;
    const loop = path.slice(seen.get(cursor.id) ?? 0).map((id) => byId.get(id)?.email ?? id);
    const first = [...loop].sort()[0] ?? "";
    const at = loop.indexOf(first);
    const rotated = [...loop.slice(at), ...loop.slice(0, at)];
    found.add([...rotated, rotated[0]].join(" → "));
  }
  return [...found].sort();
}

export async function directoryWithManagers(
  store: Store,
  entityId: string,
): Promise<Array<Traveller & { managerName: string | null }>> {
  const travellers = await store.listTravellers(entityId);
  const byId = new Map(travellers.map((t) => [t.id, t]));
  return travellers
    .map((t) => ({ ...t, managerName: t.managerId === null ? null : (byId.get(t.managerId)?.name ?? null) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
