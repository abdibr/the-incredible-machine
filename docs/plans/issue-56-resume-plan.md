# Resume plan — Issue #56: span-derived rope chains

**Branch:** `integration/broken-functionality-fixes` · **Base checkpoint:** `c066611` (green: 572/572, build OK)
**Measured WIP state:** 581 passing / 16 failing of 597 tests in 54 files.
(Not 13-of-91 — `vitest-now.txt` predated the last code edits and is stale.)

## Diagnosis — one conflation, sixteen symptoms

`attachEndpoint`'s tie-grow routes through `setEndpoints`, and `setEndpoints`
re-derives the chain count from the span (`segmentsForSpan`). So a tie that
merely needs more *reach* silently re-segments the chain:

- seat 5 on a 6-chain grows the span 80 → 549px, count re-counts 6 → 14,
  and index 5 is no longer the tail (index 13 is);
- every knot stores a **literal seat index** (`this._attachments[].segment`,
  resolved by `_tieBody` as `this._segments[segment]`), so the knot now rides
  the wrong body or falls off the chain entirely.

Two operations must separate:

| Operation | Count | Span | Seats |
|---|---|---|---|
| **Tie-grow** (knot needs reach) | **frozen** | grows | indices stable; end seat stays the tail |
| **Re-lay** (`relayFreeEnd`, explicit `setEndpoints`) | re-derived | grows/shrinks | tail appended/dropped, earlier indices preserved |

The handoff (`docs/plans/issue-56-rope-handoff.md` §4 fix 3) predicted exactly
this: *"NOTE: the grow currently routes through `setEndpoints`, which re-counts
— that's the compounding seam."*

Failure map (16):

- **2** `tests/probe-issue56.test.js` — scratch probe, delete (handoff §6).
- **9** new issue-#56 spec suites (`rope-span`, `rope-ties`, `free-rope`, `connect-flow` #56 cases).
- **5** regressions in previously-green suites — 3 `connect-flow` state machine
  (≥1 is the one-line `let flow` fixture bug, handoff RC4), 2 `connector-reset`
  (seat 5 → 8/12 renumbering, the conflation above).

## Steps

Each step is implemented by one agent under the `implement` skill contract
(TDD at the seam, single-file test runs, full suite at the end, code-review, commit).

### Step 1 — Baseline and spec reconciliation
Delete the scratch probe and session debris so the failure count is trustworthy;
confirm which of the new suites are spec (keep) vs scratch (drop).
**Done when:** suite runs clean of debris; failing count = spec failures only; committed.

### Step 2 — Split tie-grow from re-lay (keystone)
`attachEndpoint` grows the span **without** re-segmenting: freeze the count,
rebuild/stretch rest lengths for the new span, keep seat indices and the tail.
`setEndpoints` keeps its re-count for genuine re-lays.
**Files:** `js/objects/Rope.js` (`attachEndpoint`, `setEndpoints`, `_buildChainConstraints`).
**Turns green:** `connector-reset` ×2, `rope-ties` token/refs cases, `rope-connector` realize.

