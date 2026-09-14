import type { ApprovalRequest, Booking, PolicyVerdict, Traveller } from "../../src/core/types.ts";
import { money } from "../../src/core/money.ts";
import {
  AlreadyDecidedError,
  NotCurrentApproverError,
  RejectionNoteRequiredError,
  canDecide,
  currentLevel,
  decide,
  materialiseEscalations,
  openApproval,
  recordOutcome,
  resolveApproverChain,
  slaView,
  validateJustification,
  withdraw,
} from "../../src/core/approval.ts";
import { booking, policy, traveller } from "./core-builders.ts";

const OVER: PolicyVerdict = {
  state: "over",
  reasonCode: "over_cap",
  reason: "₹10,594/night is over your ₹9,000 Mumbai cap by ₹1,594 — ₹6,376 for 4 nights",
  policyVersion: 1,
  capPerNight: money(900000, "INR"),
  overageMinor: 159400,
  evaluatorVersion: 2,
  overage: money(159400, "INR"),
  fxPin: null,
  advisory: null,
};

const JUSTIFICATION = { code: "client_site", text: "Client workshop is in this building" };
const T0 = "2026-09-14T03:30:00.000Z";
const at = (hours: number, minutes = 0) => new Date(Date.parse(T0) + (hours * 60 + minutes) * 60_000);

const ASHA = traveller({ id: "trv_asha", managerId: "trv_meera" });
const MEERA = traveller({ id: "trv_meera", email: "meera@acme.test", name: "Meera Iyer", managerId: "trv_vikram" });
const VIKRAM = traveller({ id: "trv_vikram", email: "vikram@acme.test", name: "Vikram Shah", managerId: "trv_cfo" });
const CFO = traveller({ id: "trv_cfo", email: "cfo@acme.test", name: "Priya Nair", managerId: "trv_ceo" });
const CEO = traveller({ id: "trv_ceo", email: "ceo@acme.test", name: "Rahul Menon", managerId: null });
const ADMIN = traveller({ id: "trv_admin", email: "admin@acme.test", name: "Admin", isAdmin: true });

function pendingBooking(): Booking {
  return booking({ id: "bkg_over", state: "pending_approval", verdict: OVER, card: null });
}

function open(chain: readonly string[] = ["trv_meera", "trv_vikram", "trv_cfo"]): ApprovalRequest {
  return openApproval({
    id: "apr_1",
    booking: pendingBooking(),
    justification: JUSTIFICATION,
    chain,
    policy: policy(),
    now: new Date(T0),
  });
}

// ---------- justification ----------

describe("validateJustification", () => {
  it("accepts a listed reason with enough words", () => {
    expect(validateJustification(policy(), JUSTIFICATION)).toEqual({ ok: true });
  });

  it("rejects a reason the policy does not list", () => {
    const result = validateJustification(policy(), { code: "vibes", text: "It has a very nice pool" });
    expect(result.ok).toBe(false);
  });

  it("needs at least 10 characters after trimming", () => {
    expect(validateJustification(policy(), { code: "safety", text: "123456789" }).ok).toBe(false);
    expect(validateJustification(policy(), { code: "safety", text: "   123456789   " }).ok).toBe(false);
    expect(validateJustification(policy(), { code: "safety", text: "1234567890" }).ok).toBe(true);
  });
});

// ---------- chain ----------

