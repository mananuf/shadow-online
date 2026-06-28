# 5. Maintaining gean's Shadow code

This chapter answers three operational questions: how often will gean's Shadow code need to change,
what should you watch when touching it, and the one real correctness gotcha that exists today.

## How often will it change?

**Rarely.** The cost-model package is consensus-agnostic and imports only `time`, so gean's
frequent churn — spec bumps, fork-choice tweaks, state-transition fixes on `devnet-5` — does not
touch it. The realistic sources of change are narrow:

1. **Signature-API renames at the three call sites.** The sleeps sit next to three concrete XMSS
   operations. If any of these is renamed or re-signatured, the call site must follow:
   - `xmss.AggregateWithChildren(...)` — `internal/aggregation/aggregate.go`
   - `attestation.VerifyGossipAttestation(...)` — `internal/node/gossip.go`
   - `attestation.VerifyAggregatedGossipAttestation(...)` — `internal/node/gossip.go`
2. **The fuzzer's rate convention changing.** If the lean-shadow-fuzzer changes what
   `signatures_aggregation_rate` means or adds new rate knobs, gean's flags / `gean-cmd.sh`
   mapping update accordingly.
3. **The harness branch rebasing.** Independent of the cost model — handled by the auto-rebase CI
   (Chapter 4).

That's it. There is no coupling to block production, attestation validity, hashing, or SSZ, so
spec work won't drag the Shadow code along.

## What to look out for when improving the Shadow code

- **Keep it default-off.** Any new rate or knob must be a no-op at its zero value. A production
  node must never sleep. The guard `if rate <= 0 || units <= 0 { return }` is the contract.
- **Keep sleeps off the Engine tick loop.** gean's `Engine` is single-threaded over a `select`
  loop; the tick drives slot/interval timing. A sleep on that goroutine *delays the clock itself*.
  Expensive work (proving, verifying) is supposed to run on dedicated goroutines (the aggregation
  worker; the per-attestation verify goroutines). Any new sleep must live there too.
- **Don't let the sleep change behavior, only timing.** The calls sit *after* the real operation
  and never alter its inputs, outputs, or validity decision. Preserve that.
- **Match the cross-client unit.** Rates are signatures/second so gean is numerically comparable to
  other clients in a mixed sweep. Don't silently switch to "a flat delay" or "nanoseconds."
- **Mind the capacity-1 aggregation channel.** A larger aggregate sleep means the aggregation
  worker holds the slot longer and the next dispatch is dropped. That is *intended* back-pressure,
  but if you change the channel or the worker, re-check that a slow prover degrades gracefully
  rather than deadlocks.

## ⚠️ The known gotcha: aggregated-verify sleeps on the tick loop

There is one real bug to be aware of (and ideally fix). Two of the three sleeps correctly run off
the tick loop:

- `SleepAggregate` runs in the aggregation worker goroutine. ✅
- `SleepVerify` runs in a per-attestation goroutine (`go e.onGossipAttestation(...)`). ✅

But `SleepVerifyAggregated` is called from `onGossipAggregatedAttestation`, and that handler is
invoked **synchronously on the Engine's `select` loop**:

```go
// internal/node/dispatch.go
case <-ticks:
    e.onTick()
case agg := <-e.AggregationCh:
    e.onGossipAggregatedAttestation(agg)   // <-- same goroutine as onTick
```

So a **non-zero `--shadow-xmss-verify-aggregated-signatures-rate` blocks the node's clock** during
the sleep, contradicting the `shadow` package's own "must run off the tick loop" invariant. The
node would lose tick accuracy in proportion to how much aggregated-verify cost you model.

**Implications for you today:**

- If you only set `--shadow-xmss-aggregate-signatures-rate` and
  `--shadow-xmss-verify-signature-rate`, you are safe — both are off-loop.
- If you set the **aggregated-verify** rate, keep it small, or expect tick skew. For the runs in
  this guide we drive all three from the fuzzer's single rate; at `1000` sig/s the aggregated-verify
  sleep is a few milliseconds and the effect is minor, but it is real.

**The fix** (future work) is to move aggregated-attestation handling — or just the sleep — off the
`select` loop onto its own goroutine, the way single-attestation verification already is. Until
then, this is the first thing to check if a Shadow run with a high aggregated-verify rate shows
the gean nodes drifting off slot time.

> This gotcha is a good example of the maintenance mindset: the Shadow code is simple, but it lives
> next to gean's concurrency model, and *that* is where the care is required — not in the arithmetic.
