# 5. The time model

The state transition function is timeless — it is a pure map `f(pre, block) → post` with no clock in
sight. So why a whole chapter on time? Because *when* a transition is allowed to run, *who* is allowed
to produce the block that drives it, and *when* a vote counts, are all decided by the time model. Time
is the scheduler; the transition is the work. Get the scheduler wrong and correct work runs at the
wrong moment — which on a consensus network looks identical to the work being wrong.

This is one of your three specialization areas. Own it completely.

> **One-sentence definition.** The time model maps wall-clock (or virtual) time onto a discrete
> ladder of **slots**, each subdivided into fixed **intervals**, so every node independently agrees on
> "what slot is it, and which sub-task is due right now" without talking to each other.

## Theory — why discretize time at all

Consensus needs a shared notion of "now" so that duties don't collide. If proposers could propose at
any instant, two would race; if attesters voted at arbitrary times, aggregation could never batch
them. The fix (PDF §3) is to **quantize** time:

- Chop continuous time into equal **slots**. Exactly one proposer is elected per slot.
- Subdivide each slot into equal **intervals**, and assign each interval a specific duty (propose,
  attest, aggregate…). Now every honest node, reading only its own clock, knows what it should be doing
  and can expect what others are doing.

The genesis time is a shared constant, so `slot = (now − genesis) / slot_duration` is a pure function
of the clock. No coordination messages needed — the clock *is* the coordination.

## The ladder: slots and intervals in gean

The exact numbers live in `internal/types/constants.go`:

| Constant | Value | Meaning |
|----------|-------|---------|
| `SecondsPerSlot` | **4** | A slot is 4 seconds |
| `IntervalsPerSlot` | **5** | Each slot is 5 intervals |
| `MillisecondsPerSlot` | 4000 | = 4 s |
| `MillisecondsPerInterval` | **800** | Each interval is 800 ms |
| `GossipDisparityIntervals` | 1 | Clock-skew tolerance for gossip acceptance |
| `SyncToleranceSlots` | 2 | How far behind head may lag before "syncing" |
| `JustificationLookbackSlots` | 3 | The finality window (see ch 11) |

So a slot is **4 s = 5 × 800 ms**. The five intervals are the heartbeat of the whole node:

```
  slot N (4s)
  ├─ interval 0 (0–800ms)    PROPOSE (if we're proposer) + update head
  ├─ interval 1 (800–1600)   ATTEST  (produce our attestation)
  ├─ interval 2 (1600–2400)  AGGREGATE (aggregators build aggregate attestations)
  ├─ interval 3 (2400–3200)  update SAFE TARGET (fresh-vote fork-choice view)
  └─ interval 4 (3200–4000)  update head (re-run fork choice before next slot)
```

This maps directly to the four-interval consensus workflow in PDF §3.2.1 (gean uses five: propose,
attest, aggregate, and *two* head updates bracketing the slot).

## Specification — how Lean models time

The spec keeps two clocks conceptually distinct:

- **Wall-clock derived slot** — `slot = (unix_now − genesis_time) / SECONDS_PER_SLOT`. Drives duties
  (who proposes, when to attest).
- **`store.time`** — a monotone counter of **intervals** the fork-choice store has advanced through,
  moved forward by an `on_tick` handler. Drives *acceptance* decisions: an attestation or block is
  judged against `store.time`, not the raw wall clock, so replay and testing are deterministic.

The critical spec rule: acceptance checks compare an object's slot against `store.time`, and use
`GOSSIP_DISPARITY` intervals of slack for honest clock skew. The block future-horizon guard
(`BLOCK_TOO_FAR_IN_FUTURE`) and the attestation future guard both live here.

## Gean implementation

### Deriving the slot — `internal/node/clock.go`

```go
func (e *Engine) currentSlot(timestampMs uint64) uint64 {
    return types.CurrentSlot(e.Store.Config().GenesisTime, timestampMs)
}
func (e *Engine) currentInterval(timestampMs uint64) uint64 { … } // interval within the slot
```

Pure arithmetic over genesis time — no state, no I/O. This is the "wall-clock derived slot."

### The heartbeat — `internal/node/tick.go`

The **entire node is driven by an 800 ms ticker.** `onTick` derives the current slot/interval from the
wall clock and dispatches the interval's duty:

