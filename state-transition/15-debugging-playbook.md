# 15. The debugging playbook

This is the chapter you will reach for during a Devnet incident. Everything before it built the mental
model; this turns the model into **procedure**. The goal: given a symptom — a rejected block, a stalled
chain, a `state_root` mismatch, a node that won't finalize — walk a decision tree to the exact function
and field that diverged, across leanSpec, gean, and Shadow, and compare against the other clients.

The organizing principle: **consensus failures are not random. Each has a shape.** Learn the shapes and
the decision trees, and diagnosis becomes mechanical.

## The debugger's toolkit

| Tool | What it gives you | Where |
|------|-------------------|-------|
| **gean logs** | Per-tick, per-block, per-attestation events | stderr (strip ANSI) |
| **`state_root` diff** | Which post-state field diverged | serialize + byte-diff |
| **fork-choice snapshot** | head/justified/finalized roots + slots | `[forkchoice] head …` log |
| **Metrics** | tick duration, proc_time, agg time, reorgs | `/metrics` (Prometheus) |
| **Deterministic replay** | Reproduce the exact failure | Shadow seed / fixture |
| **Cross-client logs** | What ethlambda/zeam/lantern did | side-by-side |
| **Spec fixtures** | The authoritative expected behavior | `make test-spec` |

### Reading gean logs

gean logs one structured line per significant event. Learn these four by heart:

```
[chain]     block slot=226 block_root=0x233d… proposer=1 attestations=1 \
            justified_slot=223 finalized_slot=220 proc_time=34ms     ← a transition SUCCEEDED
[forkchoice] head slot=226 head_root=0x233d… justified_slot=223 \
            finalized_slot=220 finalized_root=0x2fe5…               ← the head moved
[network]   peer connected peer_id=16Uiu… direction=Inbound peers=2  ← peering
[chain]     rejecting … / block processing failed slot=… : <reason>  ← a transition REJECTED
```

A single `[chain] block …` line already tells you: the transition passed phase 4 (it logged), the
proposer, how many attestations, how far justification/finality reached, and the wall cost. Its
*absence* for a slot you expected is itself a signal.

## Master decision tree: "a block was rejected"

This is the canonical incident. gean logged `block processing failed slot=N … : <reason>`.

```
Block rejected
        │
        ├─ Was the parent known?
        │     └─ No  → NOT a transition bug. It's import ordering / sync.
        │              • Is the block buffered as pending? (out-of-order gossip)
        │              • Is BlocksByRange backfill fetching the parent?
        │              • Check gossip: did the parent's block message arrive at all?
        │              → resolve parent availability, block re-imports automatically
        │
        ├─ Was it pre-finalized?  (block.slot < finalized_slot)
        │     └─ Yes → correct rejection. A stale block below the finalized cut.
        │
        ├─ Beyond the future horizon?  (BLOCK_TOO_FAR_IN_FUTURE)
        │     └─ Yes → the block's slot leads store.Time()/IntervalsPerSlot by >1.
        │              Clock issue: is this node behind? is genesis anchored?
        │
        ├─ Signature verification failed?
        │     └─ Yes → XMSS/proof problem, NOT state logic.
        │              • Wrong proposer key? key manifest mismatch?
        │              • Compare against a client that accepted it — is the block valid?
        │
        └─ State transition failed?  (the interesting case)
              → drop into the "state_root mismatch" tree below
```

The first branch is the most common false alarm: a "rejected" block whose only problem is that its
**parent hadn't arrived yet**. Always check parent availability before suspecting the transition.

## Decision tree: "state_root mismatch"

The transition ran but phase 4 failed — your post-state disagrees with the block's claim (and with the
clients that accepted it).

```
state_root mismatch
        │
   Serialize YOUR post-state and a peer's accepted post-state. Byte-diff them.
        │
        ├─ First diff in a FIXED field (slot, a checkpoint, a count)
        │     → transition-LOGIC bug. Which field?
        │        • state.slot wrong          → phase 1 (process_slots), ch 04
        │        • latest_block_header wrong → phase 2 (header), remember the
        │                                       DEFERRED state_root fill
        │        • justifications_* wrong    → phase 3 (attestations), ch 09
        │
        ├─ First diff in an OFFSET / a list length
        │     → SSZ/length bug (ch 06): a variable field has the wrong element
        │        count; suspect a bitlist sentinel or an off-by-one
        │
        └─ Bytes identical but ROOT differs
              → merkleization bug (ch 06): field order, missing mix_in_length,
                 or wrong padding
```

