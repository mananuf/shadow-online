# 14. Shadow execution

You've studied the state transition through three lenses — theory, spec, implementation. This chapter is
the fourth: **observation**. Shadow is the lab where you *watch* gean run the transitions you now
understand, in deterministic virtual time, on one machine, reproducibly. The key insight to carry in:
**Shadow changes nothing about the logic and everything about observation.** The transition is pure, so
virtual time is invisible to it; what Shadow gives you is a controlled, repeatable place to see the whole
network execute.

> Deep dives on Shadow itself live in the companion **Shadow Simulation** guide. This chapter connects
> Shadow specifically to state transitions, SSZ, and the time model.

## Theory — what Shadow is (Shadow guide §1)

Shadow is a discrete-event **network simulator** that runs the *real, unmodified* gean binary but
replaces the OS and network beneath it with a deterministic simulation. You give it a topology (hosts,
IPs, latencies) and the command per host; it runs every process for real, intercepting syscalls (time,
sockets, threads), so the whole network executes on **one machine, in virtual time, reproducibly**.

Two properties matter for us:

1. **It runs the real binary.** The exact `statetransition`, `forkchoice`, and SSZ code paths that run on
   a devnet run in Shadow. If a transition is correct in Shadow, it's the same code that's correct on a
   devnet.
2. **Deterministic virtual time.** Same seed → same run. Timing-dependent consensus bugs (reorgs,
   finality stalls) become **reproducible**.

## The catch — Shadow doesn't charge CPU (Shadow guide §2)

Shadow advances virtual time by simulated *events*, not by how long a computation took. Between syscalls,
heavy computation appears to take **~0 virtual time**. For most apps that's fine. For a **post-quantum
client whose XMSS signature operations are genuinely slow**, it is not: the most expensive part of gean
would run "for free," and the simulation's timing would be wildly unrepresentative.

This is the one place the pure/impure split (**[chapter 13](13-gean-implementation)**) earns its keep:
because proving already runs on **off-tick worker goroutines**, gean can model its cost as a **virtual-time
sleep** placed next to the real operation, without touching the pure transition or the clock.

## Gean's cost model (`internal/shadow`)

gean models XMSS cost as sleeps sized by **signatures/second** rates, exposed behind default-off flags:

| Flag | Models | Runs on |
|------|--------|---------|
| `--shadow-xmss-aggregate-signatures-rate` | aggregation cost | aggregation worker (off-loop ✓) |
| `--shadow-xmss-verify-signature-rate` | single gossip-attestation verify | per-attestation goroutine (off-loop ✓) |
| `--shadow-xmss-verify-aggregated-signatures-rate` | aggregated-signature verify | (currently on the tick loop — known gotcha) |

`sleep_seconds = n_signatures / rate`; each rate defaults to `0` (no-op), so a **production node is
unaffected** — the sleeps only exist under a Shadow run that passes the flags. Critically, the sleeps sit
**after** the real operation and never change its inputs, outputs, or validity decision: they alter
*timing*, never *logic*. The state transition's post-state and `state_root` are identical with or without
them.

## What Shadow lets you observe about transitions

- **Determinism as a test oracle.** Because the transition is deterministic and the run is seeded, two
  clients' post-states for the same block are reproducibly comparable — a `state_root` divergence is a
  *reproducible* bug, not a heisenbug (**[chapter 15](15-debugging-playbook)**).
- **The whole loop, on one machine.** You see proposal → import(transition) → head → attest → finalize
  across all clients with controlled latency — the lifecycle of **[chapter 02](02-consensus-lifecycle)**
  laid out observably.
- **Finality under modeled cost.** With prover cost modeled, `finalized_slot` advances at a realistic
  pace; you can see the aggregation-cost cliff (over-budget proving → fewer aggregates → slower finality,
  **[chapter 09](09-attestation-processing)**) that a CPU-free sim would hide.

## Observation signals (what to read)

- **`[chain] block slot=… proc_time=… justified_slot=… finalized_slot=…`** — one line per successful
  transition (phase 4 passed) and how far finality reached.
- **`[forkchoice] head …`** — head/justified/finalized roots; compare across clients for agreement.
- **Metrics** — tick-interval duration (clock health), aggregation time (budget), reorg count/depth.
- **The fuzzer's Observatory** — propagation, coverage, and finality heatmaps across clients (Shadow
  guide).