```go
currentInterval := e.currentInterval(timestampMs)
if currentInterval == 0 && currentSlot > 0 && !firstTick { proposerValidatorID, hasProposal = e.getOurProposer(currentSlot) }
if currentInterval == 2 { /* dispatch aggregation */ }
if currentInterval == 0 || currentInterval == 4 { e.updateHead() }
if currentInterval == 0 { e.maybePropose(currentSlot, proposerValidatorID) }
if currentInterval == 1 { e.runAttestationInterval(currentSlot) }
if currentInterval == 3 { e.updateSafeTarget() }
// …then advance the store clock:
store.OnTick(e.Store, timestampMs, hasProposal)
```

Two things to internalize:

1. **Head-update-before-propose ordering.** At interval 0 the node updates the head *then* proposes,
   matching the spec's `get_proposal_head` ordering. Reorder these and the proposer could build on a
   stale head. Preserve this order at all costs.
2. **Expensive work runs off the tick loop.** The `Engine` is single-threaded over a `select` loop;
   the tick *is* the clock. Slow XMSS proving (aggregation, proposal) is dispatched to dedicated
   worker goroutines so a slow prover never delays the clock. Any `time.Sleep` or heavy compute *on*
   the tick goroutine delays every subsequent duty — a whole class of timing bugs.

### The store clock — `internal/store/tick.go`

`store.OnTick` advances `store.Time()` (in intervals) via `PutTime`, one interval at a time, up to the
current wall-clock interval (with a one-slot catch-up cap). This is gean's `store.time`. Acceptance
checks read it:

```go
currentSlot := s.Time() / types.IntervalsPerSlot          // block future-horizon guard
if data.Slot*types.IntervalsPerSlot > s.Time()+types.GossipDisparityIntervals { … } // attestation guard
```

So the same `store.Time()` value that the testdriver sets from a fixture `tick` step, the live node
advances from the wall clock — one code path, deterministic under test, live in production.

### Spec → gean mapping

| leanSpec | gean | File | Role |
|----------|------|------|------|
| `slot = (now−genesis)/SECONDS_PER_SLOT` | `CurrentSlot` | `types/…`, `node/clock.go` | Duty scheduling |
| interval within slot | `CurrentInterval` | `node/clock.go` | Which sub-task is due |
| `on_tick` advancing `store.time` | `store.OnTick` | `store/tick.go` | Acceptance clock |
| the 4-interval workflow | `Engine.onTick` dispatch | `node/tick.go` | Propose/attest/aggregate/head |
| `GOSSIP_DISPARITY` | `GossipDisparityIntervals` | `types/constants.go` | Skew tolerance |

## Deadlines — the timing budget

Each duty has an implicit deadline: it must finish inside its interval, or it slips into the next
interval's territory and is dropped or late. The budgets that matter:

- **Proposal (interval 0, 800 ms):** build + sign the block before interval 1, so attesters can vote on
  it this slot. gean uses a proposal-deadline percentage to leave headroom.