**The single most useful action in all of consensus debugging** is the byte-diff of the two serialized
states. It converts an opaque 32-byte mismatch into a named field, which names the phase, which names
the function.

## Decision tree: "the chain won't finalize / justify"

Head advances but `finalized_slot` (or `justified_slot`) is stuck.

```
finality stalled
        │
        ├─ Are blocks even landing every slot?
        │     └─ No → empty slots. Who's the missing proposer?
        │              • one validator down → its slots are empty (may still finalize
        │                with a 2/3 supermajority of the others)
        │              • many missing → liveness/networking problem, not finality logic
        │
        ├─ Are attestations being produced AND aggregated?
        │     └─ Check [chain] ProduceAttestation and aggregation logs.
        │        • no attestations → duty/timing (ch 05) or gating (DutyGate)
        │        • attestations but no aggregates → aggregator down / over budget
        │
        ├─ Are votes reaching quorum on ONE branch?
        │     └─ Equivocation or a split view can strand weight on two branches.
        │        Check for a deterministic tie-break (equal-slot votes → larger
        │        canonical data root). Compare heads across clients.
        │
        └─ Is justification bookkeeping advancing in the post-state?
              → diff justifications_roots / justified_slots across a few blocks;
                if they don't grow, phase 3 (ch 09) isn't accounting votes
```

## Decision tree: "nodes disagree on head" (a fork)

Two honest nodes pick different heads and stay split.

```
head divergence
        │
        ├─ Same finalized root?  → No → someone finalized off a losing fork;
        │                                 escalate — this is a safety-adjacent event
        │
        ├─ Same set of blocks + votes?
        │     └─ No → propagation gap. A block/attestation didn't reach one node.
        │              Check gossip + BlocksByRange.
        │
        └─ Same blocks + votes but different head?
              → fork-choice determinism bug. The head must be a PURE function of
                store contents. Suspect:
                • equal-slot equivocation tie not broken by canonical root
                • vote-weight applied in arrival order
                → compare the latest-vote extraction across nodes for one validator
```

The tell for a determinism bug: **same inputs, different output**. Fork choice must be order-independent;
if two nodes with identical blocks and votes disagree, the bug is in how votes are reduced to a head,
not in the network.

## Layer-specific techniques

### Debugging leanSpec (the oracle)

- The spec is executable Python. To learn the *expected* behavior, run the spec's own tests or read the
  function directly — it is short and authoritative.
- gean's `make test-spec` runs gean against **fixtures generated from the spec**. A failing vector is
  the spec telling you precisely which input gean mishandles. Read the fixture: it has the pre-state,
  the block/step, and the expected result (accept, or a specific `rejectionReason`).
- When gean and the spec disagree, **the spec wins** — fix gean.

### Debugging gean (Go)

- **Reproduce with a unit or fixture test first.** A failing `go test ./internal/statetransition/…`
  or `make test-spec` vector is a deterministic, breakpoint-friendly reproduction.
- **Trace state changes** by diffing the state before/after each phase (the four phases of ch 07 are
  natural breakpoints).
- **Respect the concurrency model**: the transition is pure and single-threaded within a block; the
  Engine is single-threaded over the tick loop; verification runs on worker goroutines. A "flaky" bug
  is often a store access from a worker that isn't synchronized — check ownership, not logic.
- **Metrics** (`proc_time`, tick duration, agg time) localize *performance* regressions that manifest
  as timing failures (ch 05).

### Debugging Shadow (the lab)

- Shadow gives you **deterministic replay**: same seed → same run. A bug seen in Shadow is
  reproducible, unlike a live Devnet.
- "Nothing happens" in Shadow is usually a **clock** bug (un-anchored genesis, ch 05), not a consensus
  bug — check that slots advance before suspecting logic.
- Shadow doesn't charge CPU, so *timing* observed there reflects the **modeled** prover cost, not real
  hardware. Confirm real-hardware timing on a devnet before concluding.

### Cross-client comparison (ethlambda / zeam / lantern)

This is your strongest oracle for interop bugs. When gean rejects a block others accept (or vice
versa):

1. Line up the three clients' logs at the **same slot** (they share a wall clock in a run).
2. Find the one that behaves differently. If gean is the outlier and the spec agrees with the others,
   gean drifted.
3. Get the exact object (block/attestation) both saw, and replay it through gean's transition in a test.
4. The byte-diff of the two post-states (above) names the field.

