# 9. Multiple subnets, one client

This chapter covers how the fuzzer expresses multiple attestation subnets — and a hard fact you
must know up front: **gean (devnet-5) only supports a single subnet today.** So the "multiple
subnets, one client" case is fully runnable for clients that support it, but for *gean* it is a
documented limitation, not a live run. We're honest about that here rather than fake a result.

## How the fuzzer configures subnets

Only three knobs matter, and everything else is derived:

```toml
[simulation]
total_nodes = { min = 16, max = 16 }
total_subnets = { min = 4, max = 4 }          # the lever
aggregators_per_subnet = { min = 1, max = 2 }
```

What the fuzzer does with `total_subnets = N`:

1. Writes `attestation_committee_count: N` into the run's `validator-config.yaml`.
2. `generate-genesis.sh` copies that into the genesis `config.yaml` as `ATTESTATION_COMMITTEE_COUNT:
   N`.
3. Buckets validators into subnets by **index modulo N** (`subnet = i % N`), round-robin.
4. For each subnet, randomly samples `aggregators_per_subnet` validators and marks them
   `isAggregator: true`.
5. Derives the aggregate-subnet-id CSV as `0,1,…,N-1`. `parse-vc.sh` passes
   `--attestation-committee-count N` to every node, and `--aggregate-subnet-ids 0,…,N-1` to
   aggregators **only when N > 1** (an aggregator must subscribe to every subnet's topics).

So to go from one subnet to four, you change exactly one number: `total_subnets`.

## ⛔ Why gean can't run this yet

gean pins the committee count at compile time and **rejects** any genesis that disagrees:

```go
// internal/types/constants.go
AttestationCommitteeCount = 1
```

```go
// internal/genesis/load.go
if gc.AttestationCommitteeCount != nil &&
   *gc.AttestationCommitteeCount != types.AttestationCommitteeCount {
    return fmt.Errorf("ATTESTATION_COMMITTEE_COUNT=%d disagrees with gean's %d",
        *gc.AttestationCommitteeCount, types.AttestationCommitteeCount)
}
```

There is even a test, `TestLoadGenesisConfigRejectsWrongCommitteeCount`, asserting this is
deliberate. So if you set `total_subnets = 4` with gean, every gean node fatally exits at startup:

```
ERROR [node] load genesis config: ATTESTATION_COMMITTEE_COUNT=4 disagrees with gean's 1
fatal: ATTESTATION_COMMITTEE_COUNT=4 disagrees with gean's 1
```

and Shadow reports `managed processes in unexpected final state`. This is exactly what happens —
it's reproducible, and it's the correct gean behavior: the constant is sized for the devnet-5
milestone (low validator counts, one subnet). Multi-subnet support is future work that would lift
`AttestationCommitteeCount` from a constant to a configured value and remove the genesis check.

## What to do instead

- **For gean:** keep `total_subnets = 1`. That is the only valid value for gean today.
- **To exercise multi-subnet in the fuzzer:** use a client that supports it. Any client whose
  arm64 image is available and that accepts `ATTESTATION_COMMITTEE_COUNT > 1` can run the 4-subnet
  config above; the fuzzer machinery (bucketing, aggregator selection, subnet-id CSV) is
  client-agnostic and works unchanged.

## The takeaway for "mastering the client"

This is a perfect example of why Shadow runs matter: a config that *looks* fine
(`total_subnets = 4`) surfaces a real client capability boundary immediately and reproducibly. The
fuzzer didn't fail — **gean correctly refused an unsupported configuration.** Knowing where your
client's limits are is half of mastering it. When gean grows multi-subnet support, this chapter's
config will run for gean unchanged, and you'll read it with the metrics of Chapter 11.
