# 4. Slots & slot processing

This is **phase 1** of the state transition — the first thing that happens when a block arrives. Its job
sounds trivial ("advance the clock to the block's slot") but it hides two subtleties that cause real
bugs: how **empty slots** are recorded, and the **deferred `state_root`** fill. Master this and phase 2
(header) and phase 4 (root) stop surprising you.

## Theory — why advance the clock at all

Blocks don't happen every slot. A proposer may be offline, or its block may not propagate. So a block
at slot 10 whose parent is at slot 7 means slots 8 and 9 were **skipped**. The state must still *account
for* those slots — the chain's history has to record "nothing happened at 8 and 9" — before it processes
the block at 10. `process_slots` is the function that walks the pre-state's clock forward, materializing
every skipped slot, until it reaches the block's slot.

Why does the history need the empty slots at all? Because `HistoricalBlockHashes` is indexed by slot
(**[chapter 03](03-state)**): index *i* is the root at slot *i*. If you skipped recording empty slots,
the indices would drift and every historical lookup — and thus the `state_root` — would be wrong.

## Specification — `process_slots`

The spec's `process_slots(state, target_slot)` loops: while `state.slot < target_slot`, advance one
slot, and at each step perform the per-slot work (roll the latest header's deferred `state_root`, extend
the historical/justification bookkeeping). It ends with `state.slot == target_slot`.

The single most important subtlety lives here: **the deferred `state_root`.**

### The deferred `state_root`

When phase 2 records a block header (next chapter), it stores the header with a **zero** `state_root` —
because a header cannot contain the root of a state that includes that very header (a cycle). The real
root is only known *after* the whole transition finishes. So the fix: on the **next** slot's
`process_slots`, before advancing, fill in the previous header's `state_root` with the now-known
`hash_tree_root(state)`.

```
  slot N transition:
     phase 2 stores header_N with state_root = 0x000…      (deferred)
  slot N+1 transition:
     phase 1 (process_slots) fills header_N.state_root = hash_tree_root(state)  ← now known
```

Get this wrong — fill it in the same transition, or not at all — and **every** root you compute is
wrong, consistently. It is the #1 "all my roots are off" bug.

## Gean implementation

gean's `ProcessSlots` (`internal/statetransition/slots.go`) is deliberately **O(1)**:

```go
func ProcessSlots(state *types.State, targetSlot uint64) error {
    if state.Slot >= targetSlot {
        return &StateSlotIsNewerError{TargetSlot: targetSlot, CurrentSlot: state.Slot}
    }
    if state.LatestBlockHeader.StateRoot == types.ZeroRoot {   // the deferred fill
        root, _ := state.HashTreeRoot()
        state.LatestBlockHeader.StateRoot = root
    }
    state.Slot = targetSlot                                     // jump, don't loop
    return nil
}
```

Two things to internalize:

1. **The deferred fill is right here.** If the latest header still carries a zero `state_root`, gean
   fills it with the current `hash_tree_root(state)` — exactly the spec's next-slot roll. This is why
   the header's root always belongs to the *previous* transition's final state.
2. **It jumps instead of looping.** The spec shows a per-slot loop; gean sets `state.Slot = targetSlot`
   directly. The empty slots' effect on `HistoricalBlockHashes` is materialized in
   `ProcessBlockHeader` instead (append parent root + one zero per empty slot), bounded up front by a
   `HistoricalRootsLimit` check so a far-slot block can't force an unbounded walk (the
   `BLOCK_SLOT_GAP_TOO_LARGE` protection). **The output bytes — and thus the `state_root` — are
   identical to the spec's loop.**

This is the canonical example of a legitimate gean/spec difference (**[chapter 07](07-state-transition-pipeline)**):
the *code path* differs (O(1) vs loop), the *observable result* does not. When you audit it, you verify
the post-state matches, not that the loop matches.

### The guard: `StateSlotIsNewerError`

A block cannot target a slot at or before its parent's (`state.Slot >= targetSlot`). gean rejects this
immediately. Combined with the future-horizon guard (at the `blockprocessor` boundary,
**[chapter 05](05-time-model)**) and the parent-gap cap, the slot a block may target is bounded on both
ends: strictly after the parent, and no more than one slot beyond the store clock.

### Spec → gean mapping

