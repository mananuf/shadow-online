# 9. Attestation processing

This is **phase 3** of the state transition — where the chain *learns what has been agreed*. Phases 1
and 2 positioned the block; phase 3 applies its body. In Lean Consensus the only body operation is
**attestations** (votes), and processing them advances the justification and finalization bookkeeping
that fork choice and finality (**[chapter 11](11-finality)**) later read. This is the richest phase and
the one most entangled with SSZ (bitlists) and with the rejections you'll meet in production.

## Theory — a vote is a claim about three checkpoints (PDF §6.2)

An **attestation** carries `AttestationData` naming three checkpoints:

- **source** — the justified checkpoint the voter builds from,
- **target** — the checkpoint being voted *for* (the slot whose justification this vote supports),
- **head** — the block the voter currently considers canonical.

Read a vote as: *"anchoring at this justified **source**, I attest that **target** should be justified,
and I currently see **head** as the tip."* The `source → target → head` relationship must respect time
and topology: `source ≤ target ≤ head`, and each must be an ancestor of the next (**[chapter 15](15-debugging-playbook)**
covers the admission checks). Aggregating many such votes and counting them per target is how a slot
becomes justified.

## The vote matrix in state (recap of ch 03)

Phase 3 reads and writes two state fields together:

- `JustificationsRoots` — the list of **target roots** currently being tallied.
- `JustificationsValidators` — a **flat bitlist** segmented into one block of `validatorCount` bits per
  tracked root; bit `(i·validatorCount + v)` = "validator *v* voted for root *i*".

A block's attestations carry `aggregation_bits` (a **bitlist** over validator indices) plus the shared
`AttestationData`. Processing folds each aggregate's participants into the matrix for that target root.

## Specification — `process_attestations` (justification accounting)

The spec validates the state's justification structure, then applies each attestation:

1. **Structural validation** (the malformed-state guards, in order):
   - `EMPTY_VALIDATOR_REGISTRY` — a size-0 registry can't segment votes → reject.
   - `JUSTIFICATION_VOTES_LENGTH_MISMATCH` — `len(justifications_validators) ≠
     len(justifications_roots) × validator_count` → reject (the matrix is uninterpretable).
   - `ZERO_HASH_JUSTIFICATION_ROOT` — a tracked root is the zero hash → reject.
2. **Apply each attestation**: fold its participants into the matrix for its target; when a target's
   column reaches the supermajority, mark the slot justified in `JustifiedSlots` and advance
   `LatestJustified`; when justification advances far enough, advance `LatestFinalized`
   (**[chapter 11](11-finality)**).

There is also a per-block cap on distinct attestation data (`TOO_MANY_ATTESTATION_DATA`) and a check that
aggregation bits aren't empty (`EMPTY_AGGREGATION_BITS`).

## Gean implementation — `ProcessAttestations`

From `internal/statetransition/attestations.go`, the structural guards (which you'll recognize from the
spec-hardening work) come first, in spec order:

```go
validatorCount := int(state.NumValidators())
if validatorCount == 0 {
    return ErrEmptyValidatorRegistry                       // EMPTY_VALIDATOR_REGISTRY
}
if int(types.BitlistLen(state.JustificationsValidators)) !=
   len(state.JustificationsRoots)*validatorCount {
    return ErrJustificationVotesLengthMismatch             // JUSTIFICATION_VOTES_LENGTH_MISMATCH
}
for _, root := range state.JustificationsRoots {
    if types.IsZeroRoot(...) { return ErrZeroHashInJustificationRoots } // ZERO_HASH_JUSTIFICATION_ROOT
}

justifications := reconstructJustifications(state, validatorCount)   // matrix → map[root][]bool
// … fold each attestation's participants; advance justified/finalized …
serializeJustifications(state, justifications, validatorCount)       // map → matrix
```

Key implementation facts:

- **`reconstructJustifications`** (`justifications.go`) reads the flat bitlist into a
  `map[root][]bool` using the `i*validatorCount + v` layout, applies the votes, and
  **`serializeJustifications`** writes it back. This round-trip is where the length invariant matters:
  a mismatched bitlist length would read past or short of a segment — hence the up-front guard.
- **Bitlists everywhere**: the participants come from `aggregation_bits` (`BitlistGet`), the vote matrix
  is a bitlist, and `JustifiedSlots` is a bitlist. A wrong sentinel bit (**[chapter 06](06-ssz-foundations)**)
  cascades directly into `_LENGTH_MISMATCH` or wrong participation.
- **Deterministic accounting**: the same set of attestations must produce the same justification state
  on every node, independent of order — the finality analog of the fork-choice determinism in
  **[chapter 12](12-fork-choice-vs-state-transition)**.

### Spec → gean mapping

| leanSpec | gean | File | Role |
|----------|------|------|------|
| structural guards | `ErrEmptyValidatorRegistry` / `…LengthMismatch` / `…ZeroHash…` | `attestations.go` | Reject malformed state |
| read vote matrix | `reconstructJustifications` | `justifications.go` | Bitlist → `map[root][]bool` |
| apply + tally | fold participants; advance checkpoints | `attestations.go`, `finality.go` | Justify/finalize |
| write vote matrix | `serializeJustifications` | `justifications.go` | `map` → bitlist |
| attestation-data cap | `TooManyAttestationDataError` | `attestations.go` | `TOO_MANY_ATTESTATION_DATA` |

## What changes, what can't (phase 3)

- **Changes:** `JustificationsRoots`, `JustificationsValidators`, `JustifiedSlots`, `LatestJustified`,
  `LatestFinalized`.
