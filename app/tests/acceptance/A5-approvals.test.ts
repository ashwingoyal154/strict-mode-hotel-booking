/**
 * A5 — "An over-cap booking cannot be confirmed without a justification; the
 * approver is notified within 30 seconds; the traveller is told truthfully whether
 * the rate is held; SLA breach auto-escalates one level and never silently expires."
 *
 * Plus the outcome the spec's T-list worries about most: an approval that wins
 * after the rate has moved.
 */
import {
  makeHarness,
  withApprovalCast,
  book,
  JUSTIFICATION,
  type Harness,
  type Agent,
} from "./harness.ts";
import type { ApprovalRequest, Booking, NotificationRecord, RankedOffer } from "../../src/core/types.ts";

async function requestOverCap(
  h: Harness,
  asha: Agent,
  pick: (overCap: RankedOffer[]) => RankedOffer | undefined = (o) => o[0],
) {
  const s = await h.search(undefined, 4, asha);
  const offer = pick(s.overCap);
  expect(offer, "fixture must offer an over-cap rate near BKC").toBeDefined();
  if (!offer) throw new Error("no over-cap offer");
  const res = await book(h, s.searchId, offer, { who: asha, justification: JUSTIFICATION });
  return { s, offer, res };
}

describe("A5 — hard approval for over-cap bookings", () => {
  it("creates a pending request, issues no card, and notifies the approver immediately", async () => {
    const h = await makeHarness();
    const { asha, meera } = await withApprovalCast(h);

    const t0 = Date.now();
    const { res } = await requestOverCap(h, asha);
    expect(res.status).toBe(202);
    const booking = res.body.booking as Booking;
    const approval = res.body.approval as ApprovalRequest;

    expect(booking.state).toBe("pending_approval");
    expect(booking.card).toBeNull();
    expect(approval.state).toBe("pending");
    expect(approval.justificationCode).toBe(JUSTIFICATION.code);

    // Notification lands before the 202 returns — well inside 30 seconds.
    const inbox = await meera.get("/api/notifications");
    expect(inbox.status).toBe(200);
    const note = (inbox.body.notifications as NotificationRecord[]).find(
      (n) => n.kind === "approval_requested" && n.approvalId === approval.id,
    );
    expect(note).toBeDefined();
    expect(note?.actionUrl).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(30_000);

    const queue = await meera.get("/api/approvals?scope=mine&state=pending");
    expect(queue.body.approvals.map((a: ApprovalRequest) => a.id)).toContain(approval.id);
  }, 60000);

  it("tells the truth about the hold — held rates say so, unholdable rates say the price may move", async () => {
    const h = await makeHarness();
    const { asha } = await withApprovalCast(h);
    const s = await h.search(undefined, 4, asha);

    const holdable = s.overCap.find((r) => r.offer.rate.holdable);
    const unholdable = s.overCap.find((r) => !r.offer.rate.holdable);

    if (holdable) {
      const res = await book(h, s.searchId, holdable, { who: asha, justification: JUSTIFICATION });
      expect(res.status).toBe(202);
      const hold = (res.body.booking as Booking).hold;
      expect(hold?.held).toBe(true);
      expect(hold?.heldUntil).toBeTruthy();
      expect(hold?.message).toMatch(/held/i);
    }
    if (unholdable) {
      const res = await book(h, s.searchId, unholdable, { who: asha, justification: JUSTIFICATION });
      expect(res.status).toBe(202);
      const hold = (res.body.booking as Booking).hold;
      expect(hold?.held).toBe(false);
      expect(hold?.heldUntil).toBeNull();
      expect(hold?.message).toMatch(/may move/i);
    }
    expect(holdable ?? unholdable).toBeDefined();
  }, 60000);

  it("confirms with a card only after approval", async () => {
    const h = await makeHarness();
    const { asha, meera } = await withApprovalCast(h);
    const { res, offer } = await requestOverCap(
      h,
      asha,
      (o) => o.find((r) => !r.offer.rate.id.endsWith("~LATEDRIFT")),
    );
    const approval = res.body.approval as ApprovalRequest;

    const decided = await meera
      .post(`/api/approvals/${approval.id}/decision`)
      .send({ decision: "approve", note: "Workshop is on site." });
    expect(decided.status).toBe(200);
    expect(decided.body.approval.state).toBe("approved");
    expect(["confirmed", "rate_lost", "sold_out"]).toContain(decided.body.approval.outcome);

    if (decided.body.approval.outcome === "confirmed") {
      const b = decided.body.booking as Booking;
      expect(b.state).toBe("confirmed");
      expect(b.card).not.toBeNull();
      expect(b.card?.authorisedTotal.currency).toBe(offer.offer.rate.currency);
    }
  }, 60000);

  it("reports 'approved but the rate moved' as an outcome, books nothing, and tells the traveller", async () => {
    const h = await makeHarness();
    const { asha, meera } = await withApprovalCast(h);
    const s = await h.search(undefined, 4, asha);
    const late = s.overCap.find((r) => r.offer.rate.id.endsWith("~LATEDRIFT"));
    expect(late, "the ~LATEDRIFT canary must be an over-cap BKC rate").toBeDefined();
    if (!late) return;

    const res = await book(h, s.searchId, late, { who: asha, justification: JUSTIFICATION });
    expect(res.status).toBe(202);
    const approval = res.body.approval as ApprovalRequest;

    const decided = await meera
      .post(`/api/approvals/${approval.id}/decision`)
      .send({ decision: "approve", note: "Fine." });
    expect(decided.status).toBe(200);
    expect(decided.body.approval.state).toBe("approved");
    expect(decided.body.approval.outcome).toBe("rate_lost");

    const b = decided.body.booking as Booking;
    expect(b.state).toBe("cancelled");
    expect(b.cancellationReason).toBe("rate_lost");

    const inbox = await asha.get("/api/notifications");
    const lost = (inbox.body.notifications as NotificationRecord[]).find(
      (n) => n.kind === "approval_rate_lost" && n.bookingId === b.id,
    );
    expect(lost).toBeDefined();
  }, 60000);

  it("requires a note to reject", async () => {
    const h = await makeHarness();
    const { asha, meera } = await withApprovalCast(h);
    const { res } = await requestOverCap(h, asha);
    const approval = res.body.approval as ApprovalRequest;

    const noNote = await meera.post(`/api/approvals/${approval.id}/decision`).send({ decision: "reject" });
    expect(noNote.status).toBe(422);
    expect(noNote.body.error.code).toBe("note_required");

    const withNote = await meera
      .post(`/api/approvals/${approval.id}/decision`)
      .send({ decision: "reject", note: "There is an in-policy hotel a four-minute walk away." });
    expect(withNote.status).toBe(200);
    expect(withNote.body.approval.state).toBe("rejected");
  }, 60000);

  it("escalates one level on SLA breach, exactly once, and never expires at the top", async () => {
    const h = await makeHarness();
    const { asha, meera, vikram } = await withApprovalCast(h);
    const { res } = await requestOverCap(h, asha);
    const approval = res.body.approval as ApprovalRequest;
    const sla = approval.slaMinutes;

    // Past the first SLA: the request must reach Vikram.
    h.advanceMinutes(sla + 1);
    const [a, b] = await Promise.all([
      vikram.get("/api/approvals?scope=mine&state=pending"),
      meera.get("/api/approvals?scope=mine&state=pending"),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.approvals.map((x: ApprovalRequest) => x.id)).toContain(approval.id);

    const vikramInbox = await vikram.get("/api/notifications");
    const escalations = (vikramInbox.body.notifications as NotificationRecord[]).filter(
      (n) => n.kind === "approval_escalated" && n.approvalId === approval.id,
    );
    expect(escalations.length).toBe(1);

    // Meera was asked first; escalation widens who may decide, it never revokes her.
    const detail = await meera.get(`/api/approvals/${approval.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.approval.levels.length).toBe(2);

    // Far past every SLA: still pending, flagged, never expired.
    h.advanceMinutes(sla * 10);
    await h.tick();
    const late = await h.agent.get("/api/admin/approvals?state=pending");
    const row = (late.body.approvals as ApprovalRequest[]).find((x) => x.id === approval.id);
    expect(row?.state).toBe("pending");
    expect(row?.slaBreachedAtTop).toBe(true);
  }, 60000);

  it("honours a one-tap token exactly once", async () => {
    const h = await makeHarness();
    const { asha, meera } = await withApprovalCast(h);
    await requestOverCap(h, asha);

    const inbox = await meera.get("/api/notifications");
    const note = (inbox.body.notifications as NotificationRecord[]).find((n) => n.kind === "approval_requested");
    const token = note?.actionUrl?.split("/a/")[1]?.split(/[?#]/)[0];
    expect(token).toBeTruthy();
    if (!token) return;

    const preview = await h.agent.get(`/api/approvals/action/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.valid).toBe(true);

    const approvalId = preview.body.approval.id as string;
    const anon = (await import("supertest")).default(h.app);
    const first = await anon
      .post(`/api/approvals/${approvalId}/decision`)
      .send({ decision: preview.body.decision, note: "Approved from the notification.", actionToken: token });
    expect(first.status).toBe(200);

    const second = await anon
      .post(`/api/approvals/${approvalId}/decision`)
      .send({ decision: preview.body.decision, note: "Again.", actionToken: token });
    expect([401, 409]).toContain(second.status);
  }, 60000);

  it("lets the traveller withdraw a pending request", async () => {
    const h = await makeHarness();
    const { asha } = await withApprovalCast(h);
    const { res } = await requestOverCap(h, asha);
    const booking = res.body.booking as Booking;

    const w = await asha.post(`/api/bookings/${booking.id}/withdraw`).send({});
    expect(w.status).toBe(200);
    expect(w.body.booking.state).toBe("cancelled");
    expect(w.body.approval.state).toBe("withdrawn");
  }, 60000);
});
