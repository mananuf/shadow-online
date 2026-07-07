# 7. The state transition pipeline

This is the spine of the whole curriculum. Everything before it (state, slots, time, SSZ) exists
to make this chapter possible; everything after it (finality, fork choice, debugging) is a
consequence of it. If you understand exactly what happens between a validated block arriving and a
new `state_root` being confirmed, you understand consensus.

> **One-sentence definition.** The state transition function is a *pure* function
> `f(pre_state, block) → post_state` that every honest node computes identically, so that a block's
> committed `state_root` is a single value the whole network agrees on.

## Theory — why a *pure, deterministic* function

A blockchain is a **replicated state machine** (PDF §1). Every node holds the same state and applies
the same inputs in the same order, so they converge on the same result. The state transition function
is that "apply." Three properties make it load-bearing:

- **Pure.** No wall clock, no randomness, no network, no disk — output depends *only* on
  `(pre_state, block)`. If it read the wall clock, two nodes running it at different times would get
  different answers and the network would fork.
- **Deterministic.** Same inputs → same bytes out, on every architecture, every client. This is why
  gean, ethlambda, and zeam can interoperate: they are independent implementations of *one* function.
- **Self-certifying.** The function ends by comparing the state it computed against the `state_root`
  the block *claims*. If they differ, the block is rejected. The block author cannot lie about the
  result of the computation, because you re-run it.

That last point is the whole game. A block is a **claim**: "apply me to my parent's state and you get
a state whose root is `X`." The transition function is you *checking the claim* by recomputing it.

## The four phases

Both the spec and gean structure the function as four phases, in this exact order:

```
                    ┌─────────────────────────────────────────────────────┐
   pre_state  ───►  │  1. process_slots      advance the clock to block.slot │
   (parent's        │  2. process_block_header  bind block to its parent      │
    post-state)     │  3. process_operations    apply attestations / votes    │
                    │  4. verify state_root     recomputed root == claimed?    │
                    └─────────────────────────────────────────────────────┘
                                          │
                                          ▼
                              post_state   (only if phase 4 passes)
```

Order is not cosmetic. Header validation (2) assumes the state is already at the block's slot (1).
Operation processing (3) assumes the header is bound (2). Root verification (4) can only run once all
mutations are done (3). Reorder them and the function is wrong.

### Phase 1 — Slot processing

Bring the pre-state's clock *up to* the block's slot, materializing every empty slot in between. A
block at slot 10 with a parent at slot 7 means slots 8 and 9 were skipped (no block proposed), and the
state must record that. See **[chapter 04](04-slots)** for the full treatment; the key output is
`state.slot == block.slot`, with the empty slots reflected in the historical hashes.

### Phase 2 — Header validation

Bind the block to its parent and to the chain's rules **before** trusting its body:

- the proposer is the one the slot's round-robin elects (`slot % num_validators`),
- the block's `parent_root` is the hash of the current `latest_block_header`,
- the block is newer than the latest header,
- record the block header into the state as the new `latest_block_header` (with an empty `state_root`,
  filled in on the *next* transition — a subtlety SSZ makes necessary; see below).

### Phase 3 — Operation processing (attestations)

Apply the block body's votes. In Lean Consensus the only operation is **attestations**: each is a vote
with a source/target/head, and processing them advances the state's justification and finalization
bookkeeping. This is where the chain *learns what has been agreed*. Covered in depth in
**[chapter 09](09-attestation-processing)**.

### Phase 4 — State root verification

Compute `hash_tree_root(state)` and compare it to `block.state_root`. Equal → accept the post-state.
Unequal → reject the whole block; **nothing is persisted**. This is the self-certification step, and
it is why SSZ (**[chapter 06](06-ssz-foundations)**) is inseparable from the state transition: the
"root" is an SSZ merkleization, so a serialization bug and a transition bug produce the *same symptom*
— a `state_root` mismatch.

## Specification — `leanSpec` (`lstar`)

The spec's entry point (`leanSpec/src/lean_spec/spec/forks/lstar/state_transition.py`) reads, in
essence:

```python
def state_transition(state, signed_block, valid_signatures=True):
    block = signed_block.message
    process_slots(state, block.slot)          # phase 1
    process_block(state, block)               # phases 2 + 3
    assert block.state_root == hash_tree_root(state)   # phase 4
    return state
```

`process_block` in turn calls `process_block_header(state, block)` then processes the body's
attestations. Read these four functions until the control flow is muscle memory — they are small, and
they are the contract every client implements.

