# 13. Reference cheat-sheet

One page. Everything you reach for repeatedly.

## gean Shadow flags (default 0 = disabled)

| Flag | Env fallback (gean) | Wraps | Units `n` |
|------|---------------------|-------|-----------|
| `--shadow-xmss-aggregate-signatures-rate` | `GEAN_SHADOW_XMSS_AGGREGATE_SIGNATURES_RATE` | building an aggregate (`AggregateWithChildren`) | raw sigs + child proofs |
| `--shadow-xmss-verify-signature-rate` | `GEAN_SHADOW_XMSS_VERIFY_SIGNATURE_RATE` | verifying one gossip attestation | 1 |
| `--shadow-xmss-verify-aggregated-signatures-rate` | `GEAN_SHADOW_XMSS_VERIFY_AGGREGATED_SIGNATURES_RATE` | verifying an aggregated signature | participant count |

Semantics: **rate is signatures/second**; an `n`-signature op sleeps `n / rate` **seconds**.
`rate = 1000` ⇒ ~1 ms/sig. `rate = 0` (default) ⇒ no sleep. Higher rate = faster prover = less sleep.
Resolution precedence: **flag > env > 0**.

```
sleep_seconds = n_signatures / rate_sig_per_second
```

⚠️ Keep `--shadow-xmss-verify-aggregated-signatures-rate` modest — it currently sleeps on the tick
loop (Chapter 5).

> **Fuzzer env names differ.** The lean-shadow-fuzzer's `gean-cmd.sh` sets the shorter
> `GEAN_SHADOW_XMSS_{AGGREGATE,VERIFY,VERIFY_AGGREGATED}_RATE` and converts them to the flags above
> (it works through flags). gean's own env fallback uses the longer `…_SIGNATURES_RATE` names that
> mirror the flags exactly (Chapter 3).

## The gean Shadow image

gean ships **no in-repo harness** — the fuzzer drives it. All gean provides is one image that
understands the `--shadow-xmss-*` flags, published at `ghcr.io/geanlabs/gean:shadow`.

```bash
docker pull ghcr.io/geanlabs/gean:shadow     # published image the fuzzer references
cd ../gean && make docker-build              # or build locally; also tags :shadow
```

## gean code map

| Thing | Location |
|-------|----------|
| Cost-model package | `internal/shadow/shadow.go` |
| Flags + env fallback | `cmd/gean/flags.go` (`resolveShadowRates`) |
| Aggregate sleep | `internal/aggregation/aggregate.go` (after `xmss.AggregateWithChildren`) |
| Single-verify sleep | `internal/node/gossip.go` (`onGossipAttestation`) |
| Aggregated-verify sleep | `internal/node/gossip.go` (`onGossipAggregatedAttestation`) |
| Committee-count constant | `internal/types/constants.go` (`AttestationCommitteeCount = 1`) |
| Genesis committee check | `internal/genesis/load.go` |
| keygen genesis overrides | `cmd/keygen` (`--genesis-time` / `--genesis-delay`) |
| Auto-rebase CI | `.github/workflows/shadow-rebase.yml` |
| Fuzzer gean integration | `geanlabs/lean-shadow-fuzzer` (`gean-cmd.sh`, `clients/gean.py`) |

## fuzzer config knobs (`config.toml`)

| Knob | Meaning |
|------|---------|
| `[fuzzer].max_runs` | runs in the sweep |
| `[fuzzer].duration_secs` | simulated seconds per run |
| `[fuzzer].seed` | base seed (run seed = seed + run_index) |
| `[fuzzer].runner` | `docker-arm` (Mac) or `local` (Linux host shadow) |
| `[fuzzer].render_notebooks` | auto-render the Observatory after each run |
| `[simulation].total_nodes` | validator nodes |
| `[simulation].total_subnets` | attestation subnets → `attestation_committee_count` (**gean: must be 1**) |
| `[simulation].aggregators_per_subnet` | aggregators sampled per subnet |
| `[simulation].signatures_aggregation_rate` | sig/s → each client's shadow rates |
| `[clients].<name>` | `{min,max}` sampling weight (normalized; can be 0) |
| `[client_images.<name>]` | `image` + `executable`; **required for every `[clients]` entry**, arm64 |

Derived automatically: subnet membership = `i % total_subnets`; `--aggregate-subnet-ids 0..N-1`
(aggregators, multi-subnet only); committee count flows config → validator-config → genesis → CLI.

## Commands

```bash
# get the gean image
docker pull ghcr.io/geanlabs/gean:shadow                   # published image
cd ../gean && make docker-build                            # or build locally (tags :shadow)
docker run --rm ghcr.io/geanlabs/gean:shadow --help | grep shadow   # verify flags

# fuzzer deps
uv sync && uv sync --group notebooks

# dry run / real run
uv run shadow-fuzzer.py --dry-run config.toml
uv run shadow-fuzzer.py --clean-output config.toml          # omit --clean-output to keep old runs
uv run shadow-fuzzer.py --run-index 1 config.toml           # re-run one run of a sweep

# newest run id
ls -dt fuzzer-output/*/ | head -1

# regenerate stats.json from logs (no Shadow re-run)
RUN=fuzzer-output/<run-id>
uv run python -c "import json; from shadow_fuzzer import stats_shadow; \
  m=json.load(open('$RUN/run-metadata.json')); \
  json.dump(stats_shadow.collect_stats('$RUN', m), open('$RUN/stats.json','w'), indent=2)"

# render Observatory for a run
uv run python scripts/render_notebooks.py --run-dir $RUN
cd site && npx astro dev --port 4321                        # http://localhost:4321

# regenerate the guidebook chart PNGs
uv run --with kaleido --with networkx --with pyyaml python \
  ../shadow/scripts/export_charts.py $RUN ../shadow/assets/<run-id>

# inspect node logs (gean logs to stderr; strip ANSI)
sed -E 's/\x1b\[[0-9;]*m//g' $RUN/shadow.data/hosts/<node>/*.stderr | less
grep -liE "panic|fatal|error" $RUN/shadow.data/hosts/*/*.stderr
```

## The 30-second health read (from Chapter 11)

1. Finalized heatmap advancing uniformly? → healthy.
2. Block propagation p99 low/flat? → gossip keeping up.
3. Attestation coverage p95 flat? → attestations on time.
4. Client distribution as intended?
5. Warnings section empty?

## gean capability boundaries (devnet-5)

- **Subnets:** 1 only (`AttestationCommitteeCount = 1`).
- **Shadow rates:** aggregate + single-verify are off-loop (safe); aggregated-verify is on-loop (use modest values).
- **Platform for Shadow:** Linux only, **native arch**. The fuzzer uses arm64 `kamilsa/shadow-arm`
  → runs natively on Apple Silicon and `ubuntu-24.04-arm` CI. Don't emulate cross-arch (an amd64
  Shadow fails under QEMU with `pidfd_open`, Chapter 12).
- **Genesis under Shadow:** anchor to `SHADOW_EPOCH` (946684800, 2000-01-01), not wall-clock, or no slot fires.
