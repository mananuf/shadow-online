# 1. Introduction: why consensus & state transitions exist

Before any code, you need the *why*. Why does a consensus client exist at all, why is the state
transition function the object everything else orbits, and why does one wrong field fork a network.
This chapter is the conceptual floor the rest of the curriculum stands on (PDF §1).

## The replicated state machine

Ethereum is a **distributed system**: many independent nodes communicate over a network that can be
slow, unreliable, or adversarial. The clean mental model (PDF §1) is a **replicated state machine**:

- A *state machine* is a function that takes (i) a current state and (ii) an input, and produces a new
  state.
- *Replicated* means every honest node computes the **same sequence of state transitions**, so they
  converge on the same result.

In consensus terms: the state holds validator info and finality bookkeeping; the inputs are **blocks**
(carrying attestations); the transition function is the rule that turns `(state, block)` into the next
state. If every node applies the same blocks in the same order through the same function, they all hold
the same state. That agreement *is* the blockchain.

This raises the central challenge: in an open peer-to-peer network, different nodes see different
messages first, or are targeted by conflicting information. **Consensus** is the part of the protocol
whose job is to make the network agree on a single history of blocks. Once the block order is fixed,
the state transitions are unambiguous.

## Blocks, chaining, and local verification

The core data structure is a chain of **blocks**, each carrying a cryptographic reference (a hash) to
its parent. Change any past block and its hash changes, breaking the link to every later block — the
chain is tamper-evident by construction.

Crucially, **nodes do not accept blocks on trust.** They verify locally by re-running the protocol
rules — re-executing the state transition. This redundant verification is the whole point: it prevents
a malicious peer from convincing you to accept an invalid state transition. You don't believe the
proposer's claimed result; you *recompute* it.

## Two roles: valid vs canonical

It is useful to split the protocol into two questions (PDF §1):

1. **Which blocks are *valid*?** — defined by the **state transition function** plus validity
   conditions. A block is valid if applying it to its parent's state yields a state whose root matches
   the block's claim, and it satisfies the rules (right proposer, well-formed body…).
2. **Which valid blocks are *canonical*?** — defined by **fork choice** (and finality) when there are
   competing histories.

These map onto Ethereum's two layers: the **execution layer** (transactions, EVM) and the **consensus
layer** (fork choice, finality). This curriculum lives on the consensus side, and specifically in
**Lean Consensus** — a proposed redesign of the consensus layer.

Keep these two roles crisp; the whole of **[chapter 12](12-fork-choice-vs-state-transition)** is about
not confusing them. The state transition answers *"is this block valid?"* — never *"is it the head?"*.

## Why one wrong field forks the network

Here is the intuition that should make you careful:

```
block claims state_root = X
        │
   you recompute the transition → your state → hash_tree_root → Y
        │
   X == Y ?  → accept   |   X != Y ?  → reject
```

If your transition computes even one field differently from everyone else's, your `hash_tree_root`
differs, so your `Y` differs. You then either reject a block the rest of the network accepted, or accept
one they rejected — and you are now on a **different chain**. There is no "close enough." Consensus is
byte-exact agreement, which is why the rest of this curriculum obsesses over the spec-to-gean mapping
and the `state_root` check.

## Lean Consensus, briefly

Lean Consensus is a redesign effort ("ossification accelerationism", PDF §1.3): a simpler, more
minimal consensus layer, notably using **XMSS post-quantum signatures** and a small, auditable state
transition. Its simplicity is deliberate — a spec that seven independent clients must implement
identically is safer when it is small. gean is one such client (in Go); ethlambda, zeam, ream,
grandine, lantern, nlean, and qlean are others.

## Mental models

- **A block is a claim; the transition is you checking it.** You never trust the result; you recompute
  it.
- **Consensus = agreement on order.** Once order is fixed, transitions are deterministic and everyone
  converges.
- **Valid ≠ canonical.** Validity is the transition's job; canonicity is fork choice's job.
- **Byte-exact or forked.** There is no partial agreement in consensus.

## Cross references
- **[02 — The consensus lifecycle](02-consensus-lifecycle)** — the full journey of a block.
- **[07 — The state transition pipeline](07-state-transition-pipeline)** — the "is it valid?" function.
- **[12 — Fork choice vs state transition](12-fork-choice-vs-state-transition)** — the valid/canonical
  boundary.

## Further reading
- `lean_consensus.pdf` §1 *Introduction: why consensus exists*.

---

### Key takeaways
- Ethereum is a **replicated state machine**; consensus makes honest nodes agree on the **order** of
  blocks, after which state transitions are deterministic.
- Nodes **verify locally by recomputing**, never by trusting a proposer's claimed result.
- **Validity** (state transition) and **canonicity** (fork choice) are different questions — never
  conflate them.
- Agreement is **byte-exact**: one divergent field forks the network.

### Exercises
1. Explain "replicated state machine" using the words state, input, and transition.
2. Give a concrete example of a block that is *valid* but not *canonical*.

### Code-reading assignment
- Skim `internal/statetransition/transition.go` (validity) and `internal/forkchoice/forkchoice.go`
  (canonicity). Note that they are *different packages* — that separation is the valid/canonical split.

### Questions to verify understanding
- Why do nodes re-execute blocks instead of trusting the proposer's stated `state_root`?
- Why is a *smaller* spec a *safer* one when many clients must interoperate?
