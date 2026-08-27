# A2A Marketplace — UI/UX audit

**Site audited:** `https://baseapp.kult.games` (live, 2026-08-27)
**Codebase:** `kult-games-updated/kult-games-v3/app` — `kult-a2a-marketplace`
**Method:** every route walked in Chrome at 1400px, source cross-referenced for each finding.

Almost everything here is a copy or layout change. Two are data bugs. One is a
regression I introduced, already fixed and noted as such.

Findings are numbered `UX-nn` so they can be referenced in commits and tickets.

---

## How to read this

| Severity | Meaning |
|---|---|
| **P0** | Says something false, or contradicts itself on screen. Fix before recording. |
| **P1** | Clearly wrong to a first-time viewer. Cheap. Fix before recording if time allows. |
| **P2** | Polish. Fix after. |

Routes covered: `/` · `/jobs` · `/jobs/:id` · `/jobs/new` · `/my-jobs` · `/agents` · `/reputation`

---

## Part 1 — Cross-cutting problems

These repeat on most pages. Fixing them once fixes many screens at once, so do
these first.

### UX-01 · The vocabulary changes on every screen — **P0**

The same object is called five different things depending where you stand.

| Where | What it calls the thing |
|---|---|
| Sidebar | "Create a job", "Orders" |
| `/jobs` title | "Shop agent listings" |
| `/jobs/new` title | "Create a listing" |
| `/jobs/new` eyebrow | "Sell on KULT//A2A" |
| Home stat cards | "FOR SALE", "ORDERS IN WORK", "SOLD" |
| Scope selector | "Open listings", "In progress", "Sold" |
| Card body | "Seller …" |

A viewer cannot tell whether a *job*, a *listing* and an *order* are three things
or one. They are one.

**Worse — the labels are contradictory.** `MarketplacePages.tsx:486` sets the create page eyebrow to
**"Sell on KULT//A2A"**, and twenty lines later `:506` asks you to
**"Choose the buyer agent"**. Creating a job means you are *hiring*. The page
tells you that you are selling while asking which of your agents is buying.

Same on `/agents`: eyebrow **"Seller profile"** (`:1111`) on a page whose own body
copy covers both buying and selling.

**Fix — adopt one vocabulary and apply it everywhere:**

| Concept | Word | Never |
|---|---|---|
| The unit of work | **job** | listing, mandate, task |
| Who pays | **buyer** | client, hirer |
| Who does the work | **trainer** | seller, provider, agent (ambiguous) |
| A job you're involved in | **order** | — |
| Where jobs are browsed | **marketplace** | shop, aisles, board |

Concretely:
- `/jobs` title → **"Open jobs"**, description → "Browse work that buyers are hiring for."
- `/jobs/new` eyebrow → **"Hire an agent"**, title → **"Post a job"**
- `/agents` eyebrow → **"Your agents"**
- Home stat cards → **"Open jobs" / "In progress" / "Completed"**
- Card footer `Seller …` → **`Buyer …`** — the person named is the one who *posted*
  the job, so the current label names the wrong side of the trade entirely.

The e-commerce metaphor ("Shop the aisles", "shopfront", "cart to settlement")
is fighting the product. Nobody browses aisles to hire a contractor. Drop it.

---

### UX-02 · The marketplace scope selector is styled as a filter — **P0**

This is the one you flagged, and the code confirms it exactly.

The scope selector — the control that decides **what the page is showing** — is
rendered as pills wedged into the right-hand end of the search bar, then the
category *filter* is rendered directly beneath it as a second row of pills.

Both use effectively the same class string (`:401-410` and `:422-424`):

```
scope:    shrink-0 rounded-md border px-3.5 py-2   font-mono text-[10px] transition
category: shrink-0 rounded-md border px-3   py-1.5 font-mono text-[10px] transition
active (both): border-[#8b5cf6]/50 bg-[#8b5cf6]/10 text-[#8b5cf6]
```

Same radius, same font, same size, same active colour. Two pixels of padding
separate a **navigation control** from a **refinement control**. Of course it
reads as a filter — it is drawn as one.

The variable is even called `SCOPE_TABS` (`:66`). The intent was tabs. The
implementation is chips.

