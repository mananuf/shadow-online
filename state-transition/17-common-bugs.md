# 17. Common bugs

A specialist recognizes a bug by its **shape** before reading a line of code. This chapter is a catalog
of the recurring failure shapes across state transition, SSZ, and the time model — each with its symptom,
root cause, fix, and the chapter that explains it. Treat it as a lookup table you internalize until the
symptom alone points you at the cause.

## State transition

### The deferred `state_root` (the #1 root bug)
- **Symptom:** *every* `state_root` is wrong, consistently — even single-block chains.
- **Cause:** the block header's `state_root` is filled in the *same* transition instead of the *next*
  slot's `process_slots`, or never.
- **Fix:** fill `LatestBlockHeader.StateRoot` on the *next* slot's phase 1, from the now-known
  `hash_tree_root(state)`. **([ch 04](04-slots), [07](07-state-transition-pipeline))**

### Empty-slot off-by-one
- **Symptom:** roots correct except right after skipped slots.
- **Cause:** wrong `numEmptySlots = block.Slot − parent.Slot − 1`, shifting every historical index.
- **Fix:** append exactly one parent root + one zero per empty slot; verify the count. **([ch 04](04-slots), [08](08-block-processing))**

### Mutating the parent state in place
- **Symptom:** a rejected block corrupts the store; state persists that shouldn't.
- **Cause:** running the transition on the stored state instead of a clone.
- **Fix:** clone in `blockprocessor`; persist only after phase 4 passes. **([ch 07](07-state-transition-pipeline), [13](13-gean-implementation))**

### A clock in the pure package
- **Symptom:** nondeterminism; two nodes disagree though inputs match; tests may still pass.
- **Cause:** a `time.Now()` (or randomness) inside `statetransition`.
- **Fix:** keep the package pure; put clock-dependent guards at the `blockprocessor` boundary. **([ch 07](07-state-transition-pipeline), [13](13-gean-implementation))**

## Attestation / finality

### Vote-matrix length mismatch
- **Symptom:** `JUSTIFICATION_VOTES_LENGTH_MISMATCH`; a block others accept, gean rejects (or vice versa).
- **Cause:** `len(JustificationsValidators) ≠ len(JustificationsRoots) × validatorCount` — often a
  **bitlist sentinel** error upstream (**[ch 06](06-ssz-foundations)**).
- **Fix:** enforce the length invariant; trace the bitlist that produced the wrong length. **([ch 09](09-attestation-processing))**

### "Won't finalize" that's actually liveness
- **Symptom:** head advances, `finalized_slot` stuck.
- **Cause:** votes/aggregates not arriving (missing proposer, over-budget aggregation, split votes) — not
  a tally bug.
- **Fix:** diff justification state across blocks; if it's flat, it's liveness, not phase-3 logic. **([ch 09](09-attestation-processing), [11](11-finality))**

### Expecting finalized to only increase
- **Symptom:** alarm when `finalized_slot` moves *down* after a reorg.
- **Cause:** gean's finalized is the *head chain's* view — reorg-mutable by design.
- **Fix:** none — it's correct; only escalate if two clients disagree on the finalized *root*. **([ch 11](11-finality))**

## Fork choice

### Arrival-order head (determinism bug)
- **Symptom:** two nodes, identical blocks and votes, **different heads**, permanently.
- **Cause:** equal-slot equivocation tie resolved by arrival/insertion order.
- **Fix:** break ties toward the **larger canonical data root**; keep max `(slot, root)` per validator. **([ch 12](12-fork-choice-vs-state-transition))**

### Prune without vote-index remap
- **Symptom:** fork-choice weights wrong after a finalization.
- **Cause:** the proto-array compacted on prune but stored vote indices weren't remapped.
- **Fix:** prune and remap as **one** operation. **([ch 11](11-finality), [12](12-fork-choice-vs-state-transition))**

## SSZ

### Hand-edited generated encoder
- **Symptom:** a subtle, byte-level root divergence that forks the network.
- **Cause:** someone edited a `*_encoding.go` file by hand.
- **Fix:** never hand-edit; change the struct + tags, run `make sszgen`. **([ch 06](06-ssz-foundations))**

### Field reorder / missing `mix_in_length`
- **Symptom:** serialized bytes match but roots differ.
- **Cause:** struct field order changed, or list-length not mixed into the root.
- **Fix:** preserve field order; regenerate; remember length is part of the commitment. **([ch 06](06-ssz-foundations))**

