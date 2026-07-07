# 12. Fork choice vs state transition

These are the two halves of consensus, and confusing them is the single most common conceptual error.
The state transition answers **"is this block valid?"** Fork choice answers **"which valid block is the
head?"** One is a pure function over a single block; the other is a running computation over *all* votes.
This chapter draws the boundary precisely, shows why gean keeps them in separate packages, and covers the
one property fork choice must never lose: **determinism**.

## The boundary, stated once

| | State transition | Fork choice |
|---|------------------|-------------|
| Question | Is this block **valid**? | Which valid block is **canonical**? |
| Input | one `(pre_state, block)` | all blocks + all votes in the store |
| Output | a `post_state` (or reject) | a head root |
| Purity | pure, deterministic, no clock | reads the store; must be order-independent |
| Runs when | on block import (phase 1–4) | intervals 0 & 4 each slot |
| Spec home | `state_transition.py` | `fork_choice.py` |
| gean home | `internal/statetransition/` | `internal/forkchoice/` |

The transition **produces** the state and its finality bookkeeping; fork choice **reads** that
bookkeeping (the finalized anchor) and the votes to pick a head. They meet at exactly two touchpoints:
the finalized checkpoint (transition writes, fork choice anchors on it) and the votes (transition counts
them for finality; fork choice weighs them for the head).

## Theory — LMD-GHOST (PDF §6)

Fork choice in Lean Consensus is **LMD-GHOST**: *Latest Message Driven, Greedy Heaviest Observed
SubTree*.

- **Latest Message Driven**: each validator's *latest* vote counts (older votes are superseded).
- **GHOST**: starting from the justified/finalized anchor, at each branch point walk toward the child
  with the **heaviest** supporting subtree (sum of latest-vote weight), until you reach a leaf — that's
  the head.

So the head is a function of *which block each validator most recently voted for*, aggregated into
subtree weights. Add a vote, and weight shifts; enough weight shifts, and the head moves (a reorg,
**[chapter 10](10-forks)**).

## Gean implementation — ProtoArray + VoteStore

gean realizes LMD-GHOST over two structures in `internal/forkchoice/`:

- **`ProtoArray`** (`protoarray.go`) — a flat array of blocks with parent links and `BestDescendant`
  pointers; walking best-descendants from the anchor yields the head in O(nodes). Efficient, and prunable.
- **`VoteStore`** (`votes.go`) — per-validator latest votes, split into `LatestKnown` (all known votes,
  used by `UpdateHead`) and `LatestNew` (freshly received, used by `UpdateSafeTarget`).

Two entry points:

- **`UpdateHead(justifiedRoot)`** — uses **all** known votes to compute the canonical head.
- **`UpdateSafeTarget(justifiedRoot, numValidators)`** — uses only **fresh** votes (`LatestNew`) with a
  **ceil(2n/3) supermajority** threshold, to compute the safe target a validator may attest to without
  risking a wrong vote.

And the pruning coupling that **must** stay together:

- **`Prune(finalizedRoot)`** removes nodes below the finalized block **and remaps vote indices**. The
  proto-array compacts, so every stored vote's node index must be remapped in lockstep. Skip the remap
  and the weights point at the wrong nodes — silent, catastrophic corruption. This is the "prune + remap
  are one operation" invariant.

### Why fork choice is NOT inside the store

A design point worth stating: **`ForkChoice` does not live inside `ConsensusStore`.** The Engine calls
fork choice with store data as parameters. This keeps the pure-ish fork-choice computation separable from
storage concerns and testable in isolation, and it enforces the boundary: the store holds state (which
the transition produced); fork choice is a computation *over* that state, not a part of it.

## Determinism — the property fork choice cannot lose

Fork choice **must** be a pure function of store contents. Two honest nodes with the same blocks and the
same votes **must** pick the same head — otherwise a fork never heals (**[chapter 10](10-forks)**).

The sharp edge is **equal-slot equivocation**: a validator that signs two distinct votes at the same
slot. If the latest-vote extraction resolved that tie by *arrival order*, two nodes receiving the votes
in different orders would keep different votes and could pick different heads *permanently*. The rule:
break an equal-slot tie toward the **larger canonical attestation-data root** — a pure function of the
votes, independent of arrival order.

gean enforces this where votes are reduced to one-per-validator (`store.ExtractLatestAttestations`): it
keeps, per validator, the vote with the maximum `(slot, hash_tree_root(data))`. Block production applies
the *same* secondary key so a proposer builds the same block regardless of arrival order. This is the
determinism guarantee, and it's the behavior the leanSpec #1181 vectors exercise.

