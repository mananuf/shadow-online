# 2. The consensus lifecycle

Before diving into any single mechanism, walk the whole loop once. This chapter is the map: it traces
one slot's worth of activity end to end — proposal → gossip → import → head → attest → aggregate →
justify → finalize — so that every later chapter has a place to hang. When you're debugging, this is
the picture you hold in your head to know *which stage* you're in.

## The loop, in one diagram

```
        ┌──────────────────────── one slot (4s = 5×800ms) ────────────────────────┐
        │                                                                          │
 interval 0   proposer builds a BLOCK on the current head, signs it, gossips it    │
        │        │                                                                 │
        │        ▼                                                                 │
 (network)   block propagates via gossipsub to all peers                           │
        │        │                                                                 │
        │        ▼                                                                 │
 each node   IMPORT: verify signature → state TRANSITION → verify state_root       │
        │        │                        (ch 07)                                  │
        │        ▼                                                                 │
 interval 0/4  update HEAD via fork choice (ch 12) using all known votes           │
        │        │                                                                 │
 interval 1   each validator produces an ATTESTATION (a vote: source→target→head)  │
        │        │                                                                 │
 interval 2   aggregators build AGGREGATE attestations from the slot's votes       │
        │        │                                                                 │
 interval 3   update SAFE TARGET from fresh votes                                  │
        │        ▼                                                                 │
 (over slots) votes accumulate → a target slot is JUSTIFIED → later FINALIZED      │
        └──────────────────────────────────────────────────────────────────────────┘
```

Every stage is a later chapter. This one is the connective tissue.

## Stage by stage

### 1. Proposal (interval 0)

Exactly one validator is the proposer for the slot (`slot % num_validators`). It takes the current
head as parent, builds a block whose body carries the attestations it has seen, runs the state
transition *itself* to compute the resulting `state_root`, writes that root into the block, signs it
(XMSS), and gossips it. See **[chapter 08](08-block-processing)** and **[10 — forks](10-forks)**.

### 2. Gossip / propagation

The block travels the **gossipsub** mesh (PDF §5.4) to every peer. Propagation is not instant —
different nodes see it at slightly different times, which is exactly why the time model builds in
disparity tolerance (**[chapter 05](05-time-model)**). Out-of-order arrival is normal; a block whose
parent hasn't arrived yet is buffered, not rejected.

### 3. Import & state transition

Each receiving node runs `on_block`: check the block isn't below finalized or beyond the future
horizon, verify the XMSS signature, then run the **state transition** (`ProcessSlots → ProcessBlockHeader
→ ProcessAttestations → VerifyStateRoot`). Only if `state_root` matches does the node persist the new
state. This is **[chapter 07](07-state-transition-pipeline)** — the heart of the whole system.

### 4. Head update (fork choice)

With the new block and the votes it carries in the store, the node re-runs **fork choice**
(LMD-GHOST over a proto-array) to pick the canonical head. In gean this happens at intervals 0 and 4
of every slot. Fork choice decides *canonicity*; the transition already decided *validity*. See
**[chapter 12](12-fork-choice-vs-state-transition)**.

### 5. Attestation (interval 1)

Each validator now votes: it produces an **attestation** whose data names a `source`, `target`, and
`head` checkpoint (PDF §6.2). The vote says "from this justified source, I see this target, on this
head." Attestations are the raw material of finality. See **[chapter 09](09-attestation-processing)**.

### 6. Aggregation (interval 2)

Individual votes are many; aggregators batch same-data votes into **aggregate attestations** with one
combined XMSS proof, so a block can carry the network's votes compactly. This is the slow, off-tick
work (PDF §6.4). See **[chapter 09](09-attestation-processing)** and the Shadow guide's aggregation-cost
material.

### 7. Justification & finalization

As votes accumulate across slots, a target slot that gathers a supermajority becomes **justified**;
once the justification chain advances far enough, an earlier slot becomes **finalized** — irreversible
under honest-majority assumptions. This bookkeeping lives *inside the state transition* (phase 3) and
is read by fork choice. See **[chapter 11](11-finality)**.

## Where the three domains live in the loop

- **State transition** — stage 3 (import). Pure `f(pre, block) → post`.
- **SSZ** — stage 3's `state_root` check, and the wire encoding of every gossiped object.
- **Time model** — the whole interval structure that schedules stages 1, 5, 6, and the head updates.

## Where failures surface (preview of ch 15)

| Stage | Failure looks like |
|-------|--------------------|
| Proposal | no block at a slot (proposer down / not our turn) |
| Gossip | block/attestation never arrives (propagation gap); parent buffered |
| Import | `block processing failed` — sig, horizon, or `state_root` mismatch |
| Head | two nodes pick different heads (fork-choice determinism) |
| Attest/Aggregate | no attestations / no aggregates (duty timing, aggregator down) |
| Finality | head advances but `finalized_slot` stuck |

## Mental models
- **The loop is a heartbeat.** Every slot runs the same stages in the same interval order; a healthy
  node is one where each stage fires on time.
- **Two verdicts per block: valid, then canonical.** Import decides valid; head update decides
  canonical.
- **Votes are the currency of finality.** Blocks carry them; the transition counts them; fork choice
  weighs them.

## Cross references
- **[07](07-state-transition-pipeline)**, **[08](08-block-processing)**, **[09](09-attestation-processing)**,
  **[11](11-finality)**, **[12](12-fork-choice-vs-state-transition)** — the stages in depth.
- **[05 — The time model](05-time-model)** — the interval schedule driving the loop.
- **[15 — Debugging playbook](15-debugging-playbook)** — diagnosing each stage.

## Further reading
- `lean_consensus.pdf` §6 *Consensus Mechanisms* (esp. §6.3 attestation lifecycle, §6.5 validity
  conditions).

---

### Key takeaways
- One slot runs a fixed loop: **propose → gossip → import(transition) → head → attest → aggregate →
  justify/finalize**.
- Import produces the *valid* verdict; head update produces the *canonical* verdict.
- The three specialization domains map onto specific stages: transition = import, SSZ = root+wire, time
  = the interval schedule.

### Exercises
1. Place each of the five gean intervals onto the lifecycle diagram.
2. For each lifecycle stage, name the chapter that covers it in depth.

### Debugging exercise
- A node shows head advancing but no `finalized_slot` movement. Which lifecycle stage(s) do you suspect,
  and which do you rule out?

### Code-reading assignment
- Follow one block from `internal/node/import.go` (`onBlock`) into `internal/blockprocessor/process.go`
  and out to `updateHead` in `internal/node/head.go`. That path *is* stages 3–4.

### Questions to verify understanding
- Why is out-of-order block arrival normal, and what does gean do instead of rejecting?
- At which stage is a block's `state_root` checked, and what happens on mismatch?