## Genesis anchoring — the classic "nothing happens" (Shadow guide)

Shadow's virtual clock starts at unix **946684800** (2000-01-01). A wall-clock genesis (now + delay,
~2026) would sit decades in the sim future, so **no slot ever fires** — nodes boot, peer, and sit at slot
0. The harness anchors genesis to the sim epoch. If you see a Shadow run where everything is up but the
chain never advances, suspect the **clock**, not the transition (**[chapter 05](05-time-model)**).

## Shadow vs a devnet — when to use which

| | Shadow | Devnet |
|---|--------|--------|
| Reproducible | ✅ seeded | ❌ real time |
| Real timing | ⚠️ **modeled** prover cost | ✅ real hardware |
| Multi-client interop | ✅ one machine | ✅ real machines |
| Debugging | ✅ deterministic replay | harder |

Rule of thumb: **use Shadow to reproduce and localize** a timing/consensus bug; **confirm real timing on
a devnet** before concluding, because Shadow's timing reflects the *model*, not the hardware.

## Debugging techniques

```
Shadow run misbehaves
        │
        ├─ chain never advances (all at slot 0)  → clock/genesis anchoring, not logic
        ├─ finality slower than expected         → modeled prover cost (aggregation budget) — expected?
        │                                           or real liveness (missing aggregates)
        ├─ clients diverge on state_root/head     → reproducible determinism/transition bug → replay + diff
        └─ tick interval > 800ms                  → work leaked onto the tick loop (the on-loop gotcha)
```

## Common mistakes
- **Reading Shadow timing as real timing.** It's modeled; confirm on hardware.
- **Blaming the transition for a "dead" network.** Usually genesis/clock anchoring.
- **Forgetting the sleeps are default-off.** A production node never sleeps; the model is Shadow-only.
- **Putting a sleep on the tick loop.** The aggregated-verify rate currently does this — keep it modest
  or expect tick skew.

## Mental models
- **Shadow changes observation, not logic.** The pure transition runs identically; you just get to watch
  it, deterministically, everywhere at once.
- **Model the cost you can't charge.** CPU-heavy proving must be turned into virtual-time sleeps, off the
  clock, or the sim lies about timing.
- **Reproducibility is the superpower.** Every real bug in Shadow can be replayed exactly.

## Cross references
- **[02 — The consensus lifecycle](02-consensus-lifecycle)** — the loop Shadow lets you watch.
- **[05 — The time model](05-time-model)** — virtual time and the store clock.
- **[13 — The gean implementation](13-gean-implementation)** — why off-tick proving makes modeling
  possible.
- **[15 — Debugging playbook](15-debugging-playbook)** — deterministic replay and cross-client diffing.
- The companion **Shadow Simulation** guide — the full simulator/fuzzer treatment.

## Further reading
- The **Shadow Simulation** guide (§1–2 especially).
- gean: `internal/shadow/shadow.go`, `cmd/gean/flags.go` (the `--shadow-xmss-*` flags).

---

### Key takeaways
- Shadow runs the **real gean binary** in **deterministic virtual time**; it changes **observation, not
  logic** — the pure transition is unaffected.
- Shadow **doesn't charge CPU**, so gean models XMSS cost as **default-off virtual-time sleeps** placed
  **off the tick loop**, after the real op — timing only, never logic.
- Use Shadow to **reproduce and localize**; confirm **real timing on a devnet**. A "dead" Shadow network
  is usually a **genesis/clock** bug, not a transition bug.

### Exercises
1. Explain why a pure state transition is unaffected by Shadow's virtual clock.
2. Why must XMSS cost be modeled explicitly, and why off the tick loop?

### Debugging exercises
1. A Shadow run boots all clients but the chain stays at slot 0. Leading hypothesis and the check.
2. `finalized_slot` advances slower in Shadow than you expected. Give two causes — one benign, one a real
   bug — and how to tell them apart.

### Code-reading assignment
- Read `internal/shadow/shadow.go` and the three `--shadow-xmss-*` flag definitions. Confirm each rate is
  a no-op at 0 and that the sleeps sit *after* the real operation.

### Questions to verify understanding
- Why is "Shadow changes observation, not logic" the right one-sentence summary?
- Why is a `state_root` divergence in Shadow more useful than the same divergence on a live devnet?
