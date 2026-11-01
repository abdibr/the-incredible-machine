# Handoff — Issue #56: the 15 rope-suite failures (rope birth / grow / realize fixes)

**Branch:** `integration/broken-functionality-fixes` · **Issue tracker:** GitHub Issues on `origin` (`https://github.com/abdibr/the-incredible-machine.git`), via `gh` CLI (see `docs/agents/issue-tracker.md`).
**Status:** investigation complete, **no code edited yet**. Every ✕ decoded from full vitest logs (slices of `.scratch/rope-all-clean.txt` :3213–3845) unless marked unverified.

## 1. The spec the tests encode (verified — this part is NOT the bug)

- Counting rule: `segmentsForSpan(span) = min(16, max(6, ceil(span / 40)))` with `SEGMENT_DENSITY_PX = 40`.
  Exists at **`js/objects/Rope.js :288-291` and is correct**.
- Pinned by `tests/rope-span.test.js :66-83`: 239→6, 241→7, 300→8, 480→12, 620→16 (capped), invalid→6.
- Both birth paths must honor it (constructor **and** free-rope spawn), not just re-lays.
- Its doc comment (`Rope.js :282-284`) is **stale** — claims the ctor intentionally births fixed SEGMENTS. Must be rewritten with the fix.

## 2. The 15 ✕s → 5 root causes

