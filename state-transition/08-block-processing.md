# 8. Block processing

This is **phase 2** of the state transition — `process_block_header`. Phase 1 brought the clock to the
block's slot; phase 2 **binds the block to its parent and the chain's rules** before phase 3 trusts its
body. It is the gatekeeper: everything it checks is a condition under which the block is *illegitimate*
regardless of what its body says. Get phase 2 right and you never process the body of a block that had
no business being processed.

## Theory — bind before you trust

A block body carries votes that will mutate finality bookkeeping (phase 3). Before touching any of that,
you must establish that this block is a *legitimate successor* of the current state:

- proposed by the **right validator** for this slot,
- built on the **right parent** (the current `latest_block_header`),
- **newer** than the latest header,
- well-formed enough that its history accounting is bounded.

Only then is it safe to apply the body. Header validation is cheap and rejects early — the spec even
moved the far-future guard *before* signature verification so a bad block is thrown out before you pay
for expensive crypto (**[chapter 07](07-state-transition-pipeline)**).

## Block anatomy (PDF §4.2)

A block is a **header** plus a **body**:

- **Header**: `slot`, `proposer_index`, `parent_root`, `state_root` (the claim, checked in phase 4),
  `body_root`.
- **Body**: the operations — in Lean Consensus, the **aggregated attestations** (votes), plus the block's
  aggregation proof.

Phase 2 works on the header; phase 3 (**[chapter 09](09-attestation-processing)**) works on the body.

## Specification — `process_block_header`

The spec's `process_block_header(state, block)` asserts, in order:

1. `block.slot == state.slot` (phase 1 already advanced us here),
2. `block.proposer_index` is the slot's elected proposer,
3. `block.parent_root == hash_tree_root(state.latest_block_header)`,
4. the block is newer than the latest header,

then records the block's header as the new `latest_block_header` with a **zero `state_root`** (the
deferred root, filled next slot — **[chapter 04](04-slots)**), and updates the historical bookkeeping.

## Gean implementation — `ProcessBlockHeader`

From `internal/statetransition/block.go`, the checks and the history update:

```go
// proposer must be the slot's elected proposer
if block.ProposerIndex != expectedProposer {         return &InvalidProposerError{…} }
// parent_root must hash the current latest header
if block.ParentRoot != parentRoot {                  return &InvalidParentError{…} }
// … body root, newer-than-latest checks …

// record skipped slots + bound the gap BEFORE the append loop
numEmptySlots := block.Slot - parentHeader.Slot - 1
newEntries := 1 + numEmptySlots
if currentHistoricalRoots > types.HistoricalRootsLimit ||
   newEntries > types.HistoricalRootsLimit-currentHistoricalRoots {
    return &SlotGapTooLargeError{…}                   // BLOCK_SLOT_GAP_TOO_LARGE
}
state.HistoricalBlockHashes = append(state.HistoricalBlockHashes, copyRootBytes(parentRoot))
for range numEmptySlots {                             // one zero root per empty slot
    state.HistoricalBlockHashes = append(state.HistoricalBlockHashes, make([]byte, types.RootSize))
}
// … extend JustifiedSlots bitlist up to the block's slot …
```

Key points:

- **Proposer election** is `slot % num_validators` — index stability (**[chapter 03](03-state)**) is why
  this works: validator *i* is always *i*.
- **Parent binding** is the chain link: `block.ParentRoot == hash_tree_root(parentHeader)`. This single
  check is what makes the chain tamper-evident — you cannot re-parent a block without changing its
  `parent_root`, which changes its own hash.
- **The gap check fires *before* the append loop.** This is gean's realization of the empty-slot
  materialization from phase 1 (gean does it here, O(1) `ProcessSlots` aside — **[chapter 04](04-slots)**),
  and the up-front bound is the anti-DoS guard: a far-slot block is rejected before it can append
  billions of zero roots.
- **`JustifiedSlots` is extended** to cover up to the block's slot, so phase 3 has room to mark
  justification.

### Spec → gean mapping

| leanSpec | gean | File | Role |
|----------|------|------|------|
| proposer check | `InvalidProposerError` guard | `block.go` | Right proposer for the slot |
| parent-root check | `InvalidParentError` guard | `block.go` | Bind to parent (chain link) |
| record header (zero root) | set `LatestBlockHeader` | `block.go` | Deferred `state_root` |
| historical roots update | append parent + empty zeros | `block.go` | Per-slot history |
| far-slot bound | `SlotGapTooLargeError` | `block.go` | `BLOCK_SLOT_GAP_TOO_LARGE` |

