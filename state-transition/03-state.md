# 3. The State

The state transition is a function `f(pre_state, block) → post_state`. You cannot reason about the
function without knowing its subject: the **State**. This chapter names every field, says what it is
*for*, and — the part that makes you a specialist — states for each field **what changes, what cannot,
and what invariant it upholds**. The `state_root` (phase 4 of the transition) is `hash_tree_root(State)`,
so every field here is part of the value the whole network must agree on byte-for-byte.

## The State container (gean)

From `internal/types/state.go`, the Lean Consensus state is compact — ten fields:

```go
type State struct {
    Config                   *ChainConfig  // chain parameters, fixed from genesis
    Slot                     uint64        // the slot this state is "at"
    LatestBlockHeader        *BlockHeader  // most recent header (deferred state_root)
    LatestJustified          *Checkpoint   // highest justified checkpoint
    LatestFinalized          *Checkpoint   // highest finalized checkpoint
    HistoricalBlockHashes    [][]byte      // one root per slot, incl. empty slots
    JustifiedSlots           []byte        // bitlist: which slots are justified
    Validators               []*Validator  // the validator registry (max 4096)
    JustificationsRoots      [][]byte      // target roots currently being voted on
    JustificationsValidators []byte        // bitlist: flat (root × validator) vote matrix
}
```

It mirrors `leanSpec/.../lstar/containers/state.py` field-for-field. Note how much is **finality
bookkeeping** — the last five fields exist to track what has been voted on and agreed. That is the
heart of a consensus state: it is mostly a ledger of *agreement*, not of *balances*.

## Field by field

### `Config` — the rules
Chain parameters agreed at genesis (genesis time, committee count, limits). **Cannot change** during
normal operation; every node must share it or they compute different transitions. Invariant: identical
across all honest nodes for the whole chain.

