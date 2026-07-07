# 19. Cheat sheet

One page. Everything you reach for repeatedly, condensed. Print it, pin it, stop looking things up.

## The four phases

```
StateTransition(pre_state, block) → post_state
  1. ProcessSlots(state, block.Slot)        advance clock; fill DEFERRED state_root
  2. ProcessBlockHeader(state, block)        proposer? parent? newer? record header (zero root)
  3. ProcessAttestations(state, body)        tally votes → justify/finalize
  4. VerifyStateRoot(state, block)           hash_tree_root(state) == block.state_root ?
```
Order is load-bearing. Persist **only** after phase 4. Run on a **clone**. ([ch 07](07-state-transition-pipeline))

## The State (10 fields) — `internal/types/state.go`

| Field | Changes in | Invariant |
|-------|-----------|-----------|
| `Config` | genesis | shared by all nodes |
| `Slot` | 1 | monotone |
| `LatestBlockHeader` | 2 | `parent_root == hash(it)`; state_root deferred |
| `HistoricalBlockHashes` | 2 | index = slot; ≤ `HistoricalRootsLimit` |
| `JustifiedSlots` (bitlist) | 3 | length covers block slot |
| `Validators` (≤4096) | genesis | index stability; size ≥ 1 |
| `LatestJustified` | 3 | descends from finalized |
| `LatestFinalized` | 3 | head-chain view; **reorg-mutable** |
| `JustificationsRoots` | 3 | no zero root |
| `JustificationsValidators` (bitlist) | 3 | len = roots × validators |

## Time model — `internal/types/constants.go`

```
SecondsPerSlot=4   IntervalsPerSlot=5   MillisecondsPerInterval=800
GossipDisparityIntervals=1   SyncToleranceSlots=2   JustificationLookbackSlots=3
slot = (now − genesis) / 4s          currentSlot(store) = store.Time() / IntervalsPerSlot
```

**Intervals (`internal/node/tick.go`):** 0 propose+updateHead · 1 attest · 2 aggregate · 3 safe-target ·
4 updateHead. Two clocks: **wall-clock** schedules duties, **`store.time`** gates acceptance. Keep heavy
work **off the tick loop**. ([ch 05](05-time-model))

## SSZ — two outputs, never confuse

- **Serialize** → wire bytes (fixed part + 4-byte offsets → variable part). `state_root` is **not** this.
- **`hash_tree_root`** → 32-byte commitment: chunk → pad → tree → **mix_in_length** (lists/bitlists).
  Commits to **field order** and **length**.