- **Cannot change here:** the validator registry, the slot, the historical hashes (phase 1/2's job),
  `LatestBlockHeader`.
- **Invariants:** no zero justification root; `len(justifications_validators) = roots × validators`;
  justification/finalization advance forward within a chain; a validator's vote is counted once per
  target.

## Aggregation, briefly (PDF §6.4)

Individual votes are numerous, so **aggregators** (interval 2) batch votes sharing the same
`AttestationData` into an **aggregate attestation**: one `aggregation_bits` bitlist marking all
participants plus one combined **XMSS proof**. A block then carries these compact aggregates rather than
thousands of individual signatures. Aggregation is the slow, off-tick work modeled under Shadow — see
the Shadow guide's aggregation-cost material, and note the equal-slot equivocation determinism rule
(**[chapter 12](12-fork-choice-vs-state-transition)**) that keeps the *fork-choice* view of votes
order-independent.

## Shadow implications

Phase 3 is pure, but its *inputs* are the aggregates the network produced. Under Shadow, if aggregation
is over budget (slow prover), fewer aggregates land, so fewer votes reach the matrix, so justification
advances slower — a **liveness** effect visible as `finalized_slot` lagging even though blocks import
fine. That is the whole reason gean models aggregation cost: without it, Shadow would show unrealistic
finality. Distinguish "not finalizing because votes aren't arriving" (liveness/timing) from "not
finalizing because the tally is wrong" (phase-3 logic).

## Debugging techniques

```
finality not advancing / attestation-related rejection
        │
        ├─ EMPTY_VALIDATOR_REGISTRY            → state has 0 validators (malformed)
        ├─ JUSTIFICATION_VOTES_LENGTH_MISMATCH → bitlist length ≠ roots×validators;
        │                                         suspect a sentinel-bit / off-by-one (ch 06)
        ├─ ZERO_HASH_JUSTIFICATION_ROOT        → a tracked root is zero (malformed)
        ├─ TOO_MANY_ATTESTATION_DATA           → block exceeds the distinct-data cap
        └─ votes counted but no justification  → diff the matrix / JustifiedSlots across blocks;
                                                  are participants being folded into the right
                                                  target column? is quorum being reached on ONE branch?
```

The highest-value move for a "won't finalize" incident: **diff `JustificationsRoots` / `JustifiedSlots`
across a few consecutive post-states**. If they don't grow, the tally isn't advancing; if they grow but
never cross quorum, the votes are split across branches (a fork-choice/aggregation issue, not phase-3).

## Common mistakes
- **Reading the vote matrix with the wrong stride.** The layout is `i*validatorCount + v`; a wrong
  stride reads another root's column.
- **Ignoring the length invariant.** A bitlist whose length ≠ `roots × validators` must be rejected, not
  read best-effort.
- **Counting a validator twice per target.** Participation is set-membership per target, not additive.
- **Confusing liveness with logic.** "Not finalizing" is often votes-not-arriving (timing/aggregation),
  not a phase-3 bug.

## Mental models
- **Phase 3 is a tally clerk.** It reads the ballot matrix, adds each aggregate's participants to the
  right column, and declares a slot justified when a column crosses two-thirds.
- **Bitlists are the ballots.** Every "who voted" fact is a bitlist; the sentinel bit is its length, and
  its length is an invariant.
- **Justification is a ledger, finalization is a ratchet.** Justify advances per tally; finalize follows
  and (mostly) doesn't go back (**[chapter 11](11-finality)**).

## Cross references
- **[07 — The state transition pipeline](07-state-transition-pipeline)** — phase 3 in context.
- **[03 — The State](03-state)** — the vote-matrix fields.
- **[06 — SSZ foundations](06-ssz-foundations)** — bitlists, the sentinel bit, and the length invariant.
- **[11 — Finality](11-finality)** — how justification becomes finalization.
- **[12 — Fork choice vs state transition](12-fork-choice-vs-state-transition)** — how fork choice reads
  these votes.

## Further reading
- `lean_consensus.pdf` §6.2–6.4 (attestation data, lifecycle, aggregation), §6.5 (validity conditions).
- gean: `internal/statetransition/{attestations,justifications,finality}.go`.

---

### Key takeaways
- Phase 3 applies the block's **attestations** — votes over `source → target → head` — advancing the
  **justification/finalization** bookkeeping.
- It first enforces three structural guards in spec order: **empty-registry**, **vote-length mismatch**,
  **zero justification root**.
- The vote matrix is a **flat bitlist** with stride `validatorCount` per tracked root; the length
  invariant (`roots × validators`) is load-bearing and SSZ-sensitive.
- "Won't finalize" is often **liveness** (votes not arriving) rather than a phase-3 tally bug — diff the
  matrix to tell them apart.

### Exercises
1. Write the three structural guards in the order phase 3 checks them, with the gean error for each.
2. Given `JustificationsRoots` of length 3 and 8 validators, what is the exact length of
   `JustificationsValidators`? Where is validator 6's vote for the 2nd root?
3. Explain source/target/head for a vote in one sentence each.

### Debugging exercises
1. `finalized_slot` is stuck though blocks land every slot and attestations are produced. Walk the tree;
   is this phase-3 logic or liveness? How do you confirm?
2. gean rejects a block with `JUSTIFICATION_VOTES_LENGTH_MISMATCH` that others accept. Where do you look
   first (hint: not phase 3)?

### Code-reading assignment
- Read `internal/statetransition/attestations.go` guards, then `reconstructJustifications` /
  `serializeJustifications` in `justifications.go`. Confirm the `i*validatorCount + v` stride round-trips.

### Questions to verify understanding
- Why must the vote-matrix bitlist length exactly equal `roots × validators`, and what breaks if it
  doesn't?
- Why is a validator counted at most once per target, and how does the bitlist enforce that?
