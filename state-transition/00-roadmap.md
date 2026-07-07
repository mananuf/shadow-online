# 0. Roadmap — becoming the State Transition, SSZ & Time specialist

This is not a page of notes. It is a **specialization curriculum**: a structured path
that takes you from "what is a state transition" to being the person on the team who can
open a failing Devnet node, read three clients' logs side by side, and say *exactly* which
line of which function diverged from the spec — and why.

By the end you should be able to own three intertwined domains end to end:

1. **State Transition** — how a block turns a pre-state into a post-state, deterministically.
2. **SSZ** — how every consensus object is serialized and hashed, because the state
   transition is only "correct" if the `state_root` it commits to matches byte-for-byte.
3. **The Time Model** — how slots, intervals, and the store clock decide *when* a
   transition is even allowed to run, and how a virtualized clock (Shadow) changes nothing
   about the logic but everything about observation.

## The four lenses

Every chapter looks at its topic through the same four lenses, in the same order. Internalize
this order — it *is* the mental model of a consensus engineer:

| Lens | Question it answers | Primary source |
|------|---------------------|----------------|
| **Theory** | What is the idea, and why must it exist? | `lean_consensus.pdf` |
| **Specification** | What is the *exact* rule? | `leanSpec/` (`lstar` fork) |
| **Implementation** | How does gean realize it in Go, and why is that translation correct? | gean source |
| **Observation** | How does it run under Shadow, and how do failures surface? | `shadow/` |

The spec is the source of truth. gean is *one* correct realization of it. Shadow is a lab
where you watch it run in virtual time. When these three disagree, the spec wins — and your
job is to find which of the other two drifted.

## Primary sources (canonical, in priority order)

1. **`lean_consensus.pdf`** — the textbook. Chapters that matter here:
   - Ch 2 *Simple Serialize (SSZ)* → our chapter 06
   - Ch 3 *The Time Model* → our chapters 04–05
   - Ch 4 *The State Transition Function* → our chapters 07–09
   - Ch 6 *Consensus Mechanisms* → our chapters 09, 11, 12
2. **`leanSpec/src/lean_spec/spec/forks/lstar/`** — the executable Python spec. `state_transition.py`,
   `fork_choice.py`, `block_production.py`, `containers/`, `ssz/`. Pinned in gean's `Makefile`
   at `LEAN_SPEC_COMMIT_HASH`.
3. **gean source** — `internal/statetransition/`, `internal/types/`, `internal/forkchoice/`,
   `internal/store/`, `internal/attestation/`, `internal/blockprocessor/`.
4. **`shadow/`** — the simulator harness, the timing model, the fuzzer, and how events are
   observed.

## The curriculum

Numbered so you can walk them in order. Foundations first; each builds on the last.

| # | Chapter | You will be able to… |
|---|---------|----------------------|
| 00 | **Roadmap** (this) | Navigate the curriculum and know why each piece exists |
| 01 | Introduction: why consensus & state transitions exist | Explain the replicated state machine and local verification |
| 02 | The consensus lifecycle | Trace a block from proposal → gossip → import → head → finality |
| 03 | The State | Name every field of `State`, and what each is *for* |
| 04 | Slots & slot processing | Explain `process_slots` and the empty-slot walk |
| 05 | The time model | Reason about slots, intervals, the store clock, and deadlines |
| 06 | SSZ foundations | Serialize, merkleize, and compute a `hash_tree_root` by hand |
| 07 | The state transition pipeline | Walk `ProcessSlots → ProcessBlock → verify state_root` cold |
| 08 | Block processing | Explain header validation and how the block mutates state |
| 09 | Attestation processing | Explain votes, justification tracking, and finality accounting |
| 10 | Validator lifecycle & duties | Map a validator to its propose/attest/aggregate duties |
| 11 | Finality | Explain justification, finalization, and the 3-slot rule |
| 12 | Fork choice vs state transition | State the crisp boundary — and why gean keeps them apart |
| 13 | The gean implementation | Read gean's packages as one team wrote them |
| 14 | Shadow execution | Explain how virtual time changes observation but not logic |
| 15 | **Debugging playbook** | Diagnose any transition failure with a decision tree |
| 16 | Case studies | Walk real multi-client divergences end to end |
| 17 | Common bugs | Recognize the recurring failure shapes before they bite |
| 18 | Interview / mastery questions | Prove you can defend every claim in this curriculum |
| 19 | Cheat sheet | Recall every function, field, and constant on one page |

Three chapters are **deep specializations** the whole team will lean on you for:

- **06 — SSZ mastery**: serialization, merkleization, generalized indices, proofs, and every
  container/vector/list/bitlist/bitvector, showing exactly where each appears in Lean and gean,
  plus how a wrong root surfaces during debugging.
- **05 — Time model mastery**: slots, clocks, timers, scheduling, and every deadline
  (proposer/attestation/aggregation/gossip), across Lean, gean, and Shadow's virtualization.
- **15 — Debugging playbook**: the decision trees, the log-reading, the state-diffing, the
  root-tracing, and the deterministic-replay workflows.

## How to use this handbook

- **Read in order the first time.** The dependencies are real: you cannot debug a `state_root`
  mismatch (ch 15) without SSZ (ch 06) and the pipeline (ch 07).
- **Do the exercises.** Each chapter ends with *Key takeaways*, *Exercises*, *Debugging
  exercises*, *Code-reading assignments*, and *Questions to verify understanding*. The
  code-reading assignments are the point — you learn the client by reading it, not by reading
  about it.
- **Keep the spec open.** Every "Gean implementation" section names the `leanSpec` function it
  mirrors. Diff them yourself.
- **Cross-reference.** Chapters link forward and back. Follow the links; the material is a graph,
  not a line.

## A note on correctness (read this twice)

gean runs for real operators and interoperates with **ethlambda, zeam, ream, grandine, lantern,
nlean, and qlean** on the same network. A transition that is "green locally" but diverges from the
spec by one field produces a different `state_root`, which produces a different block hash, which
*forks the network*. That is why this curriculum obsesses over the spec-to-gean mapping and over
the `state_root` verification step: it is the single check that turns "my code ran" into "my code
computed the one state everyone else did."

---

### Key takeaways
- The three domains — state transition, SSZ, time — are one system: the transition computes a
  post-state, SSZ hashes it into a `state_root`, and the time model decides when that is allowed.
- Four lenses, always in order: Theory → Spec → Implementation → Observation.
- The spec is truth; gean is a correct realization; Shadow is the lab. Disagreement means drift —
  find it.

### Exercises
1. Without looking below, list the four phases of the state transition function.
2. For each primary source, name one question it is the *best* place to answer.

### Code-reading assignment
- Open `gean/internal/statetransition/transition.go` and `leanSpec/.../lstar/state_transition.py`
  side by side. Don't try to understand them yet — just confirm the two files have the same *shape*.
  That shape is what the rest of this curriculum explains.

### Questions to verify understanding
- Why does a one-field divergence in the state transition fork the network, rather than just
  producing a local error?
- Which lens does `shadow/` serve, and why can it never be the source of truth for *logic*?
