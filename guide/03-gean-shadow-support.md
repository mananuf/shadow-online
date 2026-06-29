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

## The three CLI flags (and their env fallback): `cmd/gean/flags.go`

Three `float64` flags, all defaulting to `0` (disabled), each with a matching environment-variable
fallback:

| Flag | Env fallback | Cost of |
|------|--------------|---------|
| `--shadow-xmss-aggregate-signatures-rate` | `GEAN_SHADOW_XMSS_AGGREGATE_SIGNATURES_RATE` | building an aggregate |
| `--shadow-xmss-verify-signature-rate` | `GEAN_SHADOW_XMSS_VERIFY_SIGNATURE_RATE` | verifying one gossip attestation |
| `--shadow-xmss-verify-aggregated-signatures-rate` | `GEAN_SHADOW_XMSS_VERIFY_AGGREGATED_SIGNATURES_RATE` | verifying an aggregated signature |

Registered in `cmd/gean/flags.go`; negative values are rejected by config validation. Resolution
precedence is **flag > env > 0**: if you pass the flag it wins; otherwise the env var is read;
otherwise the rate stays `0` (disabled). This env fallback (added in `resolveShadowRates`) lets a
Shadow harness inject per-node rates through the environment without rewriting argv — exactly how
gean's own `shadow/gen_shadow_yaml.sh` drives them. The resolved values are stored on the `config`
struct, turned into a `shadow.Rates` in `cmd/gean/main.go`, threaded into `node.New(...)`, and
stored on the `Engine` as `Engine.Shadow`.

> **Naming caveat (lean-shadow-fuzzer).** The fuzzer's `scripts/client-cmds/gean-cmd.sh` uses
> *shorter* env names — `GEAN_SHADOW_XMSS_AGGREGATE_RATE`, `GEAN_SHADOW_XMSS_VERIFY_RATE`,
> `GEAN_SHADOW_XMSS_VERIFY_AGGREGATED_RATE` — and translates them into the `--shadow-xmss-*-rate`
> **flags** itself. So the fuzzer path works regardless of gean's env names (it goes through flags).
> gean's own env fallback uses the longer `…_SIGNATURES_RATE` names that match the flags one-to-one.
> If you want the fuzzer to drive gean's env fallback *directly* (no flag translation), align the
> two name sets — a small future cleanup, noted in Chapter 5.

## The three injection sites — which XMSS ops are wrapped

The whole feature is three one-line calls placed immediately after the real XMSS operations:

| Op | Where | Call | Units `n` |
|----|-------|------|-----------|
| **Aggregate** | `internal/aggregation/aggregate.go` (`shadowRates.SleepAggregate(...)`, just after `xmss.AggregateWithChildren`) | `len(rawIDsBuf)+len(childProofsBuf)` | input signatures + child proofs |
| **Verify (single)** | `internal/node/gossip.go` (`e.Shadow.SleepVerify()` in `onGossipAttestation`) | always 1 |
| **Verify (aggregated)** | `internal/node/gossip.go` (`e.Shadow.SleepVerifyAggregated(...)` in `onGossipAggregatedAttestation`) | `types.BitlistCount(participants)` |

> Line numbers shift as `devnet-5` lands; grep for `Sleep` in those two files rather than trusting a
> fixed line. After the `devnet-5` merge the aggregate site moved (the worker gained a proving-gate
> and a per-session deadline), but the *call* is unchanged — the sleep still wraps the same FFI op.

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
      │  generate-shadow-yaml.sh exports GEAN_SHADOW_XMSS_*_RATE env
      ▼
gean-cmd.sh    --shadow-xmss-aggregate-signatures-rate 1000  (translates env → flags)
      │
      │   ── OR, gean's own harness: shadow/gen_shadow_yaml.sh puts
      │      GEAN_SHADOW_XMSS_*_SIGNATURES_RATE in each host's environment,
      │      and gean reads it directly via the env fallback (flag > env > 0)
      ▼
cmd/gean/flags.go  resolveShadowRates → config.Shadow*Rate (float64)
      ▼
main.go        shadow.Rates{AggregateSignatures: 1000, ...}
      │  node.New(..., shadowRates)
      ▼
Engine.Shadow  → SleepAggregate / SleepVerify / SleepVerifyAggregated at the 3 call sites
```

Two ways in, same destination: the **fuzzer** hands gean *flags* (translating its own env names),
while gean's **own harness** sets gean's `GEAN_SHADOW_*` env vars and lets the binary read them.

## What was NOT touched

No state-transition, no fork-choice, no SSZ, no wire encoding. The `internal/shadow` package
imports only `time` and has zero knowledge of consensus state. The blast radius is: one new
package, three flags, a `shadow.Rates` field threaded through one constructor, and three one-line
calls. That isolation is the subject of Chapter 5.

> The simulator *harness* (Docker gate runner, `shadow/gen_shadow_yaml.sh`, keygen genesis-time
> overrides, the CI gate) is a separate, heavier layer that now lives alongside this cost model on
> the consolidated `feat/shadow-sim-xmss-rates` branch — Chapter 4 untangles the two and explains
> why having both on one branch does not affect interop runs.