| leanSpec | gean | File | Role |
|----------|------|------|------|
| `process_slots(state, target)` | `ProcessSlots` | `statetransition/slots.go` | Advance clock to block slot |
| per-slot deferred-root roll | zero-check + `HashTreeRoot` fill | `slots.go` | Fill previous header's root |
| empty-slot historical entries | append in `ProcessBlockHeader` | `block.go` | Record skipped slots |
| far-slot bound | `SlotGapTooLargeError` | `block.go` | Reject unbounded walk |

## Shadow implications

`process_slots` is pure — Shadow's virtual clock is invisible to it. But it interacts with the time
model (**[chapter 05](05-time-model)**): the *number* of empty slots a transition materializes depends
on how long the network went without a block, which under Shadow is a function of the simulated
proposer liveness. A run where one client is down produces blocks with multi-slot parent gaps — and thus
`process_slots` walking several empty slots each time. That's normal, not a bug.

## Debugging techniques

```
"all my state_roots are wrong, consistently"
        → almost always the DEFERRED state_root:
          is header_N.state_root being filled in slot N+1 (correct)
          or slot N (wrong) or never?

"state_root wrong only when slots were skipped"
        → the empty-slot HistoricalBlockHashes accounting:
          are the right number of zero entries appended?
          off-by-one on numEmptySlots = block.Slot - parent.Slot - 1?

"block rejected: state slot >= target slot"
        → the block targets a slot at/before its parent — malformed or replayed block
```

## Common mistakes
- **Filling the deferred root in the wrong transition** — the header's `state_root` belongs to the
  *previous* transition's final state, filled on the *next* `process_slots`.
- **Off-by-one on empty slots** — `numEmptySlots = block.Slot − parent.Slot − 1`; a wrong count shifts
  every subsequent historical index.
- **Assuming a loop is required** — gean's O(1) jump is correct because the observable state matches.
- **Forgetting slot processing runs even with no block** — advancing across empty slots is itself a
  state mutation.

## Mental models
- **Slot processing is bringing the clock up to the block, brick by brick.** Every skipped slot lays a
  zero brick in the history so the indices stay aligned.
- **The deferred root is a one-slot delay.** A header can't sign the state that contains it, so its root
  is stamped one slot later.
- **O(1) or loop, same bytes.** Judge by the post-state, not the code path.

## Cross references
- **[07 — The state transition pipeline](07-state-transition-pipeline)** — phase 1 in the full pipeline.
- **[03 — The State](03-state)** — `Slot`, `LatestBlockHeader`, `HistoricalBlockHashes`.
- **[06 — SSZ foundations](06-ssz-foundations)** — why the header can't contain its own state's root.
- **[05 — The time model](05-time-model)** — the store clock and the future-horizon bound.

## Further reading
- `lean_consensus.pdf` §3 *The Time Model* and §4.3.1 *Phase 1: Slot Processing*.
- gean: `internal/statetransition/slots.go`, `internal/statetransition/block.go` (empty-slot appends).

---

### Key takeaways
- Phase 1 (`process_slots`) advances the state to `block.slot`, **materializing every empty slot** so
  history indices stay aligned.
- The **deferred `state_root`**: a header stores a zero root and gets it filled on the *next* slot's
  processing — miss this and every root is wrong.
- gean uses an **O(1) jump** (plus empty-slot appends in phase 2, bounded by the historical limit);
  same `state_root` as the spec's loop.

### Exercises
1. A block at slot 12 has a parent at slot 8. How many empty slots does phase 1 account for, and how
   many zero entries go into `HistoricalBlockHashes`?
2. Explain, with the two-slot diagram, why a header can't contain the root of its own state.

### Debugging exercises
1. Every `state_root` gean computes is wrong, even for single-block chains with no skipped slots. Leading
   hypothesis?
2. Roots are correct except right after a gap of several empty slots. Where do you look and what's the
   likely off-by-one?

### Code-reading assignment
- Read `internal/statetransition/slots.go` and identify the exact line that performs the deferred
  `state_root` fill. Then find, in `block.go`, the `numEmptySlots` computation and the zero-append loop.

### Questions to verify understanding
- Why can gean legitimately use an O(1) `ProcessSlots` when the spec shows a per-slot loop?
- Why must empty slots be recorded in `HistoricalBlockHashes` rather than simply skipped?
