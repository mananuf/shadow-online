# 13. The gean implementation

By now you've seen gean in pieces — a function here, a package there. This chapter zooms out to the
**architecture**: how the packages fit, who owns what, and how a message flows from the network into
consensus and finally into a state transition. The goal is to read gean *as one team wrote it* — to know,
for any behavior, which package to open and why it lives there.

## The shape of the client

```
        ┌──────────────────────── internal/node (the Engine) ────────────────────────┐
        │  single-threaded select loop over: ticker | BlockCh | AggregationCh | …     │
        │      onTick → schedule duties        onBlock → import        …              │
        └───────────────┬───────────────────────────┬───────────────────────────────┘
                        │ calls (pure)               │ dispatches (off-tick workers)
                        ▼                             ▼
   internal/statetransition   internal/forkchoice   aggregation / proposal / recovery workers
   (pure f(pre,block)→post)   (LMD-GHOST, outside     (slow XMSS proving, off the clock)
                              the store)
                        │                             │
                        ▼                             ▼
   internal/types (SSZ,     internal/store (state,   internal/xmss (CGo → Rust)
   generated encoders)      finality, buffers)       post-quantum signatures
                        ▲                             ▲
                        └──────── internal/p2p (libp2p/QUIC, gossipsub, req/resp) ────┘
```

Read it top-down: the **Engine** coordinates; **statetransition** and **forkchoice** are the consensus
brains it calls; **store** and **types** are the data; **xmss** is the crypto; **p2p** is the mouth and
ears. Everything expensive runs *off* the Engine's single thread.

## The Engine — coordination, single-threaded (`internal/node/`)

`Engine` owns runtime wiring and is **single-threaded over a `select` loop** in `Run`. It multiplexes:

- the **800 ms ticker** → `onTick` (schedule the interval's duty, **[chapter 05](05-time-model)**),
- `BlockCh` → `onBlock` (import a received block, **[chapter 08](08-block-processing)**),
- `AggregationCh`, `FailedRootCh`, etc.

Because it's single-threaded, the tick *is* the clock, and shared state mutated on this loop needs no
locks. The rule that falls out: **expensive proving runs on dedicated worker goroutines**, never on the
loop —

- **aggregation worker** (slow XMSS aggregation, capacity-1 channel, backlog dropped by design),
- **proposal worker** (builds the block proof without blocking ticks),
- **recovery worker** (splits block proofs back into pending proofs),
- **per-attestation verify goroutines** (~500 ms XMSS verify each), with the shared
  `AttestationSignatureMap` **mutex-protected**.

This is the concurrency model in one sentence: **single-writer Engine loop + off-tick workers +
per-attestation verify goroutines, with shared maps mutex-guarded.** Most "flaky" bugs are a violation
of it (a worker touching store state without synchronization), not a logic error.

## The consensus brains

- **`internal/statetransition/`** — the pure `ProcessSlots → ProcessBlock → verify state_root`. No I/O,
  no clock. This is the package that must mirror leanSpec most closely
  (**[chapter 07](07-state-transition-pipeline)**).
- **`internal/forkchoice/`** — LMD-GHOST over `ProtoArray` + `VoteStore`. **Not** inside the store; the
  Engine calls it with store data (**[chapter 12](12-fork-choice-vs-state-transition)**).

## The data

- **`internal/types/`** — every consensus type + **generated** SSZ encoders (`*_encoding.go`, never
  hand-edited; `make sszgen`). Constants (slot/interval timing, limits) live here too
  (**[chapters 03](03-state), [06](06-ssz-foundations)**).
- **`internal/store/`** — the consensus store on top of raw storage: block/state access, metadata, the
  payload buffers (aggregated votes), attestation signatures, pruning, and the tick clock. Pluggable
  backend (pebble on-disk, memory for tests).

## The crypto

- **`internal/xmss` + `xmss/rust/`** — post-quantum XMSS signatures over **CGo FFI** to Rust. This is the
  slow part; the whole "keep proving off the tick loop" discipline exists because of it. On amd64 it's
  built with AVX2 for a ~6× prover speedup.

## The edges

- **`internal/p2p/`** — libp2p over QUIC: gossipsub topics (block, aggregation, per-subnet attestation),
  req/resp (BlocksByRange for backfill), discovery. Wire encoding is SSZ + snappy.
- **`internal/blockprocessor/`** — the impure boundary around the pure transition: clone parent state →
  `statetransition` → persist only on success. The future-horizon guard lives here (it needs the store
  clock), *outside* the pure package.

## How a message becomes a state transition (the end-to-end path)

```
p2p gossip receives a block
   → Engine.OnBlock puts it on BlockCh
   → onBlock (import.go): below-finalized? pending-parent? buffer or proceed
   → blockprocessor.OnBlock: future-horizon guard → verify XMSS sig
   → transitionState: CLONE parent state
        → statetransition.StateTransition (phases 1–4)   ← the pure math
   → persist post-state (only if phase 4 passed)
   → FC.OnBlock + updateHead (fork choice picks canonical head)
```

Trace this once in the code and the whole architecture clicks: networking (`p2p`) → coordination
(`node`) → boundary (`blockprocessor`) → pure consensus (`statetransition`) → data (`store`/`types`) →
canonicity (`forkchoice`).

## Conventions that keep it coherent

- **Spec is the source of truth**; consensus code tracks leanSpec at the pinned `LEAN_SPEC_COMMIT_HASH`.
- **Never hand-edit generated SSZ** (`*_encoding.go`); change the struct + tags, `make sszgen`.
- **FFI builds before Go that touches xmss** — use the make targets; a plain `go test ./...` fails to
  link.
- **Comment protocol reasoning, not the code**; don't reference other clients in comments.
- Buffer caps and consensus limits are package-level constants aligned with the pinned spec.

## Shadow implications

The architecture is what makes Shadow modeling *possible*: because proving is already isolated on
worker goroutines (off the tick loop), gean can insert a virtual-time sleep there to model XMSS cost
without touching the clock (**[chapter 14](14-shadow-execution)**). A client that did proving on its main
loop couldn't be made Shadow-accurate without restructuring. The concurrency discipline pays off twice.

## Debugging techniques

```
which package owns this bug?
        │
        ├─ wrong post-state / state_root      → internal/statetransition (pure)
        ├─ wrong head / reorg / determinism   → internal/forkchoice
        ├─ wrong root but state looks right    → internal/types (SSZ) / generated encoders
        ├─ block accepted/rejected wrongly     → internal/blockprocessor (the boundary guards)
        ├─ duty at wrong time / clock drift    → internal/node (tick loop, scheduling)
        ├─ message not arriving                → internal/p2p (gossip / req-resp)
        └─ "flaky" under load                  → concurrency: a worker touching store unsynchronized
```

## Common mistakes
- **Putting logic in the wrong layer** — e.g. a clock read in `statetransition` (must be pure) or fork
  choice inside the store.
- **Blocking the tick loop** with proving — it belongs on a worker.
- **Hand-editing generated encoders.**
- **Unsynchronized store access from a worker** — the flaky-bug generator.

## Mental models
- **The Engine conducts; the workers play.** The loop schedules; proving happens elsewhere.
- **Pure in the middle, impure at the edges.** `statetransition` is pure; `blockprocessor`/`node`/`p2p`
  are where I/O and the clock live.
- **Each symptom has a home package.** Learn the map and diagnosis starts in the right file.

## Cross references
- **[07](07-state-transition-pipeline)**, **[12](12-fork-choice-vs-state-transition)** — the two brains.
- **[05 — The time model](05-time-model)** — the tick loop and off-loop discipline.
- **[14 — Shadow execution](14-shadow-execution)** — why the architecture makes Shadow modeling possible.
- **[15 — Debugging playbook](15-debugging-playbook)** — symptom → package.

## Further reading
- gean `CLAUDE.md` (architecture overview), and each package's doc.
- `internal/node/engine.go`, `internal/blockprocessor/process.go`.

---

### Key takeaways
- gean is a **single-threaded Engine loop + off-tick workers + per-attestation verify goroutines**;
  shared maps are mutex-guarded. Most "flaky" bugs violate this model.
- **Pure in the middle** (`statetransition`, and `forkchoice` outside the store), **impure at the edges**
  (`node`, `blockprocessor`, `p2p`); crypto is CGo XMSS.
- A message flows **p2p → node → blockprocessor → statetransition → store/types → forkchoice**; trace it
  once and the architecture clicks.
- Each failure symptom has a **home package** — the fastest debugging step is opening the right one.

### Exercises
1. Draw the package map and label each with its one responsibility.
2. Trace a received block from `p2p` to a persisted post-state, naming each package it passes through.

### Debugging exercises
1. A bug appears only under load and disappears with `-race` fixes. Which part of the model is being
   violated, and where do you look?
2. `state_root` is wrong but every state field looks correct on inspection. Which package, and why?

### Code-reading assignment
- Read `internal/node/engine.go`'s `Run` select loop and list the channels it multiplexes. Then follow
  `blockprocessor.OnBlock` into `statetransition` and back out to `updateHead`.

### Questions to verify understanding
- Why must expensive XMSS proving run off the Engine's tick loop, and what breaks if it doesn't?
- Why does keeping `statetransition` pure and `forkchoice` outside the store make gean both spec-faithful
  and testable?
