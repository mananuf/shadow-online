# 11. Metrics mastery — beginners to pro

This is the chapter that turns numbers into judgement. It takes you from "what even is a metric"
to diagnosing why a multi-client run stalls, in four parts:

- **Part A — Foundations** (read before any metric): what the numbers are and the one budget everything is measured against.
- **Part B — gean's live metrics** (the `/metrics` endpoint): the ~12 that matter, each with its budget and how to read it.
- **Part C — The Observatory** (post-run charts): what each rendered panel means.
- **Part D — Pro** (diagnosis): the failure chain, the aggregation-cost cliff, and how it maps to the live interop debate.

Two different metric worlds show up in these runs, and mixing them up is the first beginner trap:

| | gean's Prometheus `/metrics` | The Observatory |
|---|---|---|
| Source | scraped live from a running node | computed after the run from `stats.json` |
| Answers | "is this node keeping up *right now*?" | "how did the whole network behave?" |
| Covered in | Part B | Part C |

---

## Part A — Foundations

### A metric is one of three shapes

- **Counter** — only goes up (totals). `lean_block_building_success_total`. You read its *rate of change*, not its value.
- **Gauge** — a value that moves up and down (a snapshot). `lean_head_slot`, `lean_node_rss_bytes`.
- **Histogram** — a distribution of measurements bucketed by size, so you can ask for percentiles. `lean_tick_interval_duration_seconds`. Exposed as `_bucket{le="..."}`, `_sum`, `_count`.

**Percentiles, once and for all.** p50 is the typical case, p95/p99 are the tail. A metric can have a
fine *mean* and a terrible *p99* — that tail is usually where trouble hides. Always ask for p99 on
anything latency-shaped.

### Scraping gean's metrics

A running node serves Prometheus text at `http://<node>:<metrics-port>/metrics` (flag
`--metrics-port`, default 5054; the Shadow harness uses 8080). Under Shadow the network is sealed,
so the harness adds a collector host that scrapes each node near `stop_time` and writes the dump to
`hosts/collector/*.stdout` (see Chapter 03). Everything in Part B comes from that text.

```bash
# one node, live
curl -s localhost:5054/metrics | grep '^lean_'

# a Shadow run's captured dump
grep '^lean_tick_interval_duration_seconds' shadow-out/run1.data/hosts/collector/*.stdout
```

### The budget everything is measured against

gean runs on a fixed clock. Every budget in Part B derives from it:

- **Slot = 4 s = 5 intervals × 800 ms.** An 800 ms ticker drives the node.
- **Interval jobs:** I0 update head + propose · I1 attest + head · I2 dispatch aggregation · I3 safe-target + prune · I4 head.
- **Off-tick workers** (where slow XMSS proving runs, so it never blocks the clock): aggregation (~1600 ms session budget), proposal (~2400 ms), recovery, and one goroutine per gossip attestation (~500 ms verify each).

> **The rule everything reduces to:** work that must land within a slot has to fit its interval or
> worker budget. When it doesn't, the next tick starts late, aggregation dispatches drop, duties get
> skipped, and finalization falls behind. Part B is how you *see* that happening; Part D is how you
> *diagnose* it.

---

## Part B — gean's live metrics and their budgets

Read a node in this order — each step only matters if the one before it is healthy:

1. **Liveness** — is the chain alive?
2. **Pacing** — is the clock honest?
3. **The aggregation chain** — the usual bottleneck.
4. **Backpressure** — is the node shedding work?
5. **Resource** — is memory stable?

### 1. Liveness triple — `lean_head_slot`, `lean_current_slot`, `lean_latest_finalized_slot`
- **Budget:** finalized tracks head within ~2–3 slots; head tracks current within ~1.
- **Read:** `current − head` growing = not keeping up with import/head. `head − finalized` growing =
  justification/finalization stalling. A flat `finalized` while `current` climbs is **the** failure
  the whole exercise hunts.

### 2. Pacing — `lean_tick_interval_duration_seconds` *(histogram)*
The single most important pacing metric. Buckets are deliberately tight around 0.8 (…/0.805/0.81/0.82/…).
- **Budget:** 800 ms.
- **Read:** p99 ≤ ~0.81 s = healthy. Mass at 0.82–0.9 = the prior interval overran and stole time from
  this tick. Mass ≥ 1.0 = something expensive ran *on* the tick loop that shouldn't have.