Two spec subtleties that trip everyone up:

- **The deferred `state_root`.** When phase 2 records the block header, it stores it with a *zero*
  `state_root`. The real root is only known *after* the transition finishes — a header cannot contain
  the root of a state that includes the header. So the root of slot N's header is filled in during
  slot N+1's `process_slots`. Miss this and every root you compute is wrong.
- **`process_slots` runs even with no block.** Advancing the clock across empty slots is a state
  mutation (it updates historical roots and can move justification), independent of whether a block
  lands.

## Gean implementation

gean mirrors the spec's shape one-to-one. The composition lives in
`internal/statetransition/transition.go`:

```go
func StateTransition(state *types.State, block *types.Block) error {
    if err := ProcessSlots(state, block.Slot); err != nil {   // phase 1
        return err
    }
    if err := ProcessBlockHeader(state, block); err != nil {   // phase 2
        return err
    }
    if err := ProcessAttestations(state, block.Body.Attestations); err != nil { // phase 3
        return err
    }
    return VerifyStateRoot(state, block)                        // phase 4
}
```

The package is **pure** — it imports no clock, no p2p, no store. That purity is the architectural
expression of the spec's "no wall clock" rule. The impure world (fetching the parent state,
persisting the result, timing the phases for metrics) lives one layer out, in
`internal/blockprocessor/`, which clones the parent state, calls into `statetransition`, and only
persists if phase 4 passes.

### Spec → gean mapping

| leanSpec (`lstar`) | gean (Go) | File | Responsibility |
|--------------------|-----------|------|----------------|
| `state_transition` | `StateTransition` | `statetransition/transition.go` | Compose the four phases |
| `process_slots` | `ProcessSlots` | `statetransition/slots.go` | Advance clock to `block.slot` |
| `process_block_header` | `ProcessBlockHeader` | `statetransition/block.go` | Bind block to parent; record header |
| `process_operations` (attestations) | `ProcessAttestations` | `statetransition/attestations.go` | Apply votes; justification/finality |
| `assert state_root == hash_tree_root(state)` | `VerifyStateRoot` | `statetransition/transition.go` | Self-certify |
| — (I/O boundary) | `onBlockCore` | `blockprocessor/process.go` | Clone → transition → persist |

### Why the translation is correct

- **Same order, same boundaries.** gean does not fuse or reorder phases; each spec function has one
  gean function, so an auditor can diff them.
- **Purity preserved.** The wall clock the spec forbids is *physically absent* from the package — it
  cannot leak in. The store clock a block is checked against lives in `blockprocessor`, at the
  untrusted-input boundary, not in the pure math.
- **Fail-closed.** Any phase returning an error aborts the transition and the caller persists nothing,
  matching the spec's `assert`/raise semantics.

### The one architectural difference worth knowing

The spec's `process_slots` contains an explicit per-slot loop. gean's `ProcessSlots` sets
`state.Slot = targetSlot` in **O(1)** and materializes the skipped slots' historical hashes inside
`ProcessBlockHeader` instead — bounded up front by a `HistoricalRootsLimit` check so a far-slot block
can't force an unbounded walk. The *observable result* (the post-state, and thus the `state_root`) is
identical; only the internal factoring differs. This is the model for every gean/spec difference: the
**bytes out must match**, the code path need not.

## Shadow implications

Under Shadow the transition function is **unchanged** — it is pure, so virtual time is invisible to it.
What changes is *around* it:

- **Cost.** XMSS signature verification (the gate before the transition) is genuinely slow. Shadow
  doesn't charge CPU, so gean models that cost as a virtual-time sleep (see the Shadow guide). The
  transition math itself is cheap and unmodeled.
- **Observation.** gean logs one line per transition:
  `[chain] block slot=… proc_time=… justified_slot=… finalized_slot=…`. In a Shadow run this is your
  primary evidence that phase 4 passed and how far justification advanced.
- **Determinism as a test oracle.** Because the function is deterministic, a Shadow run with a fixed
  seed reproduces the exact same states — which is what makes a `state_root` divergence between two
  clients a *reproducible* bug, not a heisenbug.

## Debugging techniques

A `state_root` mismatch is the transition's way of saying "we disagree about the post-state." Bisect
*which phase* diverged:

```
state_root mismatch (phase 4 failed)
        │
        ├─ Did phase 1 land the right slot?  → compare state.slot to block.slot,
        │                                       check empty-slot historical hashes
        ├─ Did phase 2 bind the right parent? → compare latest_block_header,
        │                                       remember the DEFERRED state_root fill
        ├─ Did phase 3 apply votes the same?  → diff justifications_roots / justified_slots
        │                                       between your post-state and a peer's
        └─ Is it actually an SSZ bug?          → serialize both states, diff the bytes;
                                                 a field ordering / length-prefix error
                                                 mimics a transition bug (see ch 06)
```

The highest-leverage move: **serialize the full pre-state and post-state and diff them field by
field** against a client that accepted the block (ethlambda/zeam). The first differing field names
the guilty phase.

## Common mistakes

- **Forgetting the deferred `state_root`.** Filling the header's root in the *same* transition instead
  of the next one. Symptom: every root is wrong, consistently.
- **Mutating the parent state in place.** The transition must run on a *clone*; if phase 4 fails you
  must be able to discard everything. gean clones in `blockprocessor`; never mutate a stored state.
- **Letting a clock into the pure package.** Any `time.Now()` in `statetransition` is a determinism
  bug even if tests pass. The future-horizon check belongs at the `blockprocessor` boundary.
- **Skipping phases on an empty block.** A block with no attestations still runs phases 1, 2, 4. Empty
  body ≠ no transition.
- **Persisting before phase 4.** Any state written before the root check can corrupt the store on a
  bad block.

## Mental models

- **The transition is a referee, not a player.** It does not *decide* anything; it *checks* the
  proposer's claim by recomputation. The proposer plays; you referee.
- **Pre-state → post-state is a photograph, not a video.** The function maps one snapshot to the next.
  The "video" (the chain over time) is many transitions chained by `parent_root`.
- **`state_root` is a fingerprint.** Two states with the same root are the same state; a one-bit
  difference anywhere changes the fingerprint completely. That is what lets a 32-byte value certify a
  whole state.

## Cross references

- **[04 — Slots & slot processing](04-slots)** — phase 1 in full.
- **[06 — SSZ foundations](06-ssz-foundations)** — how phase 4's root is computed; why serialization
  bugs masquerade as transition bugs.
- **[08 — Block processing](08-block-processing)** — phase 2 in full.
- **[09 — Attestation processing](09-attestation-processing)** — phase 3 in full.
- **[12 — Fork choice vs state transition](12-fork-choice-vs-state-transition)** — why this function
  is *not* fork choice, and where the boundary sits.
- **[15 — Debugging playbook](15-debugging-playbook)** — the full `state_root`-mismatch decision tree.

## Further reading

- `lean_consensus.pdf` §4 *The State Transition Function* (esp. §4.3 the transition pipeline).
- `leanSpec/.../lstar/state_transition.py`, `block.py`.
- gean: `internal/statetransition/{transition,slots,block,attestations}.go`.

---

### Key takeaways
- The state transition is a **pure, deterministic, self-certifying** function `f(pre, block) → post`.
- Four phases, in order: **process_slots → process_block_header → process_operations → verify
  state_root**. Order is load-bearing.
- Phase 4 (`state_root` check) is the whole point: it turns "my code ran" into "my code computed the
  one state everyone agrees on."
- gean mirrors the spec's shape function-for-function; differences (e.g. O(1) slot processing) are
  allowed only when the **output bytes are identical**.

### Exercises
1. Write the four phases from memory, then annotate each with the one gean function that implements it.
2. Explain, in two sentences, why phase 2 stores a *zero* `state_root` in the header.
3. A block has an empty body (no attestations). List every phase that still runs and what each does.

### Debugging exercises
1. You get `state_root` mismatch on a block ethlambda accepted. Write the sequence of diffs you'd run,
   in order, to localize the phase.
2. Given only the log line `[chain] block slot=42 … justified_slot=39 finalized_slot=36 proc_time=41ms`,
   state three things you can already conclude about the transition.

### Code-reading assignment
- Read `internal/statetransition/transition.go` top to bottom, then open the four functions it calls.
  For each, find the `leanSpec` function it mirrors and confirm the phase order matches.
- Find where in gean a block's state is *cloned* before the transition, and where it is *persisted*
  after. Explain why persistence must come strictly after phase 4.

### Questions to verify understanding
- Why must the state transition function be free of any wall-clock read?
- Two independent clients produce different `state_root`s for the same block. Is this necessarily a
  transition bug? What else could it be, and how would you tell?
- Why can gean legitimately use an O(1) `ProcessSlots` when the spec shows a per-slot loop?