**You already have the right component, used twice.** The Orders page
(`:998-1010`) and the job workspace (`:631-643`) both use a proper underline tab:

```tsx
<div className="agentic-scroll-x mb-4 border-b border-white/9">
  {tabs.map((tab) => (
    <button
      className={cn(
        "shrink-0 px-3 py-3 font-tech text-[10px] font-bold uppercase tracking-[.14em] transition sm:px-4",
        view === tab.key ? "border-b-2 border-[#8b5cf6] text-[#8b5cf6]" : "text-white/30 hover:text-white/60",
      )}
    >
      {tab.label}
      {tab.count > 0 ? <span className="ml-1.5 opacity-50">{tab.count}</span> : null}
    </button>
  ))}
</div>
```

**Fix:** extract that into a shared `<ScopeTabs>` and use it on `/jobs`.

Layout after the change:

```
Open jobs                                    [ + Post a job ]
Browse work that buyers are hiring for.

┌─────────────────────────────────────────────────────────┐
│  OPEN 22   IN PROGRESS 17   COMPLETED 27                │  ← tabs, underlined
└─────────────────────────────────────────────────────────┘
[ Search jobs…                    ]   [ Newest ▾ ]   [ ⟳ ]

22 jobs   All  Warzone  RoboWar  Highway Hustle  F1  …      ← filter chips
```

Tabs sit **above** the search box, full width, with a bottom border spanning the
container. Search and sort go on their own row. Category chips stay as chips —
they are genuinely filters, and now they are the only chips on screen, so the
shape means one thing again.

**Accessibility:** these are bare `<button>`s with no `role`, no `aria-selected`
and no tablist. Screen readers announce three unlabelled buttons. Add
`role="tablist"` / `role="tab"` / `aria-selected` while you are in there.

---

### UX-03 · Card titles are machine strings — **P1**

`:137`:

```ts
return `${job.gameId} · ${job.target.metric} ${op(job.target.op)} ${job.target.value}`;
```

Which renders as:

> **robowar · combatSkill ≥ 56**
> **premier-league · predictionAccuracy ≥ 70**

That is a database row, not a headline. `gameId` is a slug and `targetMetric` is
an API field name, and both are printed raw. Meanwhile the *actual* human
sentence the buyer wrote — "My RoboWar build is passive. Push aggression and get
combat skill to 56+." — is demoted to grey body text and truncated.

There is **no display-name map anywhere in the app** (`grep GAME_LABEL` → nothing).

**Fix.** Add one lookup and invert the hierarchy:

```ts
export const GAME_LABEL: Record<string, string> = {
  warzone: "Warzone Warrior",
  robowar: "RoboWar",
  "highway-hustle": "Highway Hustle",
  "formula-1": "Formula 1",
  "premier-league": "Premier League",
  nba: "NBA",
};

export const METRIC_LABEL: Record<string, string> = {
  combatSkill: "combat skill",
  predictionAccuracy: "prediction accuracy",
  calibration: "calibration",
  aggression: "aggression",
};
```

Card becomes:

```
┌──────────────────────────────────────────┐
│ [icon]  RoboWar          · POSTED        │   ← category + status, small
│                                          │
│ My RoboWar build is passive. Push        │   ← the buyer's own words, as title
│ aggression and get combat skill to 56+.  │
│                                          │
│ Target  combat skill ≥ 56                │   ← the spec, as a labelled row
│ ──────────────────────────────────────── │
│ 0.20 – 0.55 USDC        Listed 1d ago    │
│ Buyer 0xf3da…4598                        │
└──────────────────────────────────────────┘
```

The prompt is the most human thing on the card and it is currently the least
prominent. Swap them.

---

### UX-04 · Prices are formatted inconsistently — **P1**

On one screen, side by side:

```
0.25–0.5     0.20–0.55     0.25–0.45     0.25–0.50     0.30–0.55
```

`0.5` and `0.50` in the same grid. `:1077` interpolates
`job.budget.min` / `.max` as raw strings straight from the API, and the API
trims trailing zeros.

For a product about money this reads careless.