### RC1 — Ctor births a fixed 6 segments (`Rope.js :166-196`) — ~4–6 ✕s
Hard-coded `for (let i = 0; i < SEGMENTS; i++)` with `segLength = _length/6`. Every rope births 6 regardless of length.
- `rope-span :89-91`: length 480 must birth 12 rope-seg bodies — got 6.
- `rope-span :153` (drop-tail suite :147-178): length 700 must birth 16 — got 6. Rest of that test (prune + world removal :171-177) untestable until this heals; likely heals from the ctor fix alone.
- long-rope tie tests (rope-ties) — same cause (seats beyond 5 don't exist on a 6-chain).

### RC2 — Length-bearing free rope never spawns at addObject — 2 ✕s
`rope-span :97-106` (+ free-rope suite equivalents): `create('free-rope', 260, 300, { length: 60 })` + `addObject` → expect 6 rope-seg bodies, **got 0**. Current model (issue #55): free rope is a bodyless coil until the first tie (`attachEndpoint` → `_spawnChain :669-709` → `rope:chain-spawned` → `PhysicsEngine._addRopeChain :1110`). Issue #56 demands: a free rope created **with an explicit length** births immediately at addObject. `_spawnChain` itself also uses the fixed-6 loop.
**Compatibility constraint:** length-*less* free ropes must remain coils (issue #55: coil bundle → first tie → chain → collapse). Ctor default is `options.length || 100`, so "explicit" must be tracked (e.g. flag `options.length !== undefined`). Verify the free-rope factory forwards `length` to the Rope ctor (the test passes `{length: 60}`).

### RC3 — Tie covering-grow compounds after a reel re-count (`Rope.js attachEndpoint :342-419`) — 4 ✕s (connect-flow)
The flow seeks (captures tail seat **5** on the fresh 6-chain), reels (span = demand×count/(count−0.5), `setEndpoints` correctly re-counts 6→9 or 6→13), then ties the **stale seat 5**. Seat-5 capacity (`span×5.5/count`) < knot distance → grow fires a *second* re-derivation against the new count:
- [1]: got `tied×9/5.5 = 493.3`; expected the reel's span `tied×6/5.5 = 328.9` (tail seat 8 on the 9-chain has capacity 310.6 ≥ 301.5 ⇒ no grow at all).
- [4]: got `tied×13/5.5 = 1085.5`; expected `tied×6/5.5 = 500.8` (tail seat 12 capacity 481.5 ≥ 459.06 ⇒ no grow).
- [2]/[3]: same family, exact diffs re-verify on run.

### RC4 — Connect-flow test fixture bug — 2 ✕s (ReferenceErrors)
`flow is not defined` ×2. Add `let flow` + per-test setup inside the describe (~`tests/connect-flow.test.js :713`).

### RC5 — Re-lay/realize conventions — 2 ✕s
- **rope-connector realize (~:108-129, ✕ at :120):** attach(5) on the 6-chain with a balloon 223.6 px away → grow `223.6×6/5.5 = 243.94` → `setEndpoints` re-counts to 7 and *appends* seg6, so `bodies[7]` = new lastSegment but the link's `bodyA` = seat 5 (seg5) → identity mismatch (got id 119 ≠ 110). Wants the link riding the actual last segment.
- **rope-span :144 ([12/15]):** re-lay 6→11 (span 420) must put the **tail body exactly on the endpoint** `(200,520)` after a step. Center-lay yields `10.5/11×420 = 400.9` (+strain ≈ got 502.5).
- **Constraint from currently-green tests:** rope-connector :302-306 *demands* center-lay `t=(i+0.5)/6` for **all** bodies incl. the tail on a floor-kept 6→6 re-lay; rope-span :233 (frozen tie relay) expects the tail at the demand = `span×(count−0.5)/count` (center-lay).
- **Reconciliation satisfying all three:** center-lay everywhere **except** when the re-lay actually appended (`added.length > 0`) ⇒ lay the appended tail body exactly on `end`. Frozen/second relays and floor-kept re-lays never append ⇒ centers ✓.

## 3. Verified engine wiring (context, don't re-derive)

`setEndpoints :855-889` **already re-counts** (:866-867 `segmentsForSpan` + `_resizeChain`) — rope-span :128 (6→11) and :195-199 (16→7 shrink packet) pass today. `PhysicsEngine` event wiring: `rope:chain-spawned` → `_addRopeChain :1110`; `rope:chain-converge` → `_restoreRopeConstraints` (fn at `:1199`, invoked :1100); `rope:severed` → detach :1092. Seat schema −1 (anchor) … `count−1`; `attachEndpoint` gates at :344 (0…15 in-schema), throws `no seat ${segment} to tie` at :366 when no body. relayFreeEnd under-span: `span = demand×count/(count−0.5)`, converging on the second call (rope-span :209-233).

## 4. Proposed fixes

**Engine (`js/objects/Rope.js`, `js/engine/PhysicsEngine.js`):**
1. **Ctor :166-196:** `const count = Rope.segmentsForSpan(this._length)` (default `options.length || 100`), loop `count`, `segLength = _length/count`.
2. **`_spawnChain :669-709`:** same span-derived count; spawn a free rope at `addObject` when its length was explicit (tracked flag); length-less frees stay coils (issue #55).
3. **`attachEndpoint :342-419`:** before the capacity/grow gate, resolve the knot's **containing seat** on the current chain; if `tied ≤ span` bind that seat (no grow) — kills the stale-seat compounding. If `tied > span`, grow **span-only**: `span = tied×count/(requestedSeat+0.5)`, honoring the requested seat **without re-segmentation** (bypass the re-count inside setEndpoints; rebuild constraints / re-line at centers, pitch = span/count). Span-only grow also satisfies rope-connector :120 (seat 5 stays the tail ⇒ `bodyA = lastSegment`) while keeping rope-ties :66-85 (`bodyA = bodies[3]`, seat kept :78) green. NOTE: the grow currently routes through `setEndpoints`, which re-counts — that's the compounding seam.
4. **`setEndpoints` tail lay:** when `_resizeChain` appended (`added.length > 0`), lay the new tail body exactly on `end`; all other re-lays keep center-lay (RC5 reconciliation).
5. **Doc comment :282-284:** state the span-derived birth rule, not the old fixed-SEGMENTS ctor.
6. **`_restoreRopeConstraints` / rope removal (`PhysicsEngine :1199-1240`):** verify it pulls `dropped` bodies from the world (rope-span :171-177 needs it); fix if not.

**Tests:**
7. `connect-flow.test.js`: add `let flow` + setup in the describe (~:713) → kills both ReferenceErrors.
8. Touch expectations only where the post-fix run still shows ✕ (expect [1]/[4]/:120/:144/:153/:90/:102 to heal unedited).

## 5. Open items (verify during implementation, do NOT pre-read again)

- Rope-ties' 2 exact diffs never fully decoded: :101 ("2 links" got 1 — suspect the second attach's grow re-lay pruned/clobbered the first realize) + one more ("long rope"; likely RC1). Should heal with fixes 1+3; if not, decode from `.scratch/rope-all-clean.txt` slices **beyond :3845** (never read).
- `.scratch/probe-out.txt` may be stale (a later query returned empty); prefer `rope-all-clean.txt` as ground truth.
- Confirm the free-rope factory forwards `length` (RC2 explicit-length detection depends on it).
- Containing-seat re-seat (fix 3) vs currently-green rope-knots/rope suites — run them as regressions.

## 6. Session gotchas (environment)

- `run_commands` must be **one single command string** per call (PowerShell).
- Blank tool output ≠ failed call — redirect output to a file and read it back; only redirected reads were trustworthy in prior sessions.
- Work dir `D:\\games\\incredible_machine`; suites: `rope-span`, `rope-connector`, `rope-ties`, `free-rope`, `connect-flow` (+ `rope.test.js`, `rope-knots` as regressions).
- **Debris to delete before commit:** `tests/probe-issue56.test.js` (scratch probe), `.scratch/*`, session run logs (`dev-server.log`, `smoke-*.log`, `strays-204729.log`, `vitest-*.log` — confirm which are session-created vs pre-existing).

## 7. Execution order for the next session

1. Spot-check the cited line ranges still hold (repo untouched since this handoff).
2. Apply engine fixes **1→6**.
3. Apply connect-flow fixture fix 7.
4. Run the five rope suites + regressions; decode residual ✕s from fresh logs; spec-level expectation edits only.
5. Delete debris (§6), commit on `integration/broken-functionality-fixes`, update issue #56 (§2/§4), append dated entry to root `work-log.md`.