> **Debugging tell:** *same inputs, different head* is **always** a determinism bug, never a networking
> one. Networking explains different *inputs*; it can never explain different *outputs from the same
> inputs*.

## Spec → gean mapping

| leanSpec | gean | File | Role |
|----------|------|------|------|
| `update_head` / GHOST walk | `UpdateHead` + `ProtoArray` | `forkchoice.go`, `protoarray.go` | Canonical head |
| safe-target computation | `UpdateSafeTarget` | `forkchoice.go` | Fresh-vote 2/3 target |
| latest-vote extraction | `ExtractLatestAttestations` (max slot,root) | `store/payloads.go` | Order-independent LMD |
| prune below finalized | `Prune` (+ index remap) | `forkchoice.go`, `votes.go` | Reclaim + keep weights valid |

## Shadow implications

Shadow is where you *prove* determinism: same seed → same run → same heads. A multi-client run that
diverges on head with identical blocks/votes is a determinism regression, reproducible on demand. It's
also where the head-update-vs-proposal ordering matters (**[chapter 05](05-time-model)**): at interval 0
gean updates head *then* proposes, matching the spec's `get_proposal_head`; reorder them and a proposer
builds on a stale head under simulated latency.

## Debugging techniques

```
head-related symptom
        │
        ├─ Same blocks + votes, different head across nodes → DETERMINISM bug
        │     └─ suspect equal-slot tie-break (canonical root?) or arrival-order weighting
        │        → compare ExtractLatestAttestations output for one equivocating validator
        ├─ Head won't advance past a root FC doesn't know
        │     └─ justified root unknown to fork choice (see the warning gean logs)
        └─ Weights look wrong after finalization
              └─ prune without index remap → vote indices point at wrong nodes
```

## Common mistakes
- **Conflating validity and canonicity.** The transition never decides the head; fork choice never
  decides validity.
- **Order-dependent head selection.** Any arrival-order influence on the head is a determinism bug.
- **Pruning without remapping vote indices.** Corrupts weights silently.
- **Putting fork choice inside the store.** Breaks the boundary and the testability that comes with it.

## Mental models
- **Transition = referee for one block; fork choice = scoreboard over all votes.** Different jobs,
  different inputs.
- **The head is a pure function of the store.** Same store, same head — always.
- **Prune and remap are one move.** Never one without the other.

## Cross references
- **[07 — The state transition pipeline](07-state-transition-pipeline)** — the "is it valid?" half.
- **[10 — Forks](10-forks)** & **[11 — Finality](11-finality)** — what fork choice resolves and anchors
  on.
- **[09 — Attestation processing](09-attestation-processing)** — the votes fork choice weighs.
- **[15 — Debugging playbook](15-debugging-playbook)** — the head-divergence tree.

## Further reading
- `lean_consensus.pdf` §6 *Consensus Mechanisms*.
- gean: `internal/forkchoice/{forkchoice,protoarray,votes}.go`, `internal/store/payloads.go`.

---

### Key takeaways
- **State transition = validity (one block, pure); fork choice = canonicity (all votes, order-independent).**
  Separate questions, separate packages.
- gean runs **LMD-GHOST over a ProtoArray + VoteStore**; `UpdateHead` uses all votes, `UpdateSafeTarget`
  uses fresh votes with a **ceil(2n/3)** threshold.
- Fork choice **must be deterministic**: equal-slot equivocation ties break toward the **larger canonical
  data root**; *same inputs, different head* is always a determinism bug.
- **Prune + vote-index remap are one operation**; `ForkChoice` lives **outside** `ConsensusStore`.

### Exercises
1. Fill in the boundary table from memory (input, output, purity, when-it-runs) for both halves.
2. Explain LMD-GHOST in two sentences (what "latest message" and "heaviest subtree" mean).

### Debugging exercises
1. Two nodes, identical blocks and votes, different heads. Bug class, and the exact comparison that
   confirms it?
2. After a finalization, fork-choice weights are wrong. What single operation was likely skipped?

### Code-reading assignment
- In `internal/store/payloads.go`, read `ExtractLatestAttestations` and confirm it keeps the max
  `(slot, dataRoot)` per validator. Then find `Prune` in `internal/forkchoice/` and confirm it remaps
  vote indices.

### Questions to verify understanding
- Why can networking explain different *inputs* but never different *outputs from the same inputs*?
- Why does gean keep `ForkChoice` outside `ConsensusStore`, and what does that buy?