**Fix.** One formatter, used for every USDC value in the app:

```ts
export const usdc = (v: string | number) => Number(v).toFixed(2);
```

Then `{usdc(job.budget.min)} – {usdc(job.budget.max)} USDC`. Apply at
`:655`, `:820`, `:1077` and the Orders volume tile.

---

### UX-05 · Zero-padded counts read as a scoreboard — **P2**

Orders shows `00`, `00`, `02` (`:992-994` use `.padStart(2, "0")`).
`00` looks like a broken value, and at ten or more items the padding does
nothing anyway. Drop it — `0` and `2`.

---

### UX-06 · Two search boxes on screen at once — **P1**

The top bar has "Search the marketplace…" permanently. `/jobs` adds "Search
listings…", and the home hero adds a third, "Search listings, games, or skills…".

On `/jobs` two search inputs are visible simultaneously with no indication they
differ. They don't — the top one goes to the same place.

**Fix:** keep the global one in the top bar. Remove the in-page one on `/jobs`,
or remove the global one on pages that have their own. One search per screen.

---

## Part 2 — Page by page

### `/` — Home

**UX-07 · The six-icon strip says nothing — P2.**
`ACTIVE SERVICES · USDC PAYMENTS · MARKETPLACE ECONOMY · VERIFIED DELIVERY ·
GROWTH ANALYTICS · REPUTATION NETWORK` — six glossy icons, no numbers, no links,
no explanation. It occupies a full row above the fold-and-a-half and is pure
texture. Either attach real figures (jobs settled, USDC volume, agents
registered) or delete it. Right now it pushes the real content down.

**UX-08 · Stat tiles aren't clickable — P1.**
`FOR SALE 22 / ORDERS IN WORK 17 / SOLD 27` are the single most useful thing on
the page and they are inert. Each should link to `/jobs` with that tab
preselected. Also rename per UX-01 — "ORDERS IN WORK" appears nowhere else in
the app.

**UX-09 · The hero has a near-invisible carousel arrow — P2.**
There is a `‹` control sitting on the artwork at roughly `1177,197`, dark grey on
a dark image. If the hero is a carousel, the affordance needs to be visible and
paired with a `›`; if it isn't, remove the arrow.

**UX-10 · "Hire an agent" is a button that sits inside a sentence — P2.**
It renders as a bordered pill directly beside the plain text "buyer protection ·
escrowed USDC · refunds if the target is missed", so the pill reads as the first
item in that list rather than as the secondary CTA it is. Give the two CTAs
equal footing on their own line and move the microcopy below them.

**UX-11 · Bottom CTAs duplicate the nav — P2.**
"Create a job" and "Shop open listings" at page bottom repeat the sidebar, the
top bar and the hero. The page ends with the fourth and fifth copy of the same
two actions.

---

### `/jobs` — Marketplace

Covered by **UX-02** (tabs), **UX-03** (titles), **UX-04** (prices), **UX-06**
(search). Additionally:

**UX-12 · Category chips print raw slugs — P1.**
`formula-1`, `highway-hustle`, `premier-league` in a lowercase monospace row.
Same `GAME_LABEL` fix as UX-03.

**UX-13 · The refresh button is unlabelled and unexplained — P2.**
A bare `⟳` icon at the end of the filter row. The list already polls every 15s.
Either remove it or give it a tooltip and a spin-on-click state, otherwise
clicking it appears to do nothing.

**UX-14 · Only one card is FEATURED and nothing says why — P2.**
The first card carries a `FEATURED` badge. It is just the first item in the
sort. Either make it mean something or drop the badge.

**UX-15 · Seller identifiers are formatted two different ways — P1.**
Real jobs show `Seller d033c5…6534` (an internal UUID); demo jobs show
`Seller 0xf3da…4598` (a wallet address). Two different identifier types under
the same label. Show the ERC-8004 agent id (`#63891`) or the agent's name for
both — a UUID means nothing to a viewer and a raw wallet means little more.

---

### `/jobs/:id` — Job workspace

**UX-16 · The status is printed three times — P1.**
`POSTED` appears as a pill beside the title, again on the lifecycle card, and
again in the sticky footer bar. On the settled job, `SETTLED` likewise appears
three times. Keep the one on the lifecycle rail — that is where status has
context — and drop the other two.

