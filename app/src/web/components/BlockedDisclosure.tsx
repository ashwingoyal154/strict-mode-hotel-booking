/**
 * `Show N blocked` — the one place results are hidden, and opening it states each
 * offer's reason. Blocked cards are not links: they cannot be booked through the
 * UI or by posting to /bookings, and the card should not pretend otherwise.
 */

import { useId, useState } from "react";
import type { RankedOffer } from "../../core/types.ts";
import { plural } from "../lib/fmt.ts";
import { OfferCard } from "./OfferCard.tsx";

export function BlockedDisclosure({
  offers,
}: {
  readonly offers: readonly RankedOffer[];
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const listId = useId();

  if (offers.length === 0) return null;

  return (
    <section className="blocked-disclosure">
      <button
        type="button"
        className="blocked-disclosure__toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? `Hide ${plural(offers.length, "blocked result")}` : `Show ${offers.length} blocked`}
      </button>
      <div className="blocked-disclosure__list" id={listId} hidden={!open}>
        {offers.map((r) => (
          <OfferCard key={r.offer.rate.id} ranked={r} />
        ))}
      </div>
    </section>
  );
}
