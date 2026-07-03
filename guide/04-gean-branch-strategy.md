# 4. gean branch & image strategy

gean used to have **two** Shadow things — a lightweight cost model and a heavier in-repo harness —
and conflating them caused confusion. The harness is now **gone**: gean matches every other client
and lets the fuzzer drive it. So only the cost model remains, and this chapter covers where it lives
and how gean's single image serves both interop and Shadow.

## What gean carries now

Just **the cost-model package** (`internal/shadow`, three flags + an env fallback) from Chapter 3 —
lightweight, consensus-agnostic, **off by default**, safe on any branch. There is no `shadow/`
harness, no `make shadow-*` targets, and no bespoke Shadow CI gate in the gean repo anymore; the
lean-shadow-fuzzer (Chapter 6) generates the topology, writes `shadow.yaml`, and runs Shadow for
every client uniformly.

## The branch: `feat/shadow-sim-xmss-rates`

This branch carries the Shadow-relevant gean work on top of the current milestone:

- the **rate-based** cost model (`internal/shadow`) with the `--shadow-xmss-*` flags + env fallback,
- the **aggregation budget-trim fix** (bounds each aggregation pass to the session budget so a slow
  prover keeps finalizing instead of shedding whole cycles),
- a merge of **`devnet-5`** so it sits on top of current spec/STF/fork-choice work.

| Branch | Purpose | Carries Shadow code? | Lifecycle |
|--------|---------|----------------------|-----------|
| `main` | The client's mainline | The cost model (off by default) | normal |
| `devnet-5` | Spec/STF/fork-choice for the devnet-5 milestone | The cost model via merges | milestone track |
| `feat/shadow-sim-xmss-rates` | Cost model **+ aggregation fix**, merged on `devnet-5` | Yes | the Shadow branch |
| `shadow` (legacy) | Older harness-only branch (superseded) | Historical only | auto-rebased onto `main` |

> The legacy `shadow` branch (kept rebased by `.github/workflows/shadow-rebase.yml`) is superseded —
> the in-repo harness it carried has been removed everywhere else. It only matters for keeping that
> old branch from rotting.

## Does Shadow code on an interop branch affect interop runs?

**No.** This is the question that matters when the cost model rides along on `devnet-5` or any branch
you also build interop images from. Three independent guarantees:

1. **The cost model is dormant unless a flag/env is set.** Every `Sleep*` method short-circuits at
   the zero value (`if rate <= 0 || units <= 0 { return }`). A node that never sets
   `--shadow-xmss-*-rate` executes the *identical* hot path it always did — no sleeps, no extra
   goroutine work. It is pure latency injection, gated off.
2. **It touches no consensus logic.** No state-transition, fork-choice, SSZ, or wire-encoding
   change. A block gean builds/validates is byte-for-byte the same whether or not the flags exist.
3. **Shadow is triggered *only* by those flags/env.** There is no implicit "am I under Shadow?"
   detection that changes behavior. Nothing fires unless you pass a positive rate.

So merging the Shadow cost model into a multiclient/interop branch (like `devnet-5`) is safe: the
**normal interop image runs exactly as before** because nobody sets the flags in an interop run.

## One image, two tags

gean builds a **single** client image and publishes it under both tags — there is no separate
"Shadow gate image" anymore:

| Tag | Built from | Contains Shadow? | Used for |
|-----|-----------|------------------|----------|
| `ghcr.io/geanlabs/gean:devnet5` | root `Dockerfile` (`make docker-build`) | the cost model, *present but dormant* | multiclient interop / devnets |
| `ghcr.io/geanlabs/gean:shadow` | the **same** image / Dockerfile | same | the tag the fuzzer pulls |

The root `Dockerfile` has **zero** Shadow references — it's the normal client image, and the cost
model inside it stays off unless flagged. All the fuzzer needs is "a gean binary that *understands*
the `--shadow-xmss-*` flags," which every gean image is. This mirrors the other clients exactly:
zeam publishes `blockblaz/zeam:devnet4`, lantern `piertwo/lantern:v0.0.5-shadow`, gean
`ghcr.io/geanlabs/gean:shadow`.

Publish it with `make docker-build` (local) or the **"Publish Docker Image"** GitHub workflow with
`tags=shadow` (builds multi-arch amd64+arm64 and pushes to ghcr).

## Practical takeaways

- To **use the rate flags**, any gean build works — they're in every gean binary, off by default.
  You do not need a special "shadow build."
- To **run interop sweeps**, drive Shadow through the **lean-shadow-fuzzer** (Chapters 6+): point its
  `config.toml` `[client_images.gean]` at `ghcr.io/geanlabs/gean:shadow`. The fuzzer needs only the
  image — no harness branch, no in-repo gate.
- Shipping the cost model onto `devnet-5`/`main` is safe: it never changes an interop run.
- The boot issues the old in-repo gate first surfaced — upstream Shadow rejecting `IP_MTU_DISCOVER`
  (`setDF`), and genesis anchored to wall-clock instead of Shadow's virtual epoch — are handled by
  the fuzzer (it bases on `kamilsa/shadow-arm` and anchors genesis to the sim epoch). See Chapter 12.