**UX-17 · The back link is labelled with the current page's name — P1.**
`:579` renders `← Active Job Workspace`. It is a back link
to the marketplace, but it is captioned with where you already are, and it sits
exactly where a page eyebrow goes. Label it **`← Marketplace`**.

It is also wrong on its own terms: a POSTED job with no trainer is not an
"active job workspace".

**UX-18 · "Open Job Details" on the job details page — P1.**
A prominent top-right button with an external-link icon, on the page that *is*
the job details. Whatever it opens, the label describes the current page. If it
opens the raw requirements JSON, call it **"View requirements JSON"**.

**UX-19 · Progress bar shows 17% on a job that hasn't started — P0.**
`:864`:

```ts
const progress = Math.min(100, Math.round((stage / 6) * 100));
```

A POSTED job has `stage = 1`, so the bar renders **17% filled** with all four
sub-stages marked `QUEUED`. It states that a sixth of the work is done before a
trainer has even been matched. On a board of 22 open jobs every single one
claims to be underway.

**Fix:** `stage` should be *completed* stages, not the current one — a POSTED job
is 0%. Render the bar only from ESCROWED onward; before that show "Not started".

**UX-20 · The stage counter disagrees with the rail above it — P0.**
`:888` prints `Stage {stage} / 6`, directly below a lifecycle
rail with **seven** stages (POST · DISCOVER · NEGOTIATE · ESCROW · TRAIN ·
DELIVER · SETTLE). Two counts of the same process, on the same screen, one of
them wrong. Derive both from one constant.

**UX-21 · The settled job says its agreement is pending — P0 · fixed.**
On `0x5759dd…` — SETTLED, paid, seven green stages with real transaction links —
the Agreement panel read **"Waiting for a provider agent to negotiate and
sign"**, status **Pending**, and the Negotiation tab showed **"No negotiation
threads"**.

That was **my regression**, introduced with the demo fixture:
`demoListNegotiations` returned `[]` for any job id it didn't recognise, so every
real job lost its transcript. Returning `[]` claims "this job has no
negotiations"; the honest answer was "the fixture has nothing to say about this
job".

Fixed — the fixture now returns `null` for unknown ids and the client falls
through to the API. Verify after deploy that the settled job shows its
transcript and `Both signed ✓`.

**UX-22 · DISCOVER reads "0 negotiations" on a settled job — P1.**
Same root cause as UX-21 for real jobs. But also worth a guard: once a job is
past NEGOTIATE, a zero count is impossible, so it should render the agreed price
and trainer instead of a count.

**UX-23 · The Agreement table wraps badly — P1.**
Labels and values are laid out so that `combatSkill ≥ 56` breaks across two
lines mid-value, and `AGREEMENT STATUS` wraps to two lines while its value
`Pending` sits alone on the first. Four label/value pairs crammed into one row.
Use a two-column definition list that wraps to one column under ~900px.

**UX-24 · Empty states are drawn as if populated — P2.**
On a POSTED job, "Agent capability transfer" renders the full buyer → trainer
diagram with the trainer side reading **"Unmatched —"**, and "Training progress"
renders four rows all `QUEUED`. Both are empty states dressed as data. Collapse
each to a single line — "No trainer matched yet" — until there is something to
show.

**UX-25 · The sticky footer duplicates the header — P2.**
`LIVE · robowar · Job 0xf10ac…f7782 · Target combatSkill ≥ 56 · 0.20–0.55 ·
POSTED · [Details →]` — every field is already visible above, and `Details →`
points at the page you are on. Either make it a real action bar (Fund escrow /
Propose / View on Base, whichever applies) or remove it.

**UX-26 · Disabled tabs don't look disabled — P2.**
`EXECUTION` and `PROOF` are dimmed but still read as clickable. Either allow
them and show an empty state, or mark them clearly unavailable.

---

### `/jobs/new` — Post a job

**UX-27 · The page says you are selling while you are buying — P0.**
Covered in UX-01. This is the single most confusing string in the app.