describe("resolveApproverChain", () => {
  const directory: readonly Traveller[] = [ASHA, MEERA, VIKRAM, CFO, CEO, ADMIN];

  it("walks managers upward, capped at maxEscalations + 1", () => {
    expect(resolveApproverChain({ traveller: ASHA, directory, policy: policy() })).toEqual([
      "trv_meera",
      "trv_vikram",
      "trv_cfo",
    ]);
  });

  it("respects a smaller escalation limit", () => {
    const p = policy({ approval: { ...policy().approval, maxEscalations: 0 } });
    expect(resolveApproverChain({ traveller: ASHA, directory, policy: p })).toEqual(["trv_meera"]);
  });

  it("skips an erased manager and keeps climbing", () => {
    const erased = { ...MEERA, erasedAt: "2026-09-01T00:00:00.000Z" };
    expect(resolveApproverChain({ traveller: ASHA, directory: [ASHA, erased, VIKRAM, CFO, CEO], policy: policy() })).toEqual(
      ["trv_vikram", "trv_cfo", "trv_ceo"],
    );
  });

  it("is cycle-safe and never makes the traveller their own approver", () => {
    const a = traveller({ id: "trv_a", managerId: "trv_b" });
    const b = traveller({ id: "trv_b", managerId: "trv_c" });
    const c = traveller({ id: "trv_c", managerId: "trv_b" }); // b ↔ c loop
    expect(resolveApproverChain({ traveller: a, directory: [a, b, c], policy: policy() })).toEqual(["trv_b", "trv_c"]);

    const x = traveller({ id: "trv_x", managerId: "trv_y" });
    const y = traveller({ id: "trv_y", managerId: "trv_x" }); // loops back to the traveller
    expect(resolveApproverChain({ traveller: x, directory: [x, y], policy: policy() })).toEqual(["trv_y"]);
  });

  it("stops at a manager id the directory does not know", () => {
    const orphan = traveller({ id: "trv_o", managerId: "trv_gone" });
    expect(resolveApproverChain({ traveller: orphan, directory: [orphan, ADMIN], policy: policy() })).toEqual([
      "trv_admin",
    ]);
  });

  it("falls back to fallback approvers by email, case-insensitively", () => {
    const solo = traveller({ id: "trv_solo", managerId: null });
    const p = policy({
      approval: { ...policy().approval, fallbackApproverEmails: ["VIKRAM@acme.test", "solo@acme.test"] },
    });
    const soloWithEmail = { ...solo, email: "solo@acme.test" };
    expect(resolveApproverChain({ traveller: soloWithEmail, directory: [soloWithEmail, VIKRAM, ADMIN], policy: p })).toEqual(
      ["trv_vikram"],
    );
  });

  it("then falls back to admins other than the traveller", () => {
    const solo = traveller({ id: "trv_solo", managerId: null });
    const admin2 = traveller({ id: "trv_admin2", isAdmin: true, createdAt: "2025-01-01T00:00:00.000Z" });
    expect(resolveApproverChain({ traveller: solo, directory: [solo, ADMIN, admin2], policy: policy() })).toEqual([
      "trv_admin2",
      "trv_admin",
    ]);
    expect(resolveApproverChain({ traveller: ADMIN, directory: [ADMIN], policy: policy() })).toEqual([]);
  });

  it("never falls back across entities", () => {
    const solo = traveller({ id: "trv_solo", managerId: null });
    const foreignAdmin = traveller({ id: "trv_other", isAdmin: true, entityId: "globex" });
    expect(resolveApproverChain({ traveller: solo, directory: [solo, foreignAdmin], policy: policy() })).toEqual([]);
  });
});

// ---------- opening ----------

describe("openApproval", () => {
  it("opens a pending request at level 0, due after the SLA", () => {
    const req = open();
    expect(req.state).toBe("pending");
    expect(req.levels).toEqual([
      { level: 0, approverId: "trv_meera", startedAt: T0, dueAt: "2026-09-14T05:30:00.000Z", cause: "initial" },
    ]);
    expect(req.overagePerNight).toEqual(money(159400, "INR"));
    expect(req.overageStay).toEqual(money(637600, "INR"));
    expect(req.slaMinutes).toBe(120);
    expect(req.slaBreachedAtTop).toBe(false);
    expect(req.justificationText).toBe("Client workshop is in this building");
  });

  it("refuses an empty chain and an invalid justification", () => {
    expect(() => open([])).toThrow(RangeError);
    expect(() =>
      openApproval({
        id: "apr_x",
        booking: pendingBooking(),
        justification: { code: "client_site", text: "short" },
        chain: ["trv_meera"],
        policy: policy(),
        now: new Date(T0),
      }),
    ).toThrow(RangeError);
  });
});