### 3. The aggregation chain (the usual bottleneck)
- `lean_aggregation_worker_total_time_seconds` — end-to-end recursive-merge pass. **Budget ~1600 ms**; p99 climbing toward 4 s = the worker can't finish inside a slot.
- `lean_proving_duration_seconds{operation="aggregation"}` — the XMSS recursive-merge cost itself. **The core of the interop debate.** Watch it scale with validators × subnets.
- `lean_proving_duration_seconds{operation="proposal"}` — block Type-2 proof; must fit ≤ 2400 ms or the block ships late.
- `lean_block_building_payload_aggregation_time_seconds` — the proposer's own aggregation; > ~800 ms means it's eating its own interval.

### 4. Backpressure — the node telling you it couldn't keep up
- `lean_proving_queue_depth{operation="aggregation"}` *(gauge)* — the dispatch channel is **capacity 1**. Expect 0; a sustained 1 means the worker is a full slot behind.
- `lean_aggregation_dispatch_dropped_total` *(counter)* — a whole aggregation cycle silently dropped at I2 because the worker was still busy. **Expect 0; any increase is a headline failure signal.**
- `lean_node_blocks_skipped_lag_total` / `lean_node_attestations_skipped_lag_total` — duty-gate skips from a stale view. Expect 0.

### 5. Resource — `lean_node_rss_bytes` *(gauge)*
Includes the XMSS prover arena *outside* the Go heap. A steady climb under load = buffers/proofs
accumulating faster than they're pruned → OOM risk. Watch alongside `lean_pending_attestations_total`.

### Supporting (context, not budgeted)
`lean_proof_merge_components` and `lean_block_aggregated_payloads` show how deep the recursive merge
got — the driver behind the metric-3 numbers as committee/validator count grows. `lean_connected_peers`
and `lean_gossip_mesh_peers` confirm the mesh even formed.

> **Budget cheat-sheet.** tick ≤ 810 ms · aggregation worker ≤ 1600 ms · proposal proving ≤ 2400 ms ·
> per-attestation verify ~500 ms · drops/skips/queue = 0 · finalized within ~3 slots of head.

---

## Part C — The Observatory (post-run charts)

The Observatory page for a run is a notebook (`notebooks/analysis.ipynb`) executed against the run's
`stats.json` and rendered to HTML. Each chart reads a field of `stats.json` that
`shadow_fuzzer/stats_shadow.py` computed from the per-node logs. Images below are from the reference
gean run `hidden-hot-baboon`.

> **Timing convention.** All `*_ms` values are offsets from genesis in milliseconds. Under Shadow "ms"
> is *virtual* time, so latencies reflect the simulated network + modeled prover cost, not your laptop.

### §1 Run overview
- **Client distribution** (`stats.node_distribution.clients`) — how the weighted `[clients]` sampling actually landed. A client can get 0 nodes.

  ![Client distribution](../assets/hidden-hot-baboon/client_distribution.png)
- **Region & bandwidth tiers** (`regions.json` / `bandwidths.json`) — where nodes sit and their link speed; these drive the topology latencies.

  ![Region & bandwidth distribution](../assets/hidden-hot-baboon/region_bandwidth_distribution.png)
- **Gossipsub bandwidth by topic** (`stats.bandwidth.slots`) — gossip bytes per topic split by aggregator vs non-aggregator; quantifies the extra load aggregators carry. "No bandwidth events" is a data-availability gap for gean-only runs, not a network problem.

### §2 Block propagation
Reads `stats.blocks.slots` — per slot: proposer, publish time, block size, each host's first-receive time.
- **Latency scatter** — `receive_ms − published_ms` per host per slot.

  ![Block propagation latency](../assets/hidden-hot-baboon/block_propagation_latency.png)
- **Percentiles per slot** — p50/p95/p99 by slot. p50 is the typical node; **p99 is the worst-case tail** — watch it climb as you add nodes or slower links.

  ![Block propagation percentiles](../assets/hidden-hot-baboon/block_propagation_percentiles.png)
- **Block size per slot** — payload growth as attestations accumulate.

  ![Block size per slot](../assets/hidden-hot-baboon/block_size_per_slot.png)