**UX-28 · Two numbering systems in one form — P1.**
The stepper across the top reads `STEP 1 · STEP 2 · STEP 3`; the panels below
read `01 · Choose the buyer agent`, `02 · Describe the outcome`, `03 · Set
negotiation range`. A viewer reasonably asks whether `01` belongs to `STEP 1` or
is a separate sequence. All three `01/02/03` panels are inside `STEP 1`.

**Fix:** drop the numbers from the panels. The stepper is the sequence.

**UX-29 · "Take jobs automatically" is on the wrong page — P1.**
A persistent agent setting is rendered in the right rail of the *create a job*
form, where it has nothing to do with the task and reads as a property of the
job being created. It already lives correctly on `/agents`. Remove it here.

**UX-30 · The primary button is disabled with no reason given — P1.**
"Preview listing" renders dimmed until the form validates, with nothing
indicating what is missing. Either enable it and validate on click with inline
errors, or add helper text: "Describe the outcome to continue."

**UX-31 · "Set negotiation range" is jargon — P2.**
Call it **"Set your budget"**, with helper text "Trainers propose within this
range. You approve the final price before any USDC moves."

---

### `/my-jobs` — Orders

**UX-32 · Lands on an empty tab — P1.**
Default view is `BUYING`, which shows **0 orders** and a "No orders in this
view" empty state, while `COMPLETED 2` sits right beside it with content. First
impression of the page is that it is broken.

**Fix:** default to the first tab with a non-zero count, or add an "All" tab and
default to it.

**UX-33 · Stat tiles and tabs are the same four categories — P2.**
`ACTIVE ORDERS / TO REVIEW / COMPLETED / VOLUME` above `BUYING / SELLING / TO
REVIEW / COMPLETED`. "TO REVIEW" and "COMPLETED" appear twice, three rows apart,
with different counts formatting. Keep the tabs; reduce the tiles to the one
number the tabs don't carry — VOLUME.

**Note — the tabs on this page are correct.** This is the pattern `/jobs` should
adopt (UX-02).

---

### `/agents` — My Agent

**UX-34 · Capability numbers don't match the verified data — P0.**
The page shows `COMBAT 99/100 · STRATEGY 75/100 · ANALYSIS 100/100`. The
independently verified measurement for this agent is **combat skill 74–77** —
that is the number the escrow settled on, twice, on chain.

Showing 99 and 100 next to a Reputation page built on "independently verified,
not self-reported" undercuts the entire pitch, and someone will ask.

Source these bars from the same capability API the verifier uses, and label them
with the measurement date. If they are a different metric, rename them so they
cannot be read as the verified capability.

**UX-35 · Per-agent cards repeat every control — P2.**
Each agent renders a full-width card with its own `Create a Job` and `View
Reputation` buttons. With several agents the page becomes a long column of
identical rows. Collapse to a compact list, expand on click.

---

### `/reputation` — Reputation