### Step 3 — Free rope births count-honest at `addObject`
A free rope created with an **explicit** `length` spawns its chain immediately
(`segmentsForSpan`-honest); a length-less free rope stays a bodyless coil (issue #55).
**Files:** `js/objects/Rope.js`, `js/engine/PhysicsEngine.js`.
**Turns green:** `rope-span` count-honest, `free-rope` spawn cases.

**Landed** (8 failures, was 9; 597 tests — two new ones):
`Rope` records authored-vs-default length once in the ctor (`hasExplicitSpan`);
`birthAuthoredChain()` (called by `addObject` before its body loop) lays the chain
through the shared `_layChainFrom`, and the first anchor tie re-roots a pre-laid
chain at the clicked knot (`_reRootChain` → `setEndpoints`, so the converge seam
swaps the constraints and no second `rope:chain-spawned` fires).

Two things the next steps must not trip over:

1. **The `free-rope` coil fixtures now pin the LENGTH-LESS rope.** With an
   authored span the chain exists from `addObject` on, which makes "a bundle is
   bodyless" and "the first tie spawns" false *by construction* — the two suites
   were mutually contradictory as written (`rope-span:97` demanded 6 bodies after
   `addObject` on `{length: 60}`, `free-rope:72` demanded `bodies === []` in the
   identical fixture). The coil contract therefore moved to
   `create('free-rope', x, y)` with its assertions untouched, and the two new
   `issue #56 — the authored span lays at addObject` tests cover the authored
   family. `free-rope`'s board-load test's spawn-event assertion is the one
   genuine rewrite: the chain is born at `addObject` and the bind pass re-roots it,
   so nothing rides `rope:chain-spawned` there any more.
2. **`serialize` always writes `length`**, so a row can't tell authored from
   default. The coil survives a reset through the existing `spawned:false`
   discriminator (`FreeRope.restoreState` collapses the pre-laid chain) —
   `reset rolls an untied board back to the inert bundle` is green unedited.

### Step 4 — Knots survive re-segmentation
Append-only tail growth (and drop) so earlier seats keep their bodies; a knot on
the end seat stays on the end seat across a re-count; mid-chain knots ride their
own segment body.
**Turns green:** `rope-span` tail-trades, `rope-ties` long-rope, `free-rope` re-span.

### Step 5 — ConnectFlow reach gates and state-machine regressions
Fix the `let flow` fixture, then the free-rope reach gates (first tie from the
coil must reach as far as anything else on the board; spawned rope re-ties far).
**Files:** `js/ui/ConnectFlow.js`, `tests/connect-flow.test.js`.

### Step 6 — Full suite, review, docs, commit
Whole suite green (572 baseline + the new spec tests), `npm run build`, code-review,
`work-log.md` entry, debris gone, single squashed commit on the integration branch.

## Step 2 spec resolution — the contradiction, settled from the tests

Step 1 found two tests apparently demanding opposite tie-grow behaviour. Reading
them together resolves it: the two rope families genuinely differ.

| Family | Tie-grow | Count | Evidence |
|---|---|---|---|
| **Pinned** (`rope`) | span grows, **count frozen** — the chain is authored by the level, a tie may lengthen the rope but never reshape its chain | `_segments.length` unchanged, no re-count | `connector-reset` ×2 (token `segment: 5` survives), `rope-ties:266-268` (`_length` = tied·6/4.5, `_segments.length` = 6, "no recount"), `rope-connector` realize, `rope-ties:206` |
| **Free** (`free-rope`) | span grows **and** the chain re-lays to it — no authored chain exists, the span *is* the chain (ADR 0007 decision 4) | `count === segmentsForSpan(_length)`, appended tail | `free-rope:394-397` |

Both use the same seat arithmetic (`span = tied · count / (seat + 0.5)`); they
differ only in whether the count then follows the span.

**Also settled:** the WIP's "one middle tie per rope" gate is removed. It is a
WIP invention that its own spec suite contradicts — `rope-ties:206` ties seats 3
*and* 9 on one 11-chain and expects both links realized from their own bodies.
Any seat accepts knots; several knots may share a seat.

**Implementation shape:** `setEndpoints` gains a no-re-count mode (`resegment:
false`) that re-lines the existing bodies along the new span and rebuilds the
rest lengths for it. `attachEndpoint`'s grow calls it pinned-vs-free accordingly.
That is the whole keystone — one flag, one branch, no new abstractions.

## Invariants to protect (regressions if broken)

- Short spans keep the six-segment chain (`SEGMENTS` floor) — `MIN_ROPE_SPAN` pitch.
- A pinned rope's length is frozen after the first tie and refuses over-reach.
- A length-less free rope stays an inert coil until its first tie (issue #55).
- ~~One middle tie per rope; anchor and end seats accept many knots.~~ **Struck in step 2 — it was false.** Its own spec suite contradicted it (`rope-ties` ties seats 3 *and* 9 on one 11-chain), and it is a WIP invention rather than a design rule; the gate is gone. The rule that holds instead: **any *laid* seat accepts knots, and several knots may share one seat** (per-knot untie, several knots ride one rope across segments — ADR 0007 decision 6). A seat the live chain has not laid still refuses, and a tie never re-counts a chain a knot already sits on: a pinned tie-grow freezes the count, a free re-root keeps it.
- `{ endpoint: 0|1 }` tokens still migrate to `{ segment: -1|5 }` with a warning apiece.

## Step 1 findings

**Baseline re-measured 2026-11-01**, `npx vitest run --dir tests`, exit 1:

| Run | Files | Tests | Pass | Fail |
|---|---|---|---|---|
| before the debris drop | 54 | 597 | 581 | 16 |
| after the debris drop | 53 | 593 | 579 | **14** |

The surviving 14 are the same test ids in both runs (identical FAIL list, no
additions) — the only delta is the two `probe-issue56` ✕s that left with the
file. Nothing regressed.

Debris dropped: `tests/probe-issue56.test.js`, `pe-diff.txt`, `ren-diff.txt`,
`review-report-check.png`, `vitest-baseline.txt`, `vitest-fails.txt`,
`vitest-now.txt`, `scripts/migrate-tie-tokens.ps1`,
`scripts/migrate-tie-tokens2.ps1`, `scripts/read-tie-log.ps1`. `scripts/` keeps
its three tracked `.mjs` tools. `.scratch/` untouched.

### Triage (14)

| # | File | Test | Bucket | Why (observed) |
|---|---|---|---|---|
| 1 | `connect-flow` | clicking a target square while seeking ties the knot and ends the seek | REGRESSION | knot lands on `segment: 8`, expected `5` — the grow re-counts 6→9 |
| 2 | `connect-flow` | clicking a tied square unties one knot and keeps the rest (per-knot untie) | REGRESSION | same `8` vs `5` |
| 3 | `connect-flow` | a tie click beyond the reach is refused — no knot, seek intact, feedback armed | REGRESSION | `segment: 12` vs `5` — grow re-counts 6→13 on a *refused* tie |
| 4 | `connect-flow` #56 | the first tie from the coil ties as far as anything else on the board | SPEC-GAP | `ReferenceError: flow is not defined` (:717) — new describe has no fixture; reach gate untested until step 5 |
| 5 | `connect-flow` #56 | a spawned free rope re-ties far: the tail-square seek ties the ~440px rim | SPEC-GAP | same missing `flow` fixture (:745); free-rope reach gate, step 5 |
| 6 | `connector-reset` | annotates rope rows with ordinal tokens; other rows stay clean | REGRESSION | serialized token `segment: 13` vs `5` (token was `endpoint: 1` and green at `c066611`) |
| 7 | `connector-reset` | re-binds tokens two-phase to the fresh instances | REGRESSION | same `13` vs `5` |
| 8 | `free-rope` | stays tie-able anywhere after the first tie: a spawned rope re-ties far and re-spans | SPEC-GAP | the seat-2 tie's grow re-segments; the knot's engine link never realizes (`undefined`), step 4 |
| 9 | `rope-span` | a free rope spawns count-honest: the spawn births what its length demands, like a drop | SPEC-GAP | `[]` — a length-bearing free rope is still a bodyless coil at `addObject`, step 3 |
| 10 | `rope-span` | setEndpoints grows the tail: appended segments join the world, early seats keep their knots | SPEC-GAP | tail centre `502.50` vs `520` — centre-lay leaves it pitch/2 short of `end` (handoff fix 4), step 4 |
| 11 | `rope-ties` | `{ endpoint: 0\|1 }` tokens bind as `{ segment: -1\|5 }` with a warning apiece | SPEC-GAP | binds `[-1, 6]` — the anchor tie's grow re-counts before the tail token binds, step 2 |
| 12 | `rope-ties` | getAttachmentRefs sorts knots anchor-first, then in chain order | SPEC-GAP | `[-1, 2, 9]` vs `[-1, 2, 5]` — seat-5 tie grew the span, tail is now 9, step 2 |
| 13 | `rope-ties` | a long rope ties at several seats and each knot realizes from its own segment body | SPEC-GAP | `attachEndpoint(9)` throws *one middle tie per rope — seat 3 already carries…*, step 2/4 (see note 3) |
| 14 | `rope-ties` | mixed-type knots round-trip serialize → two-phase bind on both rope lifecycles | SPEC-GAP | restored `_length` `2162.76` vs `811.04` (= `hypot(600,100)×6/4.5`) — grow compounds through the bind, step 2 |

Totals: **SPEC-GAP 9 · REGRESSION 5 · STALE-TEST 0**. Nothing here may be
healed by weakening an assertion; STALE-TEST is empty by construction.

### Notes the next steps must know

1. **`npm test` is not a usable gate yet.** `.scratch/wip-check/` is a full copy
   of the repo (gitignored, off-limits this step) and vitest's default include
   sweeps it: `npm test` reports 11 failed files / 30 failed tests of 1190 —
   exactly our 14 plus 16 from the copy. Use `npx vitest run --dir tests`
   (53 files / 593) until the copy is removed or
   `test.exclude: ['**/.scratch/**']` is added to `vite.config.js`.
2. **Tie-grow count is contradictory across the specs — resolve before coding
   step 2.** `rope-ties:266-268` wants grow to be *span-only with a frozen
   count* (length grows to 811 while `_segments.length` stays 6);
   `free-rope:394-396` wants the same grow to *re-count*
   (`count === segmentsForSpan(_length)`, `count > 6`). The two can only coexist
   if the rule differs between free and pinned ropes. Also, `rope-ties:268` is
   currently masked by the earlier `:266` assertion and is written against the
   old fixed-6 birth (`Rope.deserialize` forwards the row's grown `length`, so a
   count-honest re-birth of an 811px rope is 16) — expect the first genuine
   STALE-TEST to surface there once `:266` heals.
3. **`rope-ties:206` contradicts a protected invariant.** It ties seat 3 *and*
   seat 9 on one 11-chain; production refuses the second ("one middle tie per
   rope"). Either that invariant yields whenever the seat exists, or the test is
   wrong — it is the only failure that argues against the invariant list above.
4. **`js/levels/puzzles/level-07.json` is tracked, not untracked** — added by
   `5435af8` (+68 lines), unmodified since. Left untouched; step 6 decides
   whether it belongs on this branch.
5. Left in place (out of scope): untracked
   `docs/plans/backlog-prioritization-2026-10-27.md`, and the gitignored root
   run logs (`vitest-*.log`, `smoke-*.log`, `dev-server.log`, …).

## Outcome

**Shipped** as one commit on `integration/broken-functionality-fixes` over `c066611`.

| Run | Files | Tests | Result |
|---|---|---|---|
| full suite (`npm test`), base `c066611` | 53 | 572 | green |
| full suite, WIP as measured in step 1 | 54 | 597 | 581 pass / 16 fail |
| full suite, final | 53 | **601** | **601 pass / 0 fail** |
| `npm run build` | 49 modules | — | clean (`index-*.js` 242.63 kB, gzip 69.01 kB) |

The five behaviours delivered:

1. **Span-derived count** — `Rope.segmentsForSpan(span)` (~40 px pitch, floored at `SEGMENTS` 6, capped at `MAX_SEGMENTS` 16, invalid spans → floor) is the count at birth (pinned ctor and `_layChainFrom`), at every re-lay (`setEndpoints`) and under the hand (`relayFreeEnd`). One `seatFraction(seat, count)` supplies the seat arithmetic everywhere a gate or a grow needs it.
2. **Tie seats** — `−1` the anchor, `0…count−1` chain bodies; any laid seat ties, several knots share a seat, and each knot realizes its engine link from its own body. The end seat is the *role* `count−1` (a knot on it rides a re-count), mid-chain knots keep literal indices. Legacy `{ endpoint: 0|1 }` tokens migrate with a warning.
3. **Tie-grow vs re-lay** — the keystone split: `setEndpoints(..., { resegment })`. A pinned tie-grow freezes the count and only grows the span; a free tie-grow re-derives it. An appended tail lands on `end` (last link 1.5 pitches) instead of half a pitch inboard.
4. **Authored span** — `Rope` records authored-vs-default length once (`hasExplicitSpan`); an authored free rope lays its chain at `addObject` (`birthAuthoredChain`) and its first anchor tie re-roots that chain at the clicked knot (`_reRootChain`, a frozen re-lay); a length-less free rope keeps issue #55's inert coil.
5. **Persisted chain count** — `serialize` writes `options.segments` beside `length`/`lengthFrozen`, so restore re-births the chain the rope had and save → load → save is idempotent (a pinned frozen-count tie-grow no longer creeps longer per cycle). A pre-#56 row keeps its coil through `spawned:false` (`options.authoredSpan`).

Where the original step shape changed:

- **Steps 3 and 4 split along a different seam.** Step 3 delivered the authored birth; the persisted count *and* the appended tail's landing on `end` turned out to be one seam (both are `setEndpoints`/restore geometry) and landed as step 4 — the count is what makes the tail's position round-trip.
- **Step 5 was almost entirely test-side.** The ConnectFlow failures were the one-line `let flow` fixture plus assertions written against the fixed-6 chain; the only production changes it needed were resolving a free rope's seek seat against the live chain, keeping that seek armed (`isFree`), and opening `isPointWithinReach` for the free family.
- **A seventh finding, resolved in step 6:** `_reRootChain` called `setEndpoints` without `{ resegment: false }` while its own doc said "a re-root is not a re-count". Harmless for a live free rope (count ≡ `segmentsForSpan(length)`), but not for a restored row whose `options.segments` the span does not derive — it re-derived the chain (4 bodies → 8). Fixed with the flag, pinned by a test; the doc now says why.

