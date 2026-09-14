/**
 * An in-process HTTP mock of the Rapid shapes `ExpediaRapidRateSource` implements.
 * It is a contract fixture, not a claim about live Expedia behaviour: it lets gate
 * S1 prove the port holds end to end without ever calling a live endpoint.
 *
 * Prices come from the fixture pricing engine, so policy verdicts behave the same
 * as they do on fixture supply. It verifies the SHA-512 signature on every request
 * and records every booking body, so a test can assert no card data was ever sent.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { FIXTURE_PROPERTIES } from "../../src/supply/fixtures/properties.ts";
import { ratesFor } from "../../src/supply/fixtures/rates.ts";
import { resolveAnchor } from "../../src/supply/fixtures/anchors.ts";
import type { SearchQuery } from "../../src/core/types.ts";

export const MOCK_API_KEY = "mock-api-key";
export const MOCK_SHARED_SECRET = "mock-shared-secret";

export interface RapidMock {
  readonly baseUrl: string;
  readonly bookings: unknown[];
  readonly cancels: string[];
  readonly authFailures: number;
  close(): Promise<void>;
}

function minorToDecimal(minor: number): string {
  const whole = Math.floor(minor / 100);
  const frac = String(minor % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

function authorised(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const m = /^EAN APIKey=([^,]+),Signature=([0-9a-f]{128}),timestamp=(\d+)$/.exec(header);
  if (m === null || m[1] !== MOCK_API_KEY) return false;
  const expected = createHash("sha512").update(`${MOCK_API_KEY}${MOCK_SHARED_SECRET}${m[3]}`).digest("hex");
  return expected === m[2];
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function pricingFor(minorInclusive: number, minorExclusive: number, currency: string, guests: number) {
  return {
    [String(guests)]: {
      totals: {
        inclusive: { request_currency: { value: minorToDecimal(minorInclusive), currency } },
        exclusive: { request_currency: { value: minorToDecimal(minorExclusive), currency } },
      },
    },
  };
}

interface Token {
  readonly pid: string;
  readonly ci: string;
  readonly co: string;
  readonly g: number;
  readonly r: number;
}

function tok(t: Token): string {
  return Buffer.from(JSON.stringify(t)).toString("base64url");
}

function untok(s: string | null): Token | null {
  if (s === null) return null;
  try {
    return JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Token;
  } catch {
    return null;
  }
}

function rateFor(t: Token) {
  const property = FIXTURE_PROPERTIES.find((p) => p.id === t.pid);
  if (property === undefined) return null;
  const anchor = resolveAnchor("Bandra Kurla Complex");
  if (anchor === null) return null;
  const query: SearchQuery = { anchor, checkIn: t.ci, checkOut: t.co, guests: t.g, rooms: 1 };
  const rate = ratesFor(property, query, "rapid-mock")[t.r];
  return rate === undefined ? null : { property, rate };
}

export async function startRapidMock(): Promise<RapidMock> {
  const bookings: unknown[] = [];
  const cancels: string[] = [];
  let authFailures = 0;

  const server = createServer((req, res) => {
    if (!authorised(req)) {
      authFailures++;
      json(res, 401, { type: "request_unauthenticated" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://mock");

    if (req.method === "GET" && url.pathname === "/v3/properties/availability") {
      const ci = url.searchParams.get("checkin") ?? "";
      const co = url.searchParams.get("checkout") ?? "";
      const g = Number(url.searchParams.get("occupancy") ?? "1");
      const out = url.searchParams.getAll("property_id").flatMap((pid) => {
        const property = FIXTURE_PROPERTIES.find((p) => p.id === pid);
        if (property === undefined || property.countryCode !== "IN") return [];
        const anchor = resolveAnchor("Bandra Kurla Complex");
        if (anchor === null) return [];
        const rates = ratesFor(property, { anchor, checkIn: ci, checkOut: co, guests: g, rooms: 1 }, "rapid-mock");
        return [
          {
            property_id: pid,
            status: "available",
            rooms: rates.map((rate, r) => ({
              id: `room-${r}`,
              room_name: r === 0 ? "Standard Room" : "Deluxe Room",
              rates: [
                {
                  id: `rate-${r}`,
                  status: "available",
                  refundable: rate.refundableUntil !== null,
                  cancel_penalties: rate.refundableUntil === null ? [] : [{ start: rate.refundableUntil }],
                  occupancy_pricing: pricingFor(rate.allInTotal.minor, rate.components[0]?.amount.minor ?? 0, rate.currency, g),
                  links: {
                    price_check: {
                      method: "GET",
                      href: `/v3/properties/${pid}/rooms/room-${r}/rates/rate-${r}?token=${tok({ pid, ci, co, g, r })}`,
                    },
                  },
                },
              ],
            })),
          },
        ];
      });
      json(res, 200, out);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/v3/properties/")) {
      const t = untok(url.searchParams.get("token"));
      const found = t === null ? null : rateFor(t);
      if (t === null || found === null) {
        json(res, 404, { type: "not_found" });
        return;
      }
      json(res, 200, {
        status: "available",
        occupancy_pricing: pricingFor(found.rate.allInTotal.minor, found.rate.components[0]?.amount.minor ?? 0, found.rate.currency, t.g),
        links: { book: { method: "POST", href: `/v3/itineraries?token=${tok(t)}` } },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v3/itineraries") {
      let raw = "";
      req.on("data", (chunk) => (raw += String(chunk)));
      req.on("end", () => {
        bookings.push(JSON.parse(raw || "{}"));
        // Short, letter-led id: never a digit run the A13 card-number scan could mistake for a PAN.
        const itinerary = `IT${randomBytes(4).toString("hex").toUpperCase()}`;
        json(res, 201, {
          itinerary_id: itinerary,
          links: { cancel: { method: "DELETE", href: `/v3/itineraries/${itinerary}?token=${url.searchParams.get("token") ?? ""}` } },
        });
      });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/v3/itineraries/")) {
      cancels.push(url.pathname);
      res.writeHead(204);
      res.end();
      return;
    }

    json(res, 404, { type: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock did not bind");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    bookings,
    cancels,
    get authFailures() {
      return authFailures;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