**UX-36 · A large empty gauge dominates the page — P1.**
"Economic reputation score" renders a big donut reading **"— NO SCORE YET / Out
of 1000"**, with `Outcome Reliability —`, `Client Diversity 0/10`, `Total
Feedback 0/20` beneath it. The most visually prominent element on the page is a
zero.

Until there is a score, replace the gauge with what the agent *has* got: two
verified outcomes, one pass, one refund, 0.25 USDC earned. Show the gauge once
there is something in it.

**UX-37 · Completed-jobs count contradicts the list beside it — P0.**
Header reads `COMPLETED JOBS 1`. The "Verified outcomes" panel immediately to
the left lists **two** — a PASS at `combatSkill ≥ 60` and a FAIL at
`combatSkill ≥ 75`. And `SUCCESS RATE 50%` is itself computed from two.

One of the two numbers is wrong. Given the rate, the count is.

**UX-38 · "Hire this agent" on your own agent — P1.**
The featured card offers `Hire this agent →` while the page is scoped to the
agent *you own* via the selector top-right. Hide or disable it for your own
agents.

**UX-39 · Feedback reads 0 because publishing is broken — P0 · backend.**
`FEEDBACK 0` and `Total Feedback 0/20` are accurate but only because no ERC-8004
feedback has ever been published. `publishJobFeedback` throws on every attempt.

`e38c3c2` in this repo makes the failure visible in the job's `lastError`, but
**base-chain-service has not been redeployed**, so the reason is still only in
logs. This is the one finding that is not a frontend change.

Until it is fixed, the Reputation page cannot show anything, and it is the page
that carries the ERC-8004 story.

**UX-40 · The agent selector is an unstyled native select — P2.**
Top-right dropdown is a bare `<select>` against a fully custom dark UI. It
renders with OS chrome and light-mode text on some platforms.

---

## Part 3 — Order of work

Grouped so each block is one sitting.

### Block 1 — before recording (P0, ~half a day)

1. **UX-02** scope tabs on `/jobs` — the change you asked for, and the most visible
2. **UX-19 / UX-20** progress bar at 17%, and `Stage n / 6` vs seven stages
3. **UX-01 / UX-27** one vocabulary; fix "Sell on KULT//A2A" first
4. **UX-37** reputation count contradiction
5. **UX-34** capability bars vs verified numbers
6. **UX-21** verify my negotiation fix after deploy
7. **UX-39** redeploy base-chain-service to surface the feedback error

### Block 2 — cheap and high-visibility (P1, ~half a day)

**UX-03** card titles · **UX-04** price formatting · **UX-12** category labels ·
**UX-06** duplicate search · **UX-08** clickable stat tiles · **UX-16** triple
status · **UX-17** back link · **UX-18** "Open Job Details" · **UX-23** agreement
table wrap · **UX-28** double numbering · **UX-29** misplaced toggle ·
**UX-30** silent disabled button · **UX-32** empty default tab · **UX-36** empty
gauge · **UX-38** hire-yourself

### Block 3 — polish (P2)

Everything else.

---

## Part 4 — Two components worth extracting

Most of Part 1 collapses into these.

**`<ScopeTabs>`** — the underline tab from `:998`, lifted out and used on
`/jobs`, `/my-jobs` and the job workspace. Three call sites currently
copy-paste it; one already diverged into chips, which is UX-02.

**`<JobCard>`** — one card, one hierarchy, one price formatter, one label map.
The marketplace grid, the home "featured" strip and the workspace footer
currently each render job summaries with different field order and different
formatting.

---

## Part 5 — What is already good

Worth keeping as-is, and worth pointing the camera at:

- **The lifecycle rail on a settled job.** Seven stages, green, each with its own
  BaseScan link. This is the strongest screen in the product.
- **The settlement receipt.** "SETTLED — TRAINER PAID · 0.25 USDC", target
  against independently measured value, with the note about fresh seed roots.
- **"Outcome protection"** — Escrow funded / Independent verifier / Refund on
  failure, with live status chips. Concrete and legible.
- **The Orders tabs.** The pattern the rest of the app should follow.
- **Base identity panel** on `/jobs/new` — agent id, signing key, registration
  tx, agent card, and "Discoverable by any ERC-8004 client, not just KULT."
  That last line is the whole pitch in nine words.

---

## Appendix — file references

All line numbers in
`kult-games-updated/kult-games-v3/app/src/pages/MarketplacePages.tsx`
(1597 lines) unless stated.

| Finding | Location |
|---|---|
| UX-01 | `:486` eyebrow, `:506` buyer agent, `:1111` seller profile |
| UX-02 | `:66` `SCOPE_TABS`, `:401-410` scope chips, `:422-424` category chips |
| UX-02 fix | `:631-643` and `:998-1010` — existing tab pattern |
| UX-03 | `:137` title template |
| UX-04 | `:655`, `:820`, `:1077` price interpolation |
| UX-05 | `:992-994` `padStart` |
| UX-17 | `:579` back link label |
| UX-19 | `:864` progress calculation |
| UX-20 | `:888` `Stage {stage} / 6` |
| UX-21 | `app/src/api/a2aDemoFixture.ts` `demoListNegotiations` — fixed |
| UX-34 | capability bars — cross-check against `/v1/agents/:id/capabilities` |
| UX-39 | `services/base-chain-service/src/feedback-loop.ts` — needs deploy |
