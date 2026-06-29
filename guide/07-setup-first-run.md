# 7. Setup & your first run

This chapter takes you from nothing to a rendered Observatory page, on macOS (Apple Silicon). On a
Linux host the steps are identical except you can also use the `local` runner with a host `shadow`
binary; everything below uses the `docker-arm` runner so it works on a Mac.

> **Two ways to run Shadow with gean — don't confuse them.** This chapter uses the
> **lean-shadow-fuzzer** (native arm64, works on a Mac). gean *also* ships a small in-repo gate
> (`make shadow-docker-run`) for a quick "does it finalize?" check — but that image is **amd64**,
> so on Apple Silicon it runs emulated and **crashes at Shadow startup** (`pidfd_open`, Chapter 12).
> Use the fuzzer on a Mac; use the in-repo gate on amd64 (CI or a Linux box). Chapter 4 explains the
> split.

## Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| Docker (with arm64) | Builds + runs the composite Shadow container | Docker Desktop |
| `uv` | Runs the Python fuzzer + notebooks | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| `yq` | Used by the shell scripts | `brew install yq` |
| Node.js | The Observatory web UI | `brew install node` |
| A `gean` arm64 image | The client binary baked into the sim | built below |

## Step 1 — build the gean Shadow image

The fuzzer needs a gean image it can bake into the composite. Build it from the gean checkout (this
image carries the `--shadow-xmss-*` flags from Chapter 3):

```bash
cd ../gean
docker build -t gean:shadow-base .
# verify the flags are present:
docker run --rm gean:shadow-base --help | grep shadow
```

You should see the three `--shadow-xmss-*-rate` flags. The image name `gean:shadow-base` is what the
fuzzer config references.

## Step 2 — install fuzzer dependencies

```bash
cd ../lean-shadow-fuzzer
uv sync                      # base deps
uv sync --group notebooks    # papermill etc., needed to render the Observatory
```

## Step 3 — point the config at the gean image

The repo ships `config.example.docker-arm.toml`. Copy it to `config.toml` and make sure the gean
client is enabled. A minimal gean-only, single-subnet run looks like this:

```toml
[fuzzer]
max_runs = 1
duration_secs = { min = 120, max = 120 }
seed = 42
runner = "docker-arm"
render_notebooks = true

[docker_arm]
shadow_image = "kamilsa/shadow-arm"
image_name = "shadow-fuzzer:local"
rebuild = true

[client_images.gean]
image = "gean:shadow-base"
executable = "gean"

[simulation]
total_nodes = { min = 8, max = 8 }
total_subnets = { min = 1, max = 1 }
aggregators_per_subnet = { min = 2, max = 2 }
signatures_aggregation_rate = { min = 1000, max = 1000 }   # sig/s → gean's shadow rates
recursive_aggregation_rate = { min = 10.0, max = 10.0 }

[clients]
gean = { min = 1.0, max = 1.0 }
```

> **Important:** every client listed under `[clients]` must have a matching `[client_images.<c>]`
> with an arm64 image, or the composite build fails (Chapter 6). Keep it gean-only for your first run.

## Step 4 — dry run (validate without building)

```bash
uv run shadow-fuzzer.py --dry-run config.toml
```

This resolves the config, generates genesis + `shadow.yaml`, and prints the plan — but skips the
image build and the Shadow run. Confirm it shows your node count and that each node's args include
the `--shadow-xmss-*-rate` flags.

## Step 5 — the real run

```bash
uv run shadow-fuzzer.py --clean-output config.toml
```

`--clean-output` starts from a fresh `fuzzer-output/`. The first run pulls the Shadow base image and
builds the composite; later runs reuse cached layers and are much faster. When it finishes you'll
see `Collecting stats...` then `Rendering analysis notebooks...`.

> ⚠️ `--clean-output` deletes previous run folders. Omit it to keep older runs side by side (each run
> gets a random name like `hidden-hot-baboon`).

## Step 6 — view the Observatory

```bash
cd site
npm install            # first time only
npx astro dev --port 4321
# open http://localhost:4321  → click your run
```

## Step 7 — find your run id and re-render if needed

A run's id is its folder name under `fuzzer-output/`:

```bash
ls -dt fuzzer-output/*/ | head -1     # newest run dir = its id
```

If a run completed Shadow but you interrupted it before stats/render (so the Observatory shows
nothing), regenerate `stats.json` and re-render without re-running Shadow:

```bash
RUN=fuzzer-output/<run-id>
uv run python -c "import json; from shadow_fuzzer import stats_shadow; \
  m=json.load(open('$RUN/run-metadata.json')); \
  json.dump(stats_shadow.collect_stats('$RUN', m), open('$RUN/stats.json','w'), indent=2)"
uv run python scripts/render_notebooks.py --run-dir $RUN
```

You now have a complete pipeline. Chapter 8 reads the resulting run in detail.