### Unhardened offset
- **Symptom:** a malformed peer blob decodes when it should be rejected.
- **Cause:** first offset `< 4` (or non-monotonic / out of scope) accepted.
- **Fix:** reject bad offsets up front (leanSpec #1177). **([ch 06](06-ssz-foundations))**

## Time model

### Un-anchored genesis (the "dead network")
- **Symptom:** all nodes up and peered, chain never advances (stuck at slot 0).
- **Cause:** genesis in the (sim or real) future — e.g. wall-clock genesis under Shadow's 2000-01-01 epoch.
- **Fix:** anchor genesis to the correct epoch. **([ch 05](05-time-model), [14](14-shadow-execution))**

### Work on the tick loop
- **Symptom:** duties fire late; tick-interval duration > 800 ms; attestations/proposals slip.
- **Cause:** heavy compute (proving/verifying) on the Engine's single-threaded loop.
- **Fix:** move it to a worker goroutine. **([ch 05](05-time-model), [13](13-gean-implementation))**

### Two-clocks confusion
- **Symptom:** an on-time message wrongly rejected, or a future message wrongly accepted.
- **Cause:** using wall-clock slot where the spec uses `store.time` (or vice versa); ignoring gossip
  disparity slack.
- **Fix:** acceptance uses `store.Time()` + `GossipDisparityIntervals`; duty scheduling uses wall-clock. **([ch 05](05-time-model))**

## Config / interop

### Committee/validator-count mismatch
- **Symptom:** `InvalidProposer` cross-client; nodes elect different proposers for the same slot.
- **Cause:** clients disagree on `num_validators` / committee count, so `slot % num_validators` differs.
- **Fix:** align the shared config across all clients. **([ch 08](08-block-processing), [15](15-debugging-playbook))**

## The shape → cause quick table

| Symptom | Most likely cause | Chapter |
|---------|-------------------|---------|
| every root wrong | deferred `state_root` | 04 |
| root wrong only after gaps | empty-slot off-by-one | 04/08 |
| bytes match, root differs | field order / `mix_in_length` | 06 |
| same inputs, different head | arrival-order tie-break | 12 |
| weights wrong after finality | prune without remap | 11/12 |
| head advances, finality stuck | liveness (votes not arriving) | 09/11 |
| network up, chain at slot 0 | un-anchored genesis | 05/14 |
| duties late, tick > 800ms | work on tick loop | 05/13 |
| `InvalidProposer` cross-client | validator-count mismatch | 08 |
| malformed blob accepted | unhardened SSZ offset | 06 |

## Mental models
- **Symptom is a fingerprint.** Each shape maps to a cause before you read code.
- **Most drift is in the edges** — malformed input, equivocation, far-future slots, empty slots.
- **"Consistent" vs "conditional" narrows it fast:** every-root-wrong ⇒ deferred root; only-after-gaps ⇒
  empty slots; only-under-equivocation ⇒ determinism.

## Cross references
- **[15 — Debugging playbook](15-debugging-playbook)** — the trees that localize these.
- **[16 — Case studies](16-case-studies)** — several of these shapes, worked in full.

---

### Key takeaways
- Bugs have **shapes**; the symptom alone often names the cause and the chapter.
- The highest-frequency shapes: **deferred `state_root`** (every root wrong), **empty-slot off-by-one**,
  **arrival-order head** (determinism), **prune without remap**, **un-anchored genesis**, **work on the
  tick loop**, **hand-edited SSZ**.
- "Consistent vs conditional" is your fastest first cut.

### Exercises
1. Cover the right column of the quick table and name the cause for each symptom.
2. For three shapes, state the one-line check that confirms the cause.

### Debugging exercise
- Given "roots are correct except right after multi-slot gaps," name the bug, the file, and the exact
  expression to inspect.

### Code-reading assignment
- Pick three shapes and find the gean code that *prevents* each (the guard or the invariant): e.g. the
  deferred-root fill in `slots.go`, the tie-break in `payloads.go`, the gap bound in `block.go`.

### Questions to verify understanding
- Why does "every root wrong, consistently" point at the deferred `state_root` specifically?
- Why is "same inputs, different head" impossible to explain with networking?
