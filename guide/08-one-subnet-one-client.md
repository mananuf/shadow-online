# 8. One subnet, one client (the canonical gean run)

This is the run everything else is measured against: **8 gean nodes, 1 attestation subnet, 2
aggregators, 120 s**. It is the simplest meaningful Shadow run and it exercises the full client:
proposal, gossip, attestation, aggregation, fork choice, finalization.

Config (the `[simulation]` + `[clients]` blocks; see Chapter 7 for the full file):

```toml
[simulation]
total_nodes = { min = 8, max = 8 }
total_subnets = { min = 1, max = 1 }        # → attestation_committee_count = 1
aggregators_per_subnet = { min = 2, max = 2 }
signatures_aggregation_rate = { min = 1000, max = 1000 }

[clients]
gean = { min = 1.0, max = 1.0 }
```

Run it (Chapter 7) and open the Observatory. Below is the actual result from the reference run
`hidden-hot-baboon`.

## Did it work? Yes — it finalizes

| Check | Result |
|-------|--------|
| Nodes booted + peered | 8/8, 7 peers each, full gossip mesh |
| Blocks | 14 published = 14 received (one per slot, 100% propagation) |
| Head slot | 14 |
| **Finalized slot** | **11** (a healthy 3-slot finality lag) |
| Attestations published | 120 = 15 slots × 8 validators (full participation) |
| Attestations verified | 210, on the 2 aggregators only |
| Errors / panics | none |

The single most important signal is **finalization**: the chain advanced and finalized under real
gean code, real XMSS, and modeled prover cost. That is the bar a Shadow run must clear.

## The shape of the network

Eight gean validators, each in a geographic region with a bandwidth tier, on a latency topology:

![Client distribution — 8 gean nodes](../assets/hidden-hot-baboon/client_distribution.png)

![Underlay network topology](../assets/hidden-hot-baboon/topology.png)

## Finalization, visually

The finality heatmaps are the at-a-glance health check. Rows are nodes, columns are slots, color is
the slot number each node reports. **Uniform columns = all nodes agree**; a rising staircase =
steady progress. A stalled or diverging node would show as a mismatched row.

![Chain head slot per node](../assets/hidden-hot-baboon/finality_head_heatmap.png)

![Finalized slot per node](../assets/hidden-hot-baboon/finality_finalized_heatmap.png)

Both advance together across all 8 nodes — head tracks the tip, finalized trails it by ~3 slots,
exactly as lean consensus expects.

## Block propagation

Every proposed block reached every other node. The latency view shows how long, per slot, a block
took from the proposer's publish to each node's first receipt:

![Block propagation latency](../assets/hidden-hot-baboon/block_propagation_latency.png)

![Block propagation percentiles per slot](../assets/hidden-hot-baboon/block_propagation_percentiles.png)

The percentile view (p50/p95/p99) is the one to watch at scale — p99 is the worst-case straggler.

## Attestations

Coverage measures how quickly nodes hear enough of a slot's attestations:

![Attestation coverage](../assets/hidden-hot-baboon/attestation_coverage.png)

(Chapter 11 explains exactly what "95% coverage latency" means and how to read each of these.)

## What this run proves about gean

- gean runs as a real process under Shadow on Apple Silicon.
- With the `--shadow-xmss-*-rate` flags active (1000 sig/s), gean still finalizes — i.e. modeling
  prover cost is non-disruptive at a reasonable rate, and the integration is correct.
- The aggregators (2 of 8) do the verification/aggregation work; non-aggregators don't verify
  individual attestations — which is why "attestations verified" only shows on the aggregators.

This single-client, single-subnet run is your baseline. Chapter 9 asks what happens when you want
*more than one subnet*, and surfaces an important gean limitation.