> A block one client produces that another rejects is *the* interop bug the whole simulation exists to
> catch. Treat any single-client outlier as guilty until the spec says otherwise.

## A worked example (shape of a real session)

Symptom: on a 3-client run, gean's `finalized_slot` trails ethlambda's by several slots.

1. **Logs:** gean's `[chain] block …` lines appear every slot except those where proposer=0. →
   *one proposer's blocks are missing.*
2. **Cross-check:** the proposer-0 client (zeam) stopped logging after slot 9. → *zeam died; not a gean
   bug.*
3. **Confirm gean is healthy:** gean's head and finalized roots match ethlambda's at shared slots
   (byte-identical). → *gean is finalizing correctly on the 2/3 that remain.*
4. **Conclusion:** liveness issue in a *peer*, gean correct. The `state_root`/head agreement across
   clients was the decisive evidence.

Notice the method: logs → cross-client → root agreement. No guessing.

## Common mistakes (in debugging itself)

- **Suspecting the transition first.** Most "rejections" are parent-availability or clock issues. Walk
  the master tree from the top.
- **Trusting one client's view.** A single node's logs can't tell you who's right; line up the others.
- **Skipping the byte-diff.** Staring at two 32-byte roots tells you nothing; diff the serialized
  states.
- **Confusing Shadow timing with real timing.** Shadow timing is modeled; verify on hardware.
- **Ignoring the deferred `state_root`.** A "wrong root every time" bug is often this, not the logic.

## Mental models

- **Symptom → shape → tree → field.** Every failure has a shape; the shape selects a decision tree; the
  tree ends at a field; the field names the function.
- **The spec is the oracle, cross-clients are the witnesses, the byte-diff is the evidence.**
- **Determinism is a debugging superpower.** Pure functions and seeded runs mean every real bug is
  reproducible — if you can't reproduce it, you haven't localized it.

## Cross references

- **[07 — The state transition pipeline](07-state-transition-pipeline)** — the four phases the trees
  bisect.
- **[06 — SSZ foundations](06-ssz-foundations)** — the byte-diff and root-mismatch mechanics.
- **[05 — The time model](05-time-model)** — clock/timing failure shapes.
- **[09 — Attestation processing](09-attestation-processing)** — justification bookkeeping.
- **[12 — Fork choice vs state transition](12-fork-choice-vs-state-transition)** — why a head-divergence
  bug is not a transition bug.
- **[16 — Case studies](16-case-studies)** & **[17 — Common bugs](17-common-bugs)** — the shapes,
  worked in full.

## Further reading

- gean: `internal/blockprocessor/process.go` (rejection reasons), `internal/statetransition/` (the four
  phases), `internal/forkchoice/` (head determinism), `internal/node/{tick,head}.go` (scheduling).
- `make test-spec` fixtures — the authoritative expected behavior.

---

### Key takeaways
- Failures have **shapes**; each shape has a **decision tree** that ends at a field.
- The **master tree** for a rejected block checks parent availability and clock **before** the
  transition — most "rejections" aren't transition bugs.
- The **byte-diff of two serialized post-states** is the single highest-leverage action; it names the
  divergent field, hence the phase, hence the function.
- The **spec is the oracle**, **cross-client logs are the witnesses**, **determinism** makes every real
  bug reproducible.

### Exercises
1. From memory, draw the master "block rejected" tree down to the four leaf causes.
2. For a `state_root` mismatch, list the three byte-diff outcomes and the bug class each implies.

### Debugging exercises
1. gean logs `block processing failed slot=118 … parent state not found`. Walk the tree — is this a
   transition bug? What are your next three checks?
2. Two gean nodes with identical blocks and votes report different heads. Name the bug class and the
   one comparison that confirms it.
3. `finalized_slot` is stuck at 36 while head is 44 and blocks land every slot. Walk the finality tree;
   what's your leading hypothesis and how do you confirm it?

### Code-reading assignment
- In `internal/blockprocessor/process.go`, list every early-return rejection and map each to a branch of
  the master tree.
- In `internal/forkchoice/`, find where per-validator latest votes are reduced and confirm the reduction
  is order-independent (the head-determinism property).

### Questions to verify understanding
- Why is "same inputs, different head" always a determinism bug and never a networking bug?
- Why is the spec the oracle even when all other clients agree with each other but disagree with it?
- Why does the byte-diff of two states beat staring at their roots?