### §3 Attestation coverage
- **Coverage latency** (`stats.attestations.coverage`) — time for p50/p90/p95 of nodes to each hear ≥95% of a slot's attestations. **Rising p95 = stragglers.**

  ![Attestation coverage](../assets/hidden-hot-baboon/attestation_coverage.png)
- **Per-validator propagation CDF** — one validator's attestation reaching every node; a sharp rise then flat near 1.0 = fast even propagation, a long tail = laggards.

  ![Attestation validator CDF](../assets/hidden-hot-baboon/attestation_validator_cdf.png)
- **Aggregated-attestation CDF** — same for an aggregate; can be empty for gean-only runs where the parser doesn't emit aggregation events yet (Chapter 10). Finalization still proves aggregates flowed.

### §4 Chain finality — the most important panel
Reads `stats.chain_status.slots` — each node's head/justified/finalized per slot from "CHAIN STATUS"
log lines. Client-agnostic, so it populates even when event-level stats don't. Two heatmaps (rows =
nodes, columns = slots, color = slot value):

![Chain head slot heatmap](../assets/hidden-hot-baboon/finality_head_heatmap.png)

![Finalized slot heatmap](../assets/hidden-hot-baboon/finality_finalized_heatmap.png)

**How to read them:** within a column all nodes should show the same color (**agreement**); left-to-right
the colors should brighten steadily (**progress**). A row stuck dark while others advance = a stalled
node. A finalized heatmap that never brightens = the chain **justified but never finalized** — the
classic thing a Shadow run is meant to catch.

### §5 Network topology
`topology.gml` rendered as a graph, nodes colored by region — the underlay behind every propagation
number above.

![Network topology](../assets/hidden-hot-baboon/topology.png)

---

## Part D — Pro: diagnosis

### The failure chain (memorize this)
When a run degrades, the symptoms appear in a fixed order. Learn the chain and you can name the cause
from any single link:

```
proving_duration{aggregation} rises            (recursive merge gets expensive)
      |
aggregation_worker_total_time crosses ~1.6s    (a pass no longer fits the session budget)
      |
aggregation "truncated" fires                  (the worker sheds the rest of the pass)
      |
aggregation_dispatch_dropped_total climbs      (whole cycles skipped at I2)
proving_queue_depth{aggregation} pins at 1     (worker a full slot behind)
      |
tick_interval_duration p99 drifts past 0.82s   (the clock starts slipping)
      |
head - finalized widens -> finalized stalls    (the Observatory finalized heatmap stops brightening)
```

### The aggregation-cost cliff
gean does **deep recursive XMSS proof aggregation** — each pass re-merges accumulated child proofs
plus raw signatures, so cost scales with (raw + children) per pass. In the Shadow rate sweep it climbs
predictably as you scale load:

| load | aggregation / pass | result |
|---|---|---|
| 3 val, no cost | ~32 ms | finalizes |
| 16 val × 4 subnets | ~338 ms | finalizes |
| rate 16 sig/s | ~1.1 s | finalizes, first shed |
| rate 8 sig/s | ~2.2 s (over budget) | **finalization stalls** |

The cliff sits right where per-pass aggregation crosses the ~1.6 s session budget. That is the whole
story of the interop debate in one line.

### Mapping to the live interop debate
On a real multi-client devnet the same metrics tell the story on real hardware: gean's aggregation
runs mean ~0.8–1.2 s / p99 up to ~3.2 s (over budget), while clients that aggregate flatter run ~0.2 s.
Slow aggregation → aggregate throughput falls → weaker fork-choice weight → finality drags. The spec
fixes the *form* of a block (aggregated attestations + one block proof; raw signatures on-chain are
invalid), so the levers are: **cheaper/flatter aggregation** where the prover allows it, and **bounding
per-pass work to the budget** so the node keeps producing valid aggregates every slot instead of
shedding whole cycles.

## Reading a run in 30 seconds
1. **Finalized heatmap** advancing uniformly (or `head − finalized` small)? → healthy. If not, stop and debug.
2. **tick p99** ≤ ~0.81 s? → the clock is honest.
3. **Drop / skip counters** flat at 0 and **queue depth** ~0? → no shed work.
4. **Block propagation p99** flat and low? → gossip keeps up.
5. **Client distribution / warnings** as expected? → no collection gaps.

Everything else is detail you reach for when one of those five looks wrong.