## What changes, what can't (phase 2)

- **Changes:** `LatestBlockHeader` (→ this block's header, zero root), `HistoricalBlockHashes` (append),
  `JustifiedSlots` (extend length).
- **Cannot change here:** validator registry, justification *votes* (that's phase 3), the finalized
  checkpoint.
- **Invariant preserved:** the chain link — after phase 2, `LatestBlockHeader` is this block's header,
  and the next block's `parent_root` must hash it.

## Shadow implications

Phase 2 is pure. But its inputs reflect network reality under Shadow: a run with a downed proposer
produces blocks with large parent gaps, so phase 2 appends several empty-slot zeros each time and the
gap check does real work. The proposer-election check also surfaces a common misconfig symptom — if the
committee/validator counts differ across clients, `slot % num_validators` picks *different* proposers and
blocks get rejected as `InvalidProposer` cross-client. That is an interop config bug, not a logic bug
(**[chapter 15](15-debugging-playbook)**).

## Debugging techniques

```
block rejected in phase 2
        │
        ├─ InvalidProposer  → num_validators mismatch across clients? (config)
        │                      or genuinely wrong proposer_index in the block
        ├─ InvalidParent    → block.parent_root != hash(latest_block_header):
        │                      wrong parent, or the latest header isn't what you think
        │                      (deferred state_root not filled? — ch 04)
        ├─ SlotGapTooLarge   → far-slot block; parent gap exceeds HistoricalRootsLimit
        └─ not-newer         → replayed/stale block at/before the latest header
```

The `InvalidParent` case is subtle: if your `latest_block_header` still has a *zero* `state_root` that
should have been filled, its hash differs from what the proposer computed, and a legitimate block looks
like it has the wrong parent. Always suspect the deferred root here.

## Common mistakes
- **Trusting the body before the header.** Phase 3 must not run if phase 2 rejected.
- **Comparing against an un-filled latest header.** The deferred `state_root` must be filled (phase 1)
  before `parent_root` comparisons are meaningful.
- **Doing the gap check after the append loop.** The bound must precede the loop or the DoS is real.
- **Assuming proposer election needs the committee count.** It's `slot % num_validators`; a wrong
  validator count silently elects the wrong proposer.

## Mental models
- **Phase 2 is the bouncer.** It checks credentials (proposer), the invitation (parent link), and the
  time (newer than latest) before letting the body in.
- **The parent link is the chain.** One equality (`parent_root == hash(latest_header)`) is what makes
  the whole history immutable.

## Cross references
- **[07 — The state transition pipeline](07-state-transition-pipeline)** — phase 2 in context.
- **[04 — Slots](04-slots)** — the deferred `state_root` that phase 2's parent check depends on.
- **[09 — Attestation processing](09-attestation-processing)** — phase 3, the body.
- **[03 — The State](03-state)** — `LatestBlockHeader`, `HistoricalBlockHashes`, index stability.

## Further reading
- `lean_consensus.pdf` §4.2 *Block Anatomy*, §4.3.2 *Phase 2: Header Validation*.
- gean: `internal/statetransition/block.go`.

---

### Key takeaways
- Phase 2 (`process_block_header`) **binds a block to its parent and the rules** before the body is
  trusted: right proposer (`slot % num_validators`), right parent (`parent_root == hash(latest_header)`),
  newer than latest.
- It records the header with a **deferred (zero) `state_root`** and appends per-slot history, bounding
  the gap **before** the append loop.
- `InvalidParent` is often really an un-filled deferred `state_root`; `InvalidProposer` is often a
  cross-client validator-count mismatch.

### Exercises
1. List phase 2's checks in order and the gean error each raises.
2. Why must the parent-gap bound come *before* the historical-append loop?

### Debugging exercises
1. gean rejects a block as `InvalidParent` that zeam accepted. Give two distinct causes and the check
   that distinguishes them.
2. All clients but gean elect proposer 2 for slot 17; gean elects proposer 5 and rejects everyone's
   blocks. What's wrong, and where?

### Code-reading assignment
- In `internal/statetransition/block.go`, find the proposer check, the parent-root check, and the
  `numEmptySlots` append loop. Confirm the `SlotGapTooLargeError` guard precedes the loop.

### Questions to verify understanding
- How does a single equality make the block history tamper-evident?
- Why does phase 2 store a zero `state_root`, and which phase fills it?
