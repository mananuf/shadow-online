# 6. The lean-shadow-fuzzer

The **lean-shadow-fuzzer** (`../lean-shadow-fuzzer`) is the harness that actually drives Shadow.
You don't hand-write `shadow.yaml` files; you give the fuzzer one `config.toml` and it does
everything: samples a concrete network, generates genesis and keys, builds a topology, writes
`shadow.yaml`, runs Shadow, collects stats, and renders an analysis website.

Its tagline is "**randomized reproducible Shadow network simulation sweeps**." You describe a
*space* of networks with `{min, max}` ranges; for each run it resolves concrete values from
`seed + run_index`, so a sweep is reproducible and a single run is deterministic.

## The pipeline, end to end

```
config.toml
   │  resolve {min,max} ranges with seed+run_index
   ▼
[per run]
   1. sample clients          → which client runs on each of N nodes ([clients] weights)
   2. write validator-config  → committee count, per-node identity, aggregator flags
   3. generate genesis + keys  → config.yaml, genesis.ssz, hash-sig keys, *.key files
   4. generate topology        → topology.gml (regions, latencies), bandwidths.json
   5. write shadow.yaml         → one host per node, each with its client launch command
   6. run Shadow                → inside the docker-arm container; real binaries, virtual time
   7. collect stats             → parse every node's logs → stats.json
   8. render notebooks          → site/rendered/<run>/analysis.html + manifest.json
```

## Key pieces of the repo

| Path | Role |
|------|------|
| `shadow-fuzzer.py` | The entry point. Resolves config, samples clients, orchestrates a run. |
| `config.toml` | Your run/sweep configuration (the only file you normally edit). |
| `scripts/generate-genesis.sh` | Builds `config.yaml`, genesis state, keys from validator-config. |
| `scripts/generate-shadow-yaml.sh` | Writes `shadow.yaml`; **sources each `client-cmds/<c>-cmd.sh`** to get per-node args. |
| `scripts/client-cmds/<client>-cmd.sh` | Per-client launch command (flags, paths). One per client. |
| `shadow_fuzzer/stats_shadow.py` | Parses logs into `stats.json` (the metric definitions). |
| `shadow_fuzzer/clients/<client>.py` | Per-client **log parser** so its events show up in stats. |
| `notebooks/analysis.ipynb` | The analysis that becomes the Observatory page. |
| `site/` | The Astro "Observatory" web UI that renders runs. |

## How a client is "integrated"

For the fuzzer to run client `X`, four things must exist:

1. A **docker image** for `X` (referenced in `[client_images.X]`), available for your arch.
2. `scripts/client-cmds/X-cmd.sh` — turns the fuzzer's per-node env into `X`'s CLI.
3. `shadow_fuzzer/clients/X.py` — a log parser so `X`'s block/attestation events populate stats.
4. An `[client_images.X]` entry and a `[clients]` weight when you want `X` in a run.

gean has all four. (The parser, `clients/gean.py`, was added as part of this guide's work — see
Chapter 10.)

## The `docker-arm` runner (how this works on a Mac)

Because Shadow is Linux-only, the `docker-arm` runner:

1. For every client in `[clients]`, pulls/inspects its image and resolves where its executable
   lives inside it.
2. Builds a **composite image** = the Shadow base image (`kamilsa/shadow-arm`) + each client's
   binary `COPY`'d in. Every client in `[clients]` is baked in, so its image must exist for arm64.
3. Runs Shadow inside a container from that composite image, with the run directory bind-mounted.

That is why a `[clients]` entry whose image isn't arm64-available makes the whole run fail at the
build step — there's nothing client-specific about it; it's just `docker pull --platform
linux/arm64` failing.

## What you get out

- `fuzzer-output/<run-id>/` — genesis, `shadow.yaml`, `shadow.data/hosts/<node>/` logs, `stats.json`.
- `site/rendered/<run-id>/analysis.html` + an updated `site/rendered/manifest.json`.
- The **Observatory** at `localhost:4321` lists every rendered run and shows its charts.

The next chapter walks you through producing all of that for the first time.
