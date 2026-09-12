# Verdict — the design language

The product's job is not to give a traveller tools for choosing a hotel. It is to
**do the judging** — rank by commute, compute the all-in number, decide policy,
pick the payment rail — and then show its work convincingly enough to be trusted
in one tap.

That is what makes this language AI-native, and it is not a chat window. It is a
UI where the machine has already decided, and the interface's entire purpose is
**legible reasoning**. Eight rules follow from it.

---

### 1. The machine speaks in mono. The product speaks in serif.

The typographic split *is* the information architecture.

| Role | Face | Used for |
|---|---|---|
| **Machine** | JetBrains Mono | Anything the system derived: commute times, totals, overage arithmetic, cap values, source counts, state, timestamps, confirmation codes |
| **Product** | Source Serif 4 | Anything a human wrote: explanations, empty states, errors, guidance |
| **Structure** | Archivo | Property names, headings, numbers that are the point, buttons |

A reader can tell at a glance what was computed and what was authored. Never set a
computed value in serif, and never set interface prose in mono.

### 2. Every ranking and every verdict carries its reason, inline.

Not a tooltip, not an info icon, not a modal. `#1 · closest to your meeting` sits
next to the rank. `₹2,400 over your ₹8,000 Mumbai cap` sits where the price is.
If the system can't say why, it hasn't earned the decision.

### 3. Colour is reserved for verdicts.

Exactly three semantic colours — `in`, `over`, `blocked` — plus one accent (pine)
for interactive affordances. Everything else is greyscale. A decorative use of
colour anywhere in the app is a bug, because it steals the only signal the
traveller must not miss.

### 4. Streaming is a designed state, not a spinner.

Sources answer at different speeds and the page must never block on the slowest.
So the waiting state is a real composition: a **source meter** counting
`2 of 4 sources`, skeleton cards with the *exact* geometry of real cards, and new
results settling in over 260ms rather than popping. A failed source is shown as
failed and the list stays usable.

### 5. Pre-decided, shown, reversible.

Payment, cost centre, guests, rooms, the room type: the system decides and
displays what it decided as a compact machine-voice line with an edit affordance.
Never an empty form field for something already known. The confirm screen has one
primary action and no required input.

### 6. Show the arithmetic, never the adjective.

"Out of policy" is a label. `₹8,700/night vs ₹8,000 cap · ₹2,800 over for 4 nights`
is a reason. Always the second. Totals are always all-in — a number that changes
between screens is the product's worst possible failure, so the total is typeset
as the single largest element on Confirm and carries its own component breakdown.

### 7. Near-square, hairline, flat.

2px radius — deliberately not the `rounded-lg` default. 1px hairline rules do the
separating. Exactly one elevation step, spent on the Confirm total card and
nothing else. No gradients, no glass, no decorative imagery. One small property
thumbnail is permitted; a carousel is not.

### 8. Both themes, from tokens only.

Every colour is a token defined in bare `:root`. Dark is a token redefinition, not
a second stylesheet. No component may reference a literal colour.

---

## Tokens

`src/web/design/tokens.css` is the only place colours, type sizes, spacing, radius
and motion are defined. Components consume `var(--…)` exclusively.

## Component specs

**`AnchorInput`** — one field, full width, 20px type, placeholder is a real example
(`Bandra Kurla Complex, Mumbai`). Dates sit beneath as two compact machine-voice
controls. Guests/rooms are a `DecidedLine`, not inputs. Last three anchors appear
as square chips below.

**`SourceMeter`** — a row of hairline segments, one per source, filling as each
answers, with `n of m sources · 840ms` in mono. Stays visible after settling as a
receipt of what was searched. Failed sources render with the `blocked` colour and
a `failed` label.

**`OfferCard`** — **the approved field list, and nothing else.** A build-failing
test (`tests/acceptance/A25-card-fields.test.ts`) asserts this:
1. commute badge (mono, accent) — `7 min walk`
2. rank + rank reason (mono, muted) — `#1 · closest to your meeting`
3. property name (Archivo 18px)
4. address line (serif, muted)
5. all-in total (Archivo 26px, tabular) + `all-in, 4 nights · ₹8,700/night` (mono)
6. verdict chip
7. `Work-ready` chip, only when true
8. free-cancellation chip, only when refundable
9. one optional 48px-square thumbnail

No star rating, no review score, no "popular", no urgency, no promotional badge,
no carousel, no price-was-crossed-out, no supplier logo.

**`VerdictChip`** — square, 1px border in its own semantic colour, mono uppercase
10.5px. Three variants only. Blocked cards are collapsed behind a
`Show N blocked` disclosure that states each reason.

**`TotalBlock`** — Confirm only. The largest type on the page, tabular figures,
with the component breakdown (base / taxes / fees) as mono rows beneath and the
literal sentence *"This is the whole number. Nothing is added at the hotel."*

**`DecidedLine`** — `label · value · Edit`. Label in mono-micro uppercase muted,
value in mono, Edit as a quiet accent text button.

**`CancelWindow`** — mono countdown to the free-cancellation deadline, with the
deadline in the traveller's local time spelled out, and a destructive-but-quiet
Cancel button that is never red until hover.

## Accessibility, non-negotiable

390px minimum width with a 16px gutter. Every interactive element keyboard
reachable with a visible 2px accent focus ring. Verdict is never conveyed by
colour alone — the chip always carries its word. Body contrast ≥ 4.5:1 in both
themes. `prefers-reduced-motion` removes the settle transition. The source meter
is `aria-live="polite"`; results announce their count, not each card.