- **Aggregation (interval 2, ~1600 ms of session budget):** build aggregate attestations from the
  slot's votes. XMSS aggregation is the slowest step; if it exceeds budget the off-tick worker trims
  the pass so the chain keeps finalizing (see the Shadow guide's aggregation cost work).
- **Attestation verify (~500 ms each):** each gossip attestation is verified on its own goroutine.
- **Gossip disparity (1 interval):** the slack that lets a slightly-skewed peer's on-time message
  still be accepted.

## Shadow implications — virtual time

Shadow runs the **real binary** but replaces the clock with a **deterministic virtual clock** (see the
Shadow guide, ch 1–2). For the time model this means:

- **The ladder is unchanged.** Slots are still 4 s, intervals still 800 ms — in *virtual* seconds. The
  `onTick` dispatch, the store clock, the deadlines: identical logic.
- **CPU is not charged.** Shadow advances virtual time by simulated network events, not by how long a
  computation took. So gean's genuinely-slow XMSS proving would appear to take ~0 virtual time — which
  is why gean *models* prover cost as an explicit virtual-time sleep. Without that, the time model's
  deadlines would be meaningless in simulation.
- **Determinism.** Same seed → same clock → same slot/interval sequence → reproducible timing bugs.
- **Genesis anchoring.** Shadow's clock starts at unix 946684800 (2000-01-01); a wall-clock genesis
  would sit decades in the sim future and no slot would ever fire. The harness anchors genesis to the
  sim epoch — a classic "nothing happens" symptom if misconfigured.

## Debugging techniques

Timing bugs hide as "nothing happened" or "happened late." Work the clock:

```
symptom: node not proposing / not attesting / head not advancing
        │
        ├─ Is the slot advancing at all?  → log the derived slot each tick;
        │                                    if stuck at 0, genesis time is wrong
        │                                    (future genesis, or Shadow epoch un-anchored)
        ├─ Right slot, wrong duty?         → check interval dispatch in onTick;
        │                                    is the duty gated (DutyGate) by a stale view?
        ├─ Duty runs but late?             → measure tick interval duration
        │                                    (ObserveTickIntervalDuration); if >800ms,
        │                                    something heavy is on the tick goroutine
        └─ Accepted-but-should-reject, or  → compare object.slot to store.Time();
           reverse                           check GossipDisparity slack and the
                                             future-horizon guards
```

Key evidence: gean records tick-interval duration as a metric. A tick that regularly exceeds 800 ms
means work leaked onto the clock goroutine — the single most common gean timing regression.

## Common mistakes

- **Heavy work on the tick goroutine.** Any proving/verifying on the `select` loop delays the clock.
  It must run on a worker. (The known `SleepVerifyAggregated`-on-loop gotcha is exactly this.)
- **Confusing the two clocks.** Using wall-clock slot where the spec uses `store.time` (or vice
  versa). Acceptance uses `store.Time()`; duty scheduling uses the wall-clock slot.
- **Reordering interval-0 duties.** Proposing before updating head builds on a stale head.
- **Forgetting gossip disparity.** Rejecting an on-time message from a slightly-skewed peer because
  you compared against an exact boundary instead of `store.Time() + GossipDisparityIntervals`.
- **Un-anchored genesis under Shadow.** Genesis in the sim future → zero slots fire → "dead network"
  that is actually a clock bug.

## Mental models

- **The tick is a metronome; duties are notes on the beat.** Miss the beat (slow tick) and the whole
  measure drifts.
- **Two clocks, two jobs.** Wall-clock slot answers *"what should I do now?"*; `store.time` answers
  *"is this message allowed in yet?"*.
- **Time schedules, it never computes.** The transition (ch 07) does the computing; the clock only
  decides when to run it and whose block is eligible.

## Cross references

- **[04 — Slots & slot processing](04-slots)** — how the state records skipped slots.
- **[07 — The state transition pipeline](07-state-transition-pipeline)** — the timeless work the clock
  schedules; where `store.Time()` gates block acceptance.
- **[09 — Attestation processing](09-attestation-processing)** — attestation timing and the future
  guard.
- **[11 — Finality](11-finality)** — the 3-slot justification window.
- **[14 — Shadow execution](14-shadow-execution)** — virtual time and prover-cost modeling.

## Further reading

- `lean_consensus.pdf` §3 *The Time Model* (esp. §3.2 slot duration and intervals, §3.3 the slot
  clock, §3.4 genesis configuration).
- gean: `internal/types/constants.go`, `internal/node/{clock,tick}.go`, `internal/store/tick.go`.

---

### Key takeaways
- Time is quantized into **4 s slots × 5 × 800 ms intervals**; each interval owns a duty.
- Two clocks: **wall-clock slot** (schedules duties) and **`store.time`** (gates acceptance,
  deterministic).
- The whole node is an 800 ms ticker; **keep heavy work off the tick goroutine** or the clock drifts.
- Shadow virtualizes time — same ladder, same logic — but doesn't charge CPU, so prover cost must be
  modeled explicitly.

### Exercises
1. Compute the slot and interval for a timestamp 9.3 s after genesis. (Slot? interval?)
2. List the five gean intervals and the duty each runs. Which two run a head update, and why two?
3. Explain why acceptance uses `store.Time()` rather than the wall-clock slot.

### Debugging exercises
1. A node's head is stuck at slot 0 while peers advance. Give three distinct clock-level causes and
   the check that distinguishes each.
2. `ObserveTickIntervalDuration` reports 1.4 s on a node that stopped attesting. What happened, and
   where would you look in gean?

### Code-reading assignment
- Read `internal/node/tick.go` and match each `if currentInterval == …` block to a PDF §3.2.1 duty.
- Read `internal/store/tick.go` and explain the one-slot catch-up cap in `OnTick`.

### Questions to verify understanding
- Why can two honest nodes agree on "what slot is it" with zero coordination messages?
- What breaks if `MillisecondsPerInterval` work regularly overruns 800 ms?
- Under Shadow, why would a network that "does nothing" often be a genesis/clock bug rather than a
  consensus bug?