// ---------- escalation ----------

describe("materialiseEscalations — deterministic from history", () => {
  const EXPECTED_LEVELS = [
    { level: 0, approverId: "trv_meera", startedAt: T0, dueAt: "2026-09-14T05:30:00.000Z", cause: "initial" },
    {
      level: 1,
      approverId: "trv_vikram",
      startedAt: "2026-09-14T05:30:00.000Z",
      dueAt: "2026-09-14T07:30:00.000Z",
      cause: "sla_breach",
    },
    {
      level: 2,
      approverId: "trv_cfo",
      startedAt: "2026-09-14T07:30:00.000Z",
      dueAt: "2026-09-14T09:30:00.000Z",
      cause: "sla_breach",
    },
  ];

  it("starts each new level at the previous dueAt, even when read seven hours late", () => {
    const { approval, escalated } = materialiseEscalations(open(), at(7));
    expect(approval.levels).toEqual(EXPECTED_LEVELS);
    expect(escalated).toHaveLength(2);
    expect(approval.slaBreachedAtTop).toBe(true);
    expect(approval.state).toBe("pending");
  });

  it("produces the identical levels array from repeated on-time reads", () => {
    let req = open();
    for (const now of [at(1), at(2), at(3), at(4), at(5, 59), at(6), at(7)]) {
      req = materialiseEscalations(req, now).approval;
    }
    const late = materialiseEscalations(open(), at(7)).approval;
    expect(JSON.stringify(req.levels)).toBe(JSON.stringify(late.levels));
    expect(JSON.stringify(req)).toBe(JSON.stringify(late));
  });

  it("escalates at the due instant, not a moment later", () => {
    expect(materialiseEscalations(open(), at(1, 59)).approval.levels).toHaveLength(1);
    expect(materialiseEscalations(open(), at(2)).approval.levels).toHaveLength(2);
  });

  it("is idempotent: a second read at the same instant changes nothing", () => {
    const first = materialiseEscalations(open(), at(7)).approval;
    const second = materialiseEscalations(first, at(7));
    expect(second.approval).toBe(first);
    expect(second.escalated).toEqual([]);
  });

  it("never expires — a month later it is still pending, flagged at the top", () => {
    const { approval } = materialiseEscalations(open(), at(24 * 30));
    expect(approval.state).toBe("pending");
    expect(approval.levels).toHaveLength(3);
    expect(approval.slaBreachedAtTop).toBe(true);
    expect(currentLevel(approval).approverId).toBe("trv_cfo");
  });

  it("does not escalate a request that is no longer pending", () => {
    const decided = decide(open(), { approverId: "trv_meera", decision: "approve", note: null, now: at(1) });
    expect(materialiseEscalations(decided, at(7)).approval).toBe(decided);
  });
});

describe("canDecide and slaView", () => {
  it("lets only the first approver decide before any breach", () => {
    const req = open();
    expect(canDecide(req, "trv_meera")).toBe(true);
    expect(canDecide(req, "trv_vikram")).toBe(false);
    expect(canDecide(req, "trv_stranger")).toBe(false);
  });

  it("widens, never revokes: after escalation the earlier approver can still decide", () => {
    const escalated = materialiseEscalations(open(), at(3)).approval;
    expect(canDecide(escalated, "trv_meera")).toBe(true);
    expect(canDecide(escalated, "trv_vikram")).toBe(true);
    expect(canDecide(escalated, "trv_cfo")).toBe(false);
  });

  it("reports the live SLA inside the window", () => {
    expect(slaView(open(), at(1))).toEqual({
      level: 0,
      approverId: "trv_meera",
      dueAt: "2026-09-14T05:30:00.000Z",
      remainingMs: 3_600_000,
      breached: false,
      atTop: false,
      nextApproverId: "trv_vikram",
    });
  });

  it("reports a breach at the top of the chain", () => {
    expect(slaView(open(), at(7))).toEqual({
      level: 2,
      approverId: "trv_cfo",
      dueAt: "2026-09-14T09:30:00.000Z",
      remainingMs: -3_600_000,
      breached: true,
      atTop: true,
      nextApproverId: null,
    });
  });
});

