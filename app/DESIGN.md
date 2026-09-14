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

---

# Slice 2 additions

Slice 2 adds the states where the machine cannot simply decide: a rate over
cap, an approval racing a moving price, a trip abroad in another currency, and
a tax document. The eight rules above still hold. What follows is how they apply
to the new surfaces.

### The third verdict is real now

`Over cap` is no longer a variant of blocked. It sits in the ranked list, is
numbered, and carries the amber `over` token plus its arithmetic. Only `Blocked`
stays behind the disclosure. Tapping an over-cap card leads to a request, not a
booking, and every surface says so in words. Colour is never the only signal.

### Time is a first-class value

An approval is a race against a moving rate, so its clock is shown the same way
everywhere, in machine voice:

- **SLA line** — `Meera Iyer · decides by 4:10 pm · 1h 42m left`, with a single
  hairline beneath it that empties as time passes. It turns `over` in the last 25%
  and `blocked` once breached. It never animates faster than once a minute.
- **Escalation ladder** — a vertical list of the approver chain: past levels
  struck through in muted mono with the time they were passed over, the current
  level at full ink, future levels faint. It is the audit trail made visible.

### Never claim a hold that does not exist

The hold line sits directly under the total on a pending request, and it takes
exactly one of two forms:

- `Held until 6:00 pm · the price above is guaranteed until then`
- `Not held · this hotel can't hold rates, so the price may move before approval`

The second is in the `over` tone. An approval that wins after the rate moved gets
its own designed outcome: `Approved — but the rate moved from ₹42,380 to ₹44,100.
Nothing was booked.` It comes with a way back to results, never an error screen.

### Two currencies, one honest number

Abroad, the supplier currency is the number the hotel charges, so it leads:
`£1,648` at full total size. The reporting-currency equivalent sits beside it in
muted machine voice with an approximation mark that is also spelled out for
screen readers: `≈ ₹1,75,100 · Sep pinned rate`. A converted figure is never
typeset as large as a real one. The pinned month is always named, because a rate
with no date is a guess.

### Chat entry is a field, not a conversation

One line on Search: `Or ask in a sentence`. No bubbles and no transcript. After
submission the product answers with a machine-voice read-back of what it
understood (`Understood · BKC, Mumbai · Tue 15 – Fri 18 Sep · 1 guest · in
policy`), then one `Search` button. When something is missing it asks exactly one
question, offered as square chips, and the traveller answers with a tap. Chat
never shows a price and never has a button that books.

### The invoice is the one document

The GST invoice is the only screen that should look like paper. It is a single
ruled column at `--measure` width, set in tabular machine voice. The number, GSTINs
and place of supply sit at the top, then a line table (description · SAC ·
taxable · rate · CGST · SGST · total), then the totals. Beneath the totals is one
sentence on input tax credit, stated as a verdict with its reason:
`ITC not claimable — the 5% slab carries no input tax credit.`
It prints cleanly: `@media print` hides the app shell.

### Approver surfaces are decisions, not dashboards

The approvals inbox shows one card per request with the overage arithmetic, the
traveller's justification quoted in serif (a human wrote it), the SLA line, and
two actions. `Approve` is the primary. `Reject` is quiet, and choosing it reveals a
required note field before it can submit. The one-tap page reached from a
notification is the same card and nothing else.

### Admin gains four quiet tables

Exceptions, travellers in market tonight, the directory, and FX pins. They share
one table style: hairline rows, mono figures right-aligned, and a state chip in the
first column. Duty of care leads with the count by country. A `high` advisory row
takes the `blocked` stripe.

### Demo personas

When the demo flag is on, sign-in offers three square persona chips (traveller,
manager, admin) under the email field, each with a one-line machine-voice role.
The demo bar stays.

### Tokens

`tokens.css` is unchanged and remains read-only. If a Slice 2 surface genuinely
needs a new token, it goes in `src/web/design/tokens-slice2.css`, imported after
`tokens.css`, defined for light, `prefers-color-scheme: dark` and `data-theme="dark"`
exactly as the base file does.
