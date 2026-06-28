# 2. Why prover cost must be modeled

## The problem in one sentence

Shadow does not advance virtual time for CPU work, so gean's slow XMSS signature operations would
run "for free" — making the simulation miss the single biggest factor in real lean-consensus
timing.

## Why XMSS makes this acute

Lean consensus uses **XMSS** — post-quantum, hash-based signatures — implemented in Rust and called
from gean over CGo FFI. These operations are *expensive* by design:

- **Aggregating** many validators' signatures into one proof is heavy prover work.
- **Verifying** a single attestation signature takes on the order of hundreds of milliseconds.
- **Verifying an aggregated** signature scales with the number of participants.

On real hardware these costs shape everything: whether an aggregator can finish within its slot,
whether a node keeps up with gossip, whether the chain finalizes under load. They are the dominant
term in the timing budget.

Under Shadow, with CPU time uncharged, all of that work collapses to ~0 simulated time. A node
would appear to verify thousands of signatures instantly and aggregate without cost. The
simulation would happily "finalize" under conditions that would melt a real node — telling you
nothing about real interop behavior.

## The fix every client adopts: artificial virtual-time sleeps

The agreed approach across lean clients is to **inject artificial sleeps** that consume *virtual*
time in proportion to the prover work being done. When gean performs an XMSS operation on `n`
signatures, it also sleeps for a configured amount of virtual time, so Shadow's clock advances as
if the CPU work had taken that long.

This is **only** enabled inside Shadow runs. The sleeps are driven by command-line flags that
default to *disabled*, so a real gean node on a devnet never sleeps and is completely unaffected.

The rate is expressed in **signatures per second** (sig/s), matching the convention the other
clients and the fuzzer use. An operation on `n` signatures sleeps `n / rate` **seconds**:

```
sleep_seconds = n_signatures / rate_sig_per_second
```

So `rate = 1000` means "this prover can do 1000 signatures/second," i.e. ~1 ms per signature. A
lower rate models a slower prover and produces longer sleeps. A rate of `0` (the default) disables
the sleep entirely.

> **Why sig/s and not "just a delay"?** The lean-shadow-fuzzer feeds a single
> `signatures_aggregation_rate` (in sig/s) to every client so one sweep config reasons about all
> clients uniformly. gean consumes that same number, so its sleeps are numerically comparable to
> Lantern's and the others'. Chapter 3 shows the exact code; Chapter 13 has the formula on the
> cheat-sheet.

## What "Shadow-compatible" means for gean, precisely

It means three things, and nothing more:

1. gean can model XMSS prover cost as virtual-time sleeps, controlled by flags (Chapter 3).
2. gean runs correctly as a process launched by Shadow inside the fuzzer's container (Chapters
   7–8).
3. gean's logs are parseable by the fuzzer's analysis so its runs show up in the Observatory
   (Chapter 10).

It does **not** mean any change to consensus logic. The prover-cost model is pure latency
injection and is invisible when the flags are unset.