### `Slot` — the clock hand
The slot this state has been advanced to. **Changes** in phase 1 (`process_slots`) — monotonically
increasing, never backward. Invariant: `post.Slot == block.Slot` after a transition; `pre.Slot <
block.Slot` is required (a block cannot target a slot at or before its parent's).

### `LatestBlockHeader` — the parent link
The header of the most recently processed block. **Changes** in phase 2 (`process_block_header`) to the
new block's header. Its `state_root` is stored as **zero** and filled in on the *next* slot's
processing — the deferred-root subtlety (see **[chapter 06](06-ssz-foundations)** and
**[07](07-state-transition-pipeline)**). Invariant: a new block's `parent_root` must equal
`hash_tree_root(LatestBlockHeader)`; this is what chains blocks.

### `LatestJustified` / `LatestFinalized` — the finality anchors
The highest justified and finalized checkpoints (`{root, slot}`). **Change** in phase 3 as votes
accumulate. Invariants: forward-only progression *within a chain* (a higher-slot checkpoint replaces a
lower); the justified checkpoint descends from the finalized one; finalized is re-derived from the head
each fork-choice update and is **reorg-mutable** (it can move *down* on a reorg onto a chain that
finalized fewer slots — a subtlety that trips people; see **[chapter 11](11-finality)**).

### `HistoricalBlockHashes` — the per-slot history
One block root per slot, **including empty slots** (recorded as a zero root). **Grows** in phase 2:
appends the parent root plus one zero entry per skipped slot. Bounded by `HistoricalRootsLimit`
(262144) — the bound that lets gean reject a far-slot block before an unbounded walk. Invariant: length
tracks the slot height; index *i* is the root at slot *i* (or zero if empty).

### `JustifiedSlots` — the justified bitfield
A **bitlist** marking which slots are justified, relative to the finalized boundary. **Grows/updates**
in phase 3. Invariant: its length is extended to cover up to the block's slot; a set bit means "this
slot reached a justification supermajority."

### `Validators` — the registry
The validator set (each with proposer + attester XMSS public keys), max 4096. In Lean Consensus this is
largely **fixed from genesis** (no activation/exit churn like beacon chain). Invariant: index *i* is
validator *i* everywhere — proposer election (`slot % len`), attestation participation bits, and vote
accounting all key off this index. A registry of size 0 is now a **rejection**
(`EMPTY_VALIDATOR_REGISTRY`), not a no-op.

### `JustificationsRoots` + `JustificationsValidators` — the vote matrix
Together these track *who voted for what*. `JustificationsRoots` is the list of target roots currently
being tallied; `JustificationsValidators` is a **flat bitlist** segmented into one block of
`len(Validators)` bits per tracked root — bit `(i·validatorCount + v)` means "validator *v* voted for
root *i*". **Change** in phase 3 as attestations are processed. Invariants: no root is the zero hash
(`ZERO_HASH_JUSTIFICATION_ROOT`); the vote bitlist length equals exactly
`len(JustificationsRoots) × len(Validators)` (`JUSTIFICATION_VOTES_LENGTH_MISMATCH`) — a malformed
length means the matrix can't be interpreted and the block is rejected.

## What changes vs what cannot — at a glance

| Field | Changes in phase | Cannot change (invariant) |
|-------|------------------|---------------------------|
| `Config` | never | shared by all nodes, fixed at genesis |
| `Slot` | 1 | monotone, never backward |
| `LatestBlockHeader` | 2 | `parent_root` must match its root; state_root deferred |
| `HistoricalBlockHashes` | 2 | length tracks slot height; bounded by limit |
| `JustifiedSlots` | 3 | monotone justification, bitlist length covers slot |
| `Validators` | (genesis) | index stability; size ≥ 1 |
| `LatestJustified/Finalized` | 3 | justified descends from finalized; reorg-mutable |
| `JustificationsRoots/Validators` | 3 | no zero root; length = roots × validators |

## Why the state is *this* and not more

Notice what's absent: no balances, no EVM storage, no account trie. Lean Consensus is deliberately
minimal (PDF §1.3). The state is almost entirely **finality accounting** plus the minimal chain linkage
(slot, latest header, historical roots) needed to validate the next block. Fewer fields → fewer places
to diverge → safer multi-client agreement. When you debug a `state_root` mismatch, this short list *is*
your search space (**[chapter 15](15-debugging-playbook)**).

## Mental models
- **The state is a ledger of agreement, not of money.** Most fields track *who voted for what*.
- **Every field is part of the fingerprint.** `hash_tree_root(State)` folds all ten in, in order and by
  length — change any and the `state_root` changes.
- **Indices are identity.** Validator *i* is the same *i* in proposer election, participation bits, and
  the vote matrix. Index confusion is a whole bug class.

## Cross references
- **[07 — The state transition pipeline](07-state-transition-pipeline)** — how each field mutates,
  phase by phase.
- **[06 — SSZ foundations](06-ssz-foundations)** — how the state becomes a `state_root`.
- **[09 — Attestation processing](09-attestation-processing)** — the vote-matrix fields in action.
- **[11 — Finality](11-finality)** — the justified/finalized checkpoints.

## Further reading
- `lean_consensus.pdf` §4.1 *The System State*.
- gean: `internal/types/state.go`; leanSpec `containers/state.py`.

---

### Key takeaways
- The Lean Consensus **State** is ten compact fields, mostly **finality bookkeeping** plus chain
  linkage.
- Each field has an invariant; violating one is a rejection (`EMPTY_VALIDATOR_REGISTRY`,
  `ZERO_HASH_JUSTIFICATION_ROOT`, `JUSTIFICATION_VOTES_LENGTH_MISMATCH`).
- `state_root = hash_tree_root(State)` folds every field in **by order and length** — this short list is
  your entire `state_root`-mismatch search space.

### Exercises
1. For each of the ten fields, say which transition phase changes it (or "genesis/never").
2. Explain the `JustificationsValidators` layout: how do you find whether validator 5 voted for the 3rd
   tracked root?
3. Why does a size-0 validator registry now reject rather than no-op?

### Debugging exercise
- A `state_root` mismatch's byte-diff points at `HistoricalBlockHashes`. Which phase is implicated, and
  what's the most likely cause (hint: empty slots)?

### Code-reading assignment
- Open `internal/types/state.go` and `leanSpec/.../containers/state.py` side by side; confirm the
  field order matches (it must, or the roots differ).
- Find where `JustificationsValidators` is indexed in `internal/statetransition/` and confirm the
  `i*validatorCount + v` layout.

### Questions to verify understanding
- Why is field *order* in `State` part of the consensus commitment?
- Why does Lean Consensus keep the state so small, and what safety property does that buy?
