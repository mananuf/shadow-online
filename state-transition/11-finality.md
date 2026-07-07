# 11. Finality

Finality is the property that turns "the current best guess" into "settled forever." Fork choice
(**[chapter 12](12-fork-choice-vs-state-transition)**) picks a *head* that can still reorg; finality
marks a point below which the chain **cannot change its mind**. This chapter explains justification (the
step before finality), finalization (the ratchet), the lookback window, and the one counter-intuitive
gean behavior that trips everyone: the finalized checkpoint is **reorg-mutable**.

## Theory — two levels of agreement

- **Justified.** A checkpoint (a `{root, slot}`) becomes *justified* when a **supermajority** (two
  thirds of validators by weight) attests with it as target. Justification says "the network broadly
  agrees this slot is on the canonical chain right now."
- **Finalized.** Once justification advances in the right pattern over a short window, an earlier
  justified checkpoint becomes *finalized* — **irreversible** under the honest-supermajority assumption.
  A finalized block is a settled anchor: fork choice never looks below it, and reorgs cannot reach it.

Justification is a ledger entry; finalization is a ratchet click. The gap between them is the price of
safety — you wait for enough agreement before declaring something permanent.

## The lookback window (PDF §6, gean constant)

gean uses `JustificationLookbackSlots = 3` (`internal/types/constants.go`): finalization considers a
short window of recent justification. The intuition of a 3-slot rule: a checkpoint finalizes when it and
the subsequent justification form a chain across that window, so a lone late vote can't finalize the
wrong slot. The exact accounting lives in phase 3 of the transition and in the finality helpers; the
constant is the tunable that defines "how much recent agreement finalizes an anchor."

## Specification — where finality is computed

Finality bookkeeping is part of the **state transition** (phase 3, **[chapter 09](09-attestation-processing)**):
processing attestations advances `LatestJustified`, sets bits in `JustifiedSlots`, and — when the window
condition holds — advances `LatestFinalized`. These are *state fields* (**[chapter 03](03-state)**), so
finality is committed into the `state_root` and agreed by every node. Fork choice then *reads* the
finalized checkpoint to anchor its head walk; it never invents finality.

## Gean implementation

### Justification/finalization in the transition
`internal/statetransition/finality.go` and `attestations.go` advance the justified/finalized
checkpoints and extend `JustifiedSlots` as votes cross quorum. Because this is inside the pure
transition, every node computes the same finality from the same blocks — it is part of consensus, not a
local heuristic.

### The reorg-mutable finalized checkpoint (the surprising part)
gean re-derives the finalized checkpoint **from the canonical head** on every fork-choice update, in
`internal/node/head.go` (`updateFinalizedFromHead` → `store.DeriveFinalizedFromHead`):

```go
// Set unconditionally to the canonical head's finalized checkpoint, NOT a running maximum:
// a higher-finalized fork that loses head selection must not latch finalization above the head,
// so the checkpoint moves DOWN when the head reorgs onto a chain that finalized fewer slots.
e.Store.SetLatestFinalized(derived)
if derived.Slot > oldSlot {          // only PRUNE when finalization genuinely advances
    e.FC.Prune(derived.Root)
    store.PruneOnFinalization(...)
}
```

Two things to internalize:

1. **Finalized is the head chain's view, not a monotone global maximum.** If the head reorgs onto a
   branch that finalized a *lower* slot, the finalized checkpoint moves *down*. This sounds like it
   violates "finality is irreversible" — but it doesn't: under the honest-supermajority assumption the
   head never reorgs away from a *genuinely* finalized block. What moves down is a *losing fork's*
   higher finalization that was never network-agreed. Latching it would stall target advancement.
2. **Pruning is irreversible, so it only runs when finalization advances.** A downward move keeps the
   existing pruned horizon. When finalization advances, gean prunes fork-choice nodes and store data
   below the new finalized slot — and (**critically**) `Prune` **remaps vote indices** so weights stay
   correct (**[chapter 12](12-fork-choice-vs-state-transition)**).

### Spec → gean mapping

| leanSpec | gean | File | Role |
|----------|------|------|------|
| justification accounting | `finality.go`, `attestations.go` | statetransition | Advance justified/`JustifiedSlots` |
| finalization | finality helpers | statetransition | Advance `LatestFinalized` |
| finalized = head's view | `DeriveFinalizedFromHead` | store/node | Reorg-mutable finalized |
| prune below finalized | `FC.Prune` + `PruneOnFinalization` | forkchoice/store | Reclaim + remap indices |

