# 10. Forks

A fork is not a bug — it is the *normal* condition of a distributed network, and the entire consensus
machinery exists to resolve them. This chapter explains how competing histories arise, how the protocol
picks between them, and what a **reorg** is when your node changes its mind. Understanding forks is the
bridge between the state transition (which decides *validity*) and fork choice (which decides
*canonicity*, **[chapter 12](12-fork-choice-vs-state-transition)**).

## Theory — why forks happen (PDF §1.2.1)

Two situations arise constantly during normal operation:

1. **Block creation races.** More than one validator may be able to propose a valid next block at nearly
   the same time (or a proposer's block reaches different peers at different times). Momentarily,
   different nodes build on different blocks.
2. **Propagation delay.** Messages travel with latency, so two honest nodes can each *validly* extend
   the chain from different tips before they learn of each other's block.

The result: a **fork** — two (or more) valid histories branching from a common ancestor. Both branches
may contain perfectly valid blocks (each passes the state transition). Validity does not resolve the
fork; **fork choice** does, by choosing which valid branch is canonical.

```
                 ┌── fork_a (slot 2) ── …
   common (1) ───┤
                 └── fork_b (slot 3) ── …     ← which is canonical? fork choice decides
```

## Valid vs canonical (again, because it matters)

Every block on both branches can be **valid** — this is the crucial split from
**[chapter 01](01-introduction)**. The state transition would accept blocks on *either* branch. What
fork choice does is weigh the **votes** (attestations) each branch has accumulated and pick the head.
So a fork is a set of valid blocks awaiting a canonicity verdict, not a set of errors.

## How a fork resolves

Nodes accumulate attestations (**[chapter 09](09-attestation-processing)**). Fork choice (LMD-GHOST)
sums the latest vote weight supporting each branch and follows the heaviest. As votes concentrate on one
branch — because honest validators attest to what they see as head and then pile on — that branch wins,
and the network **reconverges** on a single chain. The losing branch's blocks become **orphaned** (valid
but non-canonical).

A subtlety that must be deterministic: when two branches tie (e.g. an equivocator split its vote across
both at the same slot), the tie-break must be a **pure function of store contents**, not arrival order —
resolved toward the larger canonical root (**[chapter 12](12-fork-choice-vs-state-transition)**).
Otherwise two honest nodes could pick different heads *permanently*, which is a fork that never heals.

## Reorgs — when your node changes its mind

A **reorg** (reorganization) is when a node's canonical head moves from one branch to another: it had
head *X*, learns of more weight on a sibling branch, and switches to head *Y* whose parent is not *X*.
The blocks unique to the old branch are dropped from the canonical chain; the new branch's blocks take
over.

In gean (`internal/node/head.go`), a reorg is detected precisely:

```go
isReorg := newHeader.ParentRoot != oldHead   // new head does not extend the old head
if isReorg {
    metrics.IncForkChoiceReorgs()
    depth := e.FC.ReorgDepth(oldHead, newHead)
    metrics.ObserveForkChoiceReorgDepth(float64(depth))
    logger.Warn(logger.Forkchoice, "REORG depth=%d slot=%d head_root=0x%x …", depth, …)
}
```

`ReorgDepth` measures how many blocks were rolled back. Shallow reorgs (depth 1–2) are normal near the
head under latency; **deep** reorgs are a red flag — they mean the chain reorganized far back, which
threatens anything that treated those blocks as settled.

> This is exactly why **finality** (**[chapter 11](11-finality)**) exists: a *finalized* block cannot be
> reorged under honest-majority assumptions. Finality is the floor below which reorgs cannot reach.

## Gean implementation notes

- Fork choice runs at intervals 0 and 4 each slot (**[chapter 05](05-time-model)**); the head can move
  (or reorg) at those points.
- Out-of-order blocks on a sibling branch are buffered (pending) until their parent arrives, then
  imported — so a fork's blocks aren't lost just because they arrived early.
- The finalized checkpoint is **re-derived from the head each update** and is *reorg-mutable* — a reorg
  onto a branch that finalized fewer slots can move the finalized checkpoint *down*
  (**[chapter 11](11-finality)**). This surprises people; it is deliberate (a losing higher-finalized
  fork must not latch finality above the canonical head).

## Shadow implications

Shadow is the ideal place to *study* forks: deterministic virtual time means you can reproduce a fork
and its resolution exactly (same seed → same fork → same reorg). A multi-client run with induced latency
naturally produces forks; watching `IncForkChoiceReorgs` and `ReorgDepth` across clients tells you
whether they reconverge the same way. Persistent divergence in a Shadow run with identical blocks/votes
is a determinism bug (**[chapter 12](12-fork-choice-vs-state-transition)**), not a network artifact.

## Debugging techniques

```
nodes on different heads
        │
        ├─ Different finalized root?  → escalate: safety-adjacent (someone finalized a losing fork)
        ├─ Different block/vote sets? → propagation gap (a block/attestation didn't arrive)
        └─ Same blocks + votes, different head? → fork-choice determinism bug (ch 12)

deep reorg observed
        │
        └─ How far back? below finality? → if a "finalized" block was reorged, that's a
                                            safety failure; if above finality, latency/weight shift
```

## Common mistakes
- **Treating a fork as an error.** Forks are normal; only *unresolvable* forks (determinism bugs) or
  *deep* reorgs are problems.
- **Assuming the head is final.** The head is the current canonical tip; only *finalized* blocks are
  settled.
- **Non-deterministic tie-breaks.** Any arrival-order-dependent head choice can strand the network on
  two branches forever.

## Mental models
- **A fork is a vote yet to be counted.** Both branches are valid; weight decides.
- **A reorg is the network correcting itself** — usually healthy and shallow; alarming only when deep or
  below finality.
- **Finality is the reorg floor.** Below it, the chain cannot change its mind.

## Cross references
- **[01 — Introduction](01-introduction)** — valid vs canonical.
- **[11 — Finality](11-finality)** — the floor reorgs can't cross.
- **[12 — Fork choice vs state transition](12-fork-choice-vs-state-transition)** — the mechanism that
  resolves forks and the determinism it needs.
- **[15 — Debugging playbook](15-debugging-playbook)** — the head-divergence tree.

## Further reading
- `lean_consensus.pdf` §1.2.1 *Block creation and fork resolution*.
- gean: `internal/node/head.go` (reorg detection), `internal/forkchoice/`.

---

### Key takeaways
- Forks are the **normal condition** of a distributed network, caused by proposal races and propagation
  delay; blocks on both branches are typically **valid**.
- Fork choice resolves forks by **vote weight**; a **reorg** is a node switching its canonical head to a
  heavier sibling branch.
- Tie-breaks must be **deterministic** or a fork never heals; **finality** is the floor reorgs cannot
  cross.

### Exercises
1. Draw a two-branch fork and explain why both branches can be valid.
2. Define reorg depth and say when a given depth is normal vs alarming.

### Debugging exercises
1. Two nodes with identical blocks and votes report different heads. Bug class? Confirming comparison?
2. A depth-9 reorg appears in the logs. What's the first thing you check, and what would make it a
   safety failure vs a latency artifact?

### Code-reading assignment
- In `internal/node/head.go`, find the `isReorg` computation and the `ReorgDepth` call. Explain what
  `newHeader.ParentRoot != oldHead` captures.

### Questions to verify understanding
- Why does block validity *not* resolve a fork?
- Why must a tie-break be a pure function of store contents, and what happens if it isn't?
