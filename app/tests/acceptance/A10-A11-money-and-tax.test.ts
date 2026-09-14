/**
 * A10 — "An Indian-entity booking produces a GST-compliant invoice carrying the
 * entity's GSTIN within 48 hours of checkout. Non-GST markets itemise tax in lines
 * summing exactly to the all-in total."
 *
 * A11 — "Supplier, display and settlement currencies are all stored per booking
 * with FX rate and timestamp, and every displayed figure is re-derivable months
 * later."
 *
 * A9 (Slice 2) — the card is issued in the supplier currency, only at confirmation.
 */
import { makeHarness, book, dateRange } from "./harness.ts";
import { isValidGstin } from "../../src/core/gst.ts";
import { convert } from "../../src/core/fx.ts";
import type { Booking, Invoice } from "../../src/core/types.ts";

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

describe("A10 — tax documents", () => {
  it("issues a GST tax invoice only after checkout, reconciled to the rupee, with valid GSTINs", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search("Bandra Kurla Complex", 4);
    const offer = s.inPolicy[0];
    expect(offer).toBeDefined();
    if (!offer) return;

    const created = await book(h, s.searchId, offer);
    expect(created.status).toBe(201);
    const b = created.body.booking as Booking;

    const early = await h.agent.get(`/api/bookings/${b.id}/invoice`);
    expect(early.status).toBe(404);
    expect(early.body.error.code).toBe("invoice_not_ready");
    expect(early.body.error.detail.availableAfter).toBeTruthy();

    // Checkout was 2026-10-16. Step the clock to the morning after and run the tick.
    const { checkOut } = dateRange(4);
    const checkoutAt = new Date(`${checkOut}T06:30:00.000Z`);
    h.setNow(new Date(checkoutAt.getTime() + 20 * 3600_000));
    await h.tick();

    const ready = await h.agent.get(`/api/bookings/${b.id}/invoice`);
    expect(ready.status).toBe(200);
    const inv = ready.body.invoice as Invoice;

    expect(inv.kind).toBe("gst_tax_invoice");
    expect(inv.number.length).toBeLessThanOrEqual(16);
    expect(inv.recipient.gstin && isValidGstin(inv.recipient.gstin)).toBe(true);
    expect(inv.supplier.gstin && isValidGstin(inv.supplier.gstin)).toBe(true);
    expect(inv.placeOfSupply).toBe(offer.offer.property.stateCode);

    // Reconciles exactly to what the traveller was shown.
    expect(inv.grandTotal.minor).toBe(offer.offer.rate.allInTotal.minor);
    expect(sum(inv.lines.map((l) => l.total.minor))).toBe(inv.grandTotal.minor);
    const cgst = sum(inv.lines.map((l) => l.cgst?.minor ?? 0));
    const sgst = sum(inv.lines.map((l) => l.sgst?.minor ?? 0));
    expect(cgst + sgst).toBe(inv.taxTotal.minor);
    expect([0, 5, 18]).toContain(inv.lines[0]?.taxRatePercent);

    // Within 48 hours of checkout.
    const issuedAfter = new Date(inv.issuedAt).getTime() - checkoutAt.getTime();
    expect(issuedAfter).toBeLessThanOrEqual(48 * 3600_000);

    // The ITC sentence is a verdict with a reason, never blank.
    expect(inv.itc.reason.length).toBeGreaterThan(10);

    // Idempotent: a second tick issues nothing new.
    const again = await h.tick();
    expect(again.invoiced ?? 0).toBe(0);
  }, 90000);

  it("itemises non-GST tax in lines that sum exactly to the all-in total", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search("Canary Wharf", 3);
    const offer = s.inPolicy[0] ?? s.overCap[0];
    expect(offer, "London must return offers").toBeDefined();
    if (!offer || offer.verdict.state !== "in") return;

    const created = await book(h, s.searchId, offer);
    expect(created.status).toBe(201);
    const b = created.body.booking as Booking;
    const { checkOut } = dateRange(3);
    h.setNow(new Date(new Date(`${checkOut}T12:00:00.000Z`).getTime() + 24 * 3600_000));
    await h.tick();

    const res = await h.agent.get(`/api/bookings/${b.id}/invoice`);
    expect(res.status).toBe(200);
    const inv = res.body.invoice as Invoice;
    expect(inv.kind).toBe("tax_summary");
    expect(inv.itc.claimable).toBe(false);
    expect(sum(inv.lines.map((l) => l.total.minor))).toBe(offer.offer.rate.allInTotal.minor);
    expect(inv.grandTotal.currency).toBe("GBP");
  }, 90000);
});

describe("A11 / A9 — three currencies, re-derivable, card in supplier currency", () => {
  it("stores supplier, display and settlement amounts with the FX that produced them", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search("Canary Wharf", 3);
    const offer = s.inPolicy[0];
    expect(offer, "London needs at least one in-policy offer under the converted cap").toBeDefined();
    if (!offer) return;

    // Results already carry the display conversion.
    expect(offer.display.from.currency).toBe("GBP");
    expect(offer.display.to.currency).toBe("INR");
    expect(offer.display.fx?.rateMicros).toBeGreaterThan(0);

    const created = await book(h, s.searchId, offer);
    expect(created.status).toBe(201);
    const b = created.body.booking as Booking;

    expect(b.amounts.supplier.currency).toBe("GBP");
    expect(b.amounts.supplier.minor).toBe(offer.offer.rate.allInTotal.minor);
    expect(b.amounts.settlement.to.currency).toBe("INR");
    expect(b.amounts.settlement.fx).not.toBeNull();
    expect(b.amounts.settlement.fx?.asOf).toBeTruthy();

    // Re-derive every figure from what is stored, months later, with no live rate.
    h.setNow(new Date(Date.UTC(2027, 1, 1)));
    const later = (await h.agent.get(`/api/bookings/${b.id}`)).body.booking as Booking;
    const fx = later.amounts.settlement.fx;
    if (!fx) throw new Error("settlement fx missing");
    expect(convert(later.amounts.supplier, fx).to).toEqual(later.amounts.settlement.to);
    const dfx = later.amounts.display.fx;
    if (dfx) expect(convert(later.amounts.supplier, dfx).to).toEqual(later.amounts.display.to);

    // A9: the card authorises the currency the hotel charges in.
    expect(later.card?.authorisedTotal.currency).toBe("GBP");
    expect(later.card?.authorisedTotal.minor).toBe(later.amounts.supplier.minor);
  }, 90000);

  it("exports the three currencies in the admin CSV", async () => {
    const h = await makeHarness();
    await h.login();
    const s = await h.search("Canary Wharf", 3);
    const offer = s.inPolicy[0];
    if (!offer) return;
    await book(h, s.searchId, offer);
    const csv = await h.agent.get("/api/admin/bookings.csv");
    expect(csv.status).toBe(200);
    const header = csv.text.split("\n")[0] ?? "";
    for (const col of ["supplier_minor", "supplier_currency", "settlement_minor", "settlement_currency", "fx_rate_micros", "fx_pin_month"]) {
      expect(header).toContain(col);
    }
  }, 90000);
});