// ---------- decisions ----------

describe("decide", () => {
  it("lets an earlier-level approver approve after escalation, recording history to that moment", () => {
    const approved = decide(open(), { approverId: "trv_meera", decision: "approve", note: "  ", now: at(3) });
    expect(approved.state).toBe("approved");
    expect(approved.decidedBy).toBe("trv_meera");
    expect(approved.decidedAt).toBe("2026-09-14T06:30:00.000Z");
    expect(approved.decisionNote).toBeNull();
    expect(approved.levels).toHaveLength(2);
  });

  it("lets an escalated approver decide", () => {
    const rejected = decide(open(), {
      approverId: "trv_vikram",
      decision: "reject",
      note: " Book the in-policy hotel next door ",
      now: at(2, 30),
    });
    expect(rejected.state).toBe("rejected");
    expect(rejected.decisionNote).toBe("Book the in-policy hotel next door");
  });

  it("requires a note to reject", () => {
    expect(() => decide(open(), { approverId: "trv_meera", decision: "reject", note: null, now: at(1) })).toThrow(
      RejectionNoteRequiredError,
    );
    expect(() => decide(open(), { approverId: "trv_meera", decision: "reject", note: "   ", now: at(1) })).toThrow(
      RejectionNoteRequiredError,
    );
  });

  it("refuses someone who is not yet, or never, an approver", () => {
    expect(() => decide(open(), { approverId: "trv_cfo", decision: "approve", note: null, now: at(1) })).toThrow(
      NotCurrentApproverError,
    );
    expect(() => decide(open(), { approverId: "trv_asha", decision: "approve", note: null, now: at(1) })).toThrow(
      NotCurrentApproverError,
    );
  });

  it("checks the approver before the note, so a stranger learns nothing about the rules", () => {
    expect(() => decide(open(), { approverId: "trv_cfo", decision: "reject", note: null, now: at(1) })).toThrow(
      NotCurrentApproverError,
    );
  });

  it("refuses a second decision", () => {
    const approved = decide(open(), { approverId: "trv_meera", decision: "approve", note: null, now: at(1) });
    expect(canDecide(approved, "trv_meera")).toBe(false);
    expect(() => decide(approved, { approverId: "trv_meera", decision: "reject", note: "no", now: at(1) })).toThrow(
      AlreadyDecidedError,
    );
  });
});

describe("withdraw and recordOutcome", () => {
  it("withdraws a pending request on the traveller's behalf", () => {
    const w = withdraw(open(), at(3));
    expect(w.state).toBe("withdrawn");
    expect(w.decidedBy).toBe("trv_asha");
    expect(w.decidedAt).toBe("2026-09-14T06:30:00.000Z");
    expect(() => withdraw(w, at(4))).toThrow(AlreadyDecidedError);
  });

  it("records what happened after an approval, once", () => {
    const approved = decide(open(), { approverId: "trv_meera", decision: "approve", note: null, now: at(1) });
    const lost = recordOutcome(approved, "rate_lost");
    expect(lost.outcome).toBe("rate_lost");
    expect(recordOutcome(lost, "rate_lost")).toBe(lost);
    expect(() => recordOutcome(lost, "confirmed")).toThrow(AlreadyDecidedError);
  });

  it("gives no outcome to a request that was not approved", () => {
    expect(() => recordOutcome(open(), "confirmed")).toThrow(RangeError);
  });
});