- **Bitlist** = bits + **sentinel bit** (marks length). `BitlistLen/Get` in `internal/types/bitlist.go`.
- **Offsets** are the only attacker-influenced numbers → harden: first offset ≥ 4, monotonic, in-scope
  (#1177).
- **Never hand-edit `*_encoding.go`** → change struct+tags, `make sszgen`. ([ch 06](06-ssz-foundations))

## Rejection reasons ↔ gean

| leanSpec reason | gean | Where |
|-----------------|------|-------|
| `BLOCK_TOO_FAR_IN_FUTURE` | `ErrBlockTooFarInFuture` | `blockprocessor/process.go` (`slot > store.Time()/5 + 1`) |
| `BLOCK_SLOT_GAP_TOO_LARGE` | `SlotGapTooLargeError` | `statetransition/block.go` |
| `HEAD_NOT_DESCENDANT_OF_FINALIZED` | `ErrHeadNotDescendantOfFinalized` | `attestation/validate.go` |
| `EMPTY_VALIDATOR_REGISTRY` | `ErrEmptyValidatorRegistry` | `statetransition/attestations.go` |
| `JUSTIFICATION_VOTES_LENGTH_MISMATCH` | `ErrJustificationVotesLengthMismatch` | `statetransition/attestations.go` |
| `ZERO_HASH_JUSTIFICATION_ROOT` | `ErrZeroHashInJustificationRoots` | `statetransition/attestations.go` |
| `TOO_MANY_ATTESTATION_DATA` | `TooManyAttestationDataError` | `statetransition/attestations.go` |
| invalid proposer / parent | `InvalidProposerError` / `InvalidParentError` | `statetransition/block.go` |

## Spec → gean file map

| Concept | leanSpec (`lstar`) | gean |
|---------|--------------------|------|
| transition | `state_transition.py` | `internal/statetransition/transition.go` |
| slots | `process_slots` | `statetransition/slots.go` |
| header | `process_block_header` | `statetransition/block.go` |
| attestations | `process_operations` | `statetransition/attestations.go` |
| fork choice | `fork_choice.py` | `internal/forkchoice/` |
| latest votes | `_extract_attestations_…` | `store/payloads.go` (max slot,root) |
| state container | `containers/state.py` | `internal/types/state.go` |
| SSZ | `ssz/` | `internal/types/*_encoding.go` (generated) |
| block import boundary | `on_block` | `internal/blockprocessor/process.go` |
| clock | `on_tick` | `internal/node/tick.go`, `internal/store/tick.go` |

## Debugging — the trees, condensed

```
BLOCK REJECTED → parent known? (no ⇒ import/sync) → pre-finalized? → future-horizon?
                 → sig? → else state_root mismatch ↓
STATE_ROOT MISMATCH → serialize both states, BYTE-DIFF:
                 fixed field ⇒ transition logic (which field ⇒ which phase)
                 offset/length ⇒ SSZ length/bitlist
                 bytes match, root differs ⇒ merkleization (order / mix_in_length)
FINALITY STALLED → blocks landing? votes+aggregates? quorum on ONE branch? matrix growing?
                 (usually LIVENESS, not tally logic)
HEAD DIVERGENCE → same finalized root? same blocks+votes? → if same inputs diff head ⇒ DETERMINISM bug
```
Strongest evidence: **byte-diff of two post-states** + **root agreement across clients**. ([ch 15](15-debugging-playbook))

## Symptom → cause

| Symptom | Cause | Ch |
|---------|-------|----|
| every root wrong | deferred `state_root` | 04 |
| root wrong after gaps | empty-slot off-by-one | 04/08 |
| bytes match, root differs | field order / mix_in_length | 06 |
| same inputs, diff head | arrival-order tie-break | 12 |
| weights wrong after finality | prune w/o remap | 11/12 |
| head up, finality stuck | liveness (votes not arriving) | 09/11 |
| network up, chain at slot 0 | un-anchored genesis | 05/14 |
| duties late, tick>800ms | work on tick loop | 05/13 |
| `InvalidProposer` cross-client | validator-count mismatch | 08 |
| malformed blob accepted | unhardened SSZ offset | 06 |

## Shadow

Runs the **real binary** in **deterministic virtual time**; changes observation, not logic. Doesn't
charge CPU → gean models XMSS cost as **default-off, off-loop** sleeps (`--shadow-xmss-*`,
`internal/shadow`). "Dead network" ⇒ genesis/clock. Confirm real timing on a **devnet**. ([ch 14](14-shadow-execution))

## Commands

```bash
make build            # FFI (Rust) then Go — required before any go test touching xmss
make test             # unit tests (excludes xmss/spectests/cmd)
make test-ffi         # xmss FFI tests
make test-spec        # spec fixtures (pins leanSpec, generates + runs vectors)
make lint             # go vet + cargo fmt --check + cargo clippy -D warnings
make sszgen           # regenerate *_encoding.go after changing SSZ types
go test ./internal/statetransition/ -run TestName -count=1
go test ./internal/spectests/ -run TestName -tags=spectests -count=1
```

## Invariants you never break
- Persist only after phase 4; run the transition on a **clone**.
- `statetransition` is **pure** — no clock, no I/O, no randomness.
- Deferred `state_root` filled on the **next** slot.
- **Prune + vote-index remap** are one operation.
- Fork choice is **order-independent**; ties break on canonical root.
- **Never hand-edit** generated SSZ.
- Heavy work stays **off the tick loop**.

## Cross references
- Start: **[00 — Roadmap](00-roadmap)**. Core: **[07](07-state-transition-pipeline)**. Specializations:
  **[05](05-time-model)**, **[06](06-ssz-foundations)**, **[15](15-debugging-playbook)**.

---

### Key takeaways
- The whole curriculum on one page: four phases, ten state fields, the time ladder, SSZ's two outputs,
  the rejection map, and the debug trees.
- The two reflexes that matter most: **byte-diff two post-states** for a root mismatch; **root agreement
  across clients** for interop health.
- The invariants list is the "do no harm" you carry into every change.

### Exercise
- Reproduce this page from memory. What you can't recall is your next re-read.
