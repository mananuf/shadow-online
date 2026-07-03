# 3. What was added to the gean codebase

Everything Shadow-related in gean is small, self-contained, and **off by default**. This chapter is
the precise map. All paths are in the `gean` repo.

gean follows the same pattern as every other lean client (zeam, lantern): it ships **only** the
prover-cost model + flags and publishes an image; the **lean-shadow-fuzzer** (Chapter 6) drives it.
There is no Shadow harness in the gean repo — see Chapter 4.

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
otherwise the rate stays `0` (disabled). The resolved values are stored on the `config` struct,
turned into a `shadow.Rates` in `cmd/gean/main.go`, threaded into `node.New(...)`, and stored on the
`Engine` as `Engine.Shadow`.

**In practice the fuzzer drives the flags, not the env fallback.** The fuzzer's
`scripts/client-cmds/gean-cmd.sh` passes gean the `--shadow-xmss-*-rate` flags directly. The env
fallback (`resolveShadowRates`) remains a supported generic mechanism for any harness that prefers
injecting rates through the environment, but nothing in the current flow uses it — gean's own
harness, which did, has been removed (Chapter 4).

> **Naming caveat (lean-shadow-fuzzer).** The fuzzer's `gean-cmd.sh` reads *shorter* env names —
> `GEAN_SHADOW_XMSS_AGGREGATE_RATE`, `GEAN_SHADOW_XMSS_VERIFY_RATE`,
> `GEAN_SHADOW_XMSS_VERIFY_AGGREGATED_RATE` — and translates them into the `--shadow-xmss-*-rate`
> **flags** itself. So the fuzzer path works regardless of gean's env names (it goes through flags).
> gean's env fallback uses the longer `…_SIGNATURES_RATE` names that match the flags one-to-one. If
> you ever want a harness to drive gean's env fallback *directly*, align the two name sets — a small
> cleanup noted in Chapter 5.

## The three injection sites — which XMSS ops are wrapped

The whole feature is three one-line calls placed immediately after the real XMSS operations:

| Op | Where | Call | Units `n` |
|----|-------|------|-----------|
| **Aggregate** | `internal/aggregation/aggregate.go` (`shadowRates.SleepAggregate(...)`, just after `xmss.AggregateWithChildren`) | `len(rawIDsBuf)+len(childProofsBuf)` | input signatures + child proofs |
| **Verify (single)** | `internal/node/gossip.go` (`e.Shadow.SleepVerify()` in `onGossipAttestation`) | always 1 |
| **Verify (aggregated)** | `internal/node/gossip.go` (`e.Shadow.SleepVerifyAggregated(...)` in `onGossipAggregatedAttestation`) | `types.BitlistCount(participants)` |

> Line numbers shift as work lands; grep for `Sleep` in those two files rather than trusting a fixed
> line. The aggregation worker also gained a self-calibrating budget-trim (it bounds each pass to the
> session budget), but the sleep *call* is unchanged — it still wraps the same FFI op, and the
> estimator observes the post-sleep duration, so under Shadow it calibrates to the modeled cost.

- The **aggregate** sleep sits right after `xmss.AggregateWithChildren(...)` inside the aggregation
  worker (which runs on its own goroutine, off the tick loop). Because aggregation is dispatched
  through a capacity-1 channel, a slow (sleeping) aggregator drops the next slot's work — exactly the
  back-pressure real hardware exhibits.
- The **single-verify** sleep sits after `attestation.VerifyGossipAttestation(...)` in
  `onGossipAttestation`, which runs in a per-attestation goroutine (off the tick loop).
- The **aggregated-verify** sleep sits after `attestation.VerifyAggregatedGossipAttestation(...)`
  in `onGossipAggregatedAttestation`. ⚠️ This one currently runs on the tick loop — see Chapter 5.

## How a value flows end to end

One path — the fuzzer:

```
fuzzer config   signatures_aggregation_rate = 1000   (sig/s, Chapter 6)
      │  generate-shadow-yaml.sh exports GEAN_SHADOW_XMSS_*_RATE per host
      ▼
gean-cmd.sh     --shadow-xmss-aggregate-signatures-rate 1000  (translates env → flags)
      ▼
cmd/gean/flags.go  resolveShadowRates → config.Shadow*Rate (float64)
      ▼
main.go         shadow.Rates{AggregateSignatures: 1000, ...}
      │  node.New(..., shadowRates)
      ▼
Engine.Shadow   → SleepAggregate / SleepVerify / SleepVerifyAggregated at the 3 call sites
```

The fuzzer resolves a concrete rate from its `config.toml`, hands gean the matching flags, and the
binary does the rest. No harness, no argv rewriting from gean's side.

## What was NOT touched

No state-transition, no fork-choice, no SSZ, no wire encoding. The `internal/shadow` package imports
only `time` and has zero knowledge of consensus state. The blast radius is: one new package, three
flags, a `shadow.Rates` field threaded through one constructor, and three one-line calls. That
isolation is the subject of Chapter 5.

> gean used to ship a bespoke in-repo harness (a `shadow.yaml` generator, a gate runner, a Dockerfile,
> Makefile targets, a CI gate). That has been **removed** so gean matches every other client: it
> contributes only the cost model + flags and publishes `ghcr.io/geanlabs/gean:shadow`, which the
> fuzzer pulls. Chapter 4 covers the branch and the image; Chapter 6 covers the fuzzer that drives it.