## Why finality matters operationally

- **It's the reorg floor** (**[chapter 10](10-forks)**): below the finalized slot, blocks are settled;
  gean even rejects blocks below finalized outright.
- **It bounds state growth**: finalization triggers pruning of history and votes below the anchor.
- **It's your health signal**: in a run, `finalized_slot` advancing uniformly across all nodes is the
  single best "the network is healthy" indicator (**[chapter 15](15-debugging-playbook)**).

## Shadow implications

Under Shadow, finality is the payoff metric. A healthy multi-client run shows `finalized_slot` climbing
in lockstep across clients; a stalled `finalized_slot` with advancing head is the classic
"justification isn't reaching quorum" symptom — often a **liveness** issue (votes/aggregates not
arriving because a prover is over budget, **[chapter 09](09-attestation-processing)**), not a finality
*logic* bug. The finalized-root agreement across clients (byte-identical at the same slot) is the
decisive interop-health check.

## Debugging techniques

```
finality stalled (head advances, finalized_slot stuck)
        │
        ├─ Are 2/3 of votes reaching ONE branch each slot?
        │     └─ No → liveness: missing proposer / missing aggregates / split votes (ch 09, 10)
        ├─ Is justification advancing in the post-state?
        │     └─ diff LatestJustified / JustifiedSlots across blocks; if flat, phase-3 tally issue
        └─ Did finalized move DOWN after a reorg?
              └─ expected if the head reorged onto a lower-finalized branch (not a bug)

clients disagree on finalized root
        └─ escalate: someone finalized a losing fork → safety-adjacent
```

## Common mistakes
- **Assuming finalized only ever increases.** In gean it's the *head's* finalized view and can move down
  on a reorg — by design.
- **Treating the head as settled.** Only *finalized* is settled; the head can reorg.
- **Pruning on a downward finalization move.** Pruning is irreversible; only prune when finalization
  advances.
- **Forgetting the vote-index remap on prune.** Pruning without remapping corrupts fork-choice weights.

## Mental models
- **Justify is a ledger entry; finalize is a ratchet click.** The window between is the safety margin.
- **Finality is the floor; the head is the water level.** The floor only rises (in agreement); the water
  moves with weight.
- **gean's finalized is "the head chain's finalized," not a global max** — so it can dip on a reorg
  without violating true finality.

## Cross references
- **[09 — Attestation processing](09-attestation-processing)** — where justification/finalization are
  computed.
- **[10 — Forks](10-forks)** — finality as the reorg floor.
- **[12 — Fork choice vs state transition](12-fork-choice-vs-state-transition)** — how the finalized
  anchor bounds the head walk; the prune/remap coupling.
- **[03 — The State](03-state)** — `LatestJustified`/`LatestFinalized`, `JustifiedSlots`.

## Further reading
- `lean_consensus.pdf` §6 *Consensus Mechanisms*.
- gean: `internal/statetransition/finality.go`, `internal/node/head.go`, `internal/store/{metadata,prune}.go`.

---

### Key takeaways
- **Justified** = a supermajority attested a checkpoint; **finalized** = justification advanced over the
  lookback window, making a checkpoint **irreversible** (the reorg floor).
- Finality is computed **inside the pure state transition** (phase 3) and committed to the `state_root`.
- gean's `LatestFinalized` is the **head chain's** finalized view — **reorg-mutable** (can move down),
  which is deliberate; pruning (irreversible) runs only when finalization *advances*, and must **remap
  vote indices**.

### Exercises
1. Distinguish justified from finalized in one sentence each.
2. Explain how a reorg can move gean's finalized checkpoint *down* without violating true finality.

### Debugging exercises
1. Head is at 44, finalized stuck at 36, blocks land every slot. Walk the tree — liveness or logic?
2. Two clients report different finalized roots at slot 40. Why is this more serious than a head
   disagreement?

### Code-reading assignment
- Read `updateFinalizedFromHead` in `internal/node/head.go`. Explain the "set unconditionally, not a
  running maximum" comment and why pruning is gated on `derived.Slot > oldSlot`.

### Questions to verify understanding
- Why is finality part of the state (and thus the `state_root`) rather than a local computation?
- Why must pruning-on-finalization remap fork-choice vote indices?
