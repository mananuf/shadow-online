# 3. What was added to the gean codebase

Everything Shadow-related in gean's main line is small, self-contained, and **off by default**.
This chapter is the precise map. All paths are in the `gean` repo.

## The cost-model package: `internal/shadow/shadow.go`

A single ~47-line, dependency-free package (it imports only `time`). It holds the rates and the
sleep logic:

```go
// internal/shadow/shadow.go
type Rates struct {
    AggregateSignatures        float64
    VerifySignature            float64
    VerifyAggregatedSignatures float64
}

func (r Rates) SleepAggregate(units int)        { sleep(r.AggregateSignatures, units) }
func (r Rates) SleepVerify()                    { sleep(r.VerifySignature, 1) }
func (r Rates) SleepVerifyAggregated(units int) { sleep(r.VerifyAggregatedSignatures, units) }

func sleep(rate float64, units int) {
    if rate <= 0 || units <= 0 {
        return
    }
    // rate is signature-units per second, so an n-unit op costs n/rate seconds.
    time.Sleep(time.Duration(float64(units) / rate * float64(time.Second)))
}
```

Key invariants encoded here:

- **Rates are signatures/second.** `sleep = units / rate` seconds (Chapter 2).
- **Zero or negative rate = no-op.** The `Rates{}` zero value is fully disabled, so a node that
  never sets the flags pays nothing.
- **The package doc requires every `Sleep*` to run off the Engine tick loop** so the node clock
  stays accurate. Two of the three call sites honor this; one does not — see Chapter 5's gotcha.

## The three CLI flags: `cmd/gean/flags.go`

Three `float64` flags, all defaulting to `0` (disabled):

```
--shadow-xmss-aggregate-signatures-rate            # cost of building an aggregate
--shadow-xmss-verify-signature-rate                # cost of verifying one gossip attestation
--shadow-xmss-verify-aggregated-signatures-rate    # cost of verifying an aggregated signature
```

Registered in `cmd/gean/flags.go` (around lines 64–66); negative values are rejected by config
validation. They are stored on the `config` struct and turned into a `shadow.Rates` in
`cmd/gean/main.go`, which is threaded into `node.New(...)` and stored on the `Engine` as
`Engine.Shadow`.

## The three injection sites — which XMSS ops are wrapped

The whole feature is three one-line calls placed immediately after the real XMSS operations:

| Op | Where | Call | Units `n` |
|----|-------|------|-----------|
| **Aggregate** | `internal/aggregation/aggregate.go:116` | `shadowRates.SleepAggregate(len(rawIDs)+len(childProofs))` | input signatures + child proofs |
| **Verify (single)** | `internal/node/gossip.go:52` | `e.Shadow.SleepVerify()` | always 1 |
| **Verify (aggregated)** | `internal/node/gossip.go:83` | `e.Shadow.SleepVerifyAggregated(int(types.BitlistCount(participants)))` | number of participants |

- The **aggregate** sleep sits right after `xmss.AggregateWithChildren(...)` inside the
  aggregation worker (which runs on its own goroutine, off the tick loop). Its comment notes that
  because aggregation is dispatched through a capacity-1 channel, a slow (sleeping) aggregator
  simply drops the next slot's work — exactly the back-pressure real hardware exhibits.
- The **single-verify** sleep sits after `attestation.VerifyGossipAttestation(...)` in
  `onGossipAttestation`, which runs in a per-attestation goroutine (off the tick loop).
- The **aggregated-verify** sleep sits after `attestation.VerifyAggregatedGossipAttestation(...)`
  in `onGossipAggregatedAttestation`. ⚠️ This one currently runs on the tick loop — see Chapter 5.

## How a value flows end to end

```
fuzzer config  signatures_aggregation_rate = 1000   (sig/s, Chapter 6)
      │  generate-shadow-yaml.sh exports GEAN_SHADOW_XMSS_* env
      ▼
gean-cmd.sh    --shadow-xmss-aggregate-signatures-rate 1000  (and the two verify flags)
      │  cmd/gean/flags.go parses to config.Shadow*Rate (float64)
      ▼
main.go        shadow.Rates{AggregateSignatures: 1000, ...}
      │  node.New(..., shadowRates)
      ▼
Engine.Shadow  → SleepAggregate / SleepVerify / SleepVerifyAggregated at the 3 call sites
```

## What was NOT touched

No state-transition, no fork-choice, no SSZ, no wire encoding. The `internal/shadow` package
imports only `time` and has zero knowledge of consensus state. The blast radius is: one new
package, three flags, a `shadow.Rates` field threaded through one constructor, and three one-line
calls. That isolation is the subject of Chapter 5.

> There is also a heavier, **off-main** `shadow` branch that carries the simulator *harness*
> itself (Docker gate runner, keygen genesis-time overrides). That is a different thing from the
> cost-model package above — Chapter 4 untangles the two.
