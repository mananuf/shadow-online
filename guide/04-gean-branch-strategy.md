# 4. gean branch strategy: cost-model, harness, and `devnet-5`

There are **two different "Shadow" things** in gean, and conflating them causes confusion. This
chapter separates them, then answers the questions that always come up: *does shipping Shadow code
on an interop branch affect interop runs? can one branch build both the interop image and the
Shadow gate image?*

## The two layers

1. **The cost-model package** (`internal/shadow`, three flags + an env fallback) from Chapter 3.
   Lightweight, consensus-agnostic, **off by default**. Safe to live on any branch.
2. **The simulator harness** — the heavier glue that drives a Shadow run from inside the gean repo:
   `shadow/gen_shadow_yaml.sh`, `shadow/run-gates.sh`, `shadow/Dockerfile`, keygen
   `--genesis-time` / `--genesis-delay` overrides, and the Makefile `shadow-*` targets.

Historically these lived apart: the harness on a long-lived `shadow` branch (kept off `main`), and
the cost model upstreaming separately. They have since been **consolidated** onto one branch.

## The current branch: `feat/shadow-sim-xmss-rates`

This branch now carries the whole picture in one place:

- the **rate-based** cost model (`internal/shadow`) with the `GEAN_SHADOW_*` **env fallback**,
- the **harness** (`shadow/`) wired to the rate flags, injecting rates per host via the environment,
- a merge of **`devnet-5`** so it sits on top of current spec/STF/fork-choice work,
- a **CI gate** (`.github/workflows/shadow-gate.yml`) that runs the simulation on native amd64.

| Branch | Purpose | Carries Shadow code? | Lifecycle |
|--------|---------|----------------------|-----------|
| `main` | The client's mainline | The cost model (off by default) | normal |
| `devnet-5` | Spec/STF/fork-choice for the devnet-5 milestone | No | milestone track |
| `feat/shadow-sim-xmss-rates` | Cost model **+ harness + CI gate**, merged on top of `devnet-5` | Yes — everything | the consolidated Shadow branch |
| `shadow` (legacy) | Older harness-only branch (fixed-ms model) | Yes — superseded | auto-rebased onto `main` |

### The auto-rebase workflow: `.github/workflows/shadow-rebase.yml`

A CI job keeps the legacy long-lived `shadow` branch rebased onto `main`: on every push to `main`
it runs `git rebase origin/main` and force-pushes with `--force-with-lease`; on conflict it writes
the conflicting filenames to the run summary and fails the job, so drift surfaces loudly. The
commit `ci(shadow): auto-rebase the shadow branch onto main` is this workflow. (With the
consolidated branch above, this matters mainly for keeping the legacy branch from rotting.)

### The CI gate: `.github/workflows/shadow-gate.yml`

The gate runs on a native **`ubuntu-24.04-arm`** runner on pushes to the shadow branches. It builds
the gean image, bases the gate image on **`kamilsa/shadow-arm`** (the Shadow the fuzzer uses), and
runs `shadow/run-gates.sh`, asserting the chain **finalizes** (`finalized_slot >= 1`). This is the
only place the simulator runs *for real* on every change — the normal build/test jobs never run
Shadow.

**It immediately earned its keep.** The first runs were **red** and surfaced two real bugs the build
jobs can't see (full analysis in Chapter 12): (1) on *upstream* Shadow v3.3.0 the gean nodes exited
at QUIC listener setup (`setting DF failed` — the `IP_MTU_DISCOVER` sockopt upstream rejects), and
(2) genesis was anchored to wall-clock instead of Shadow's virtual epoch, so the chain never
advanced. The fix: base the gate on Kamil's Shadow (which tolerates the sockopt, hence the arm64
runner) and anchor genesis to `SHADOW_EPOCH`. With both, a 3-node gate run reaches head ≈ 22,
finalized ≈ 19 — **green**, and matching the fuzzer's interop runs (Chapter 8).

## Does Shadow code on an interop branch affect interop runs?

**No.** This is the question that matters when the cost model rides along on `devnet-5` or any
branch you also build interop images from. Three independent guarantees:

1. **The cost model is dormant unless a flag/env is set.** Every `Sleep*` method short-circuits at
   the zero value (`if rate <= 0 || units <= 0 { return }`). A node that never sets
   `--shadow-xmss-*-rate` (or `GEAN_SHADOW_*`) executes the *identical* hot path it always did — no
   sleeps, no extra goroutine work. It is pure latency injection, gated off.
2. **It touches no consensus logic.** No state-transition, fork-choice, SSZ, or wire-encoding
   change. The blast radius is one package + three flags + three one-line calls (Chapter 3). A
   block gean builds/validates is byte-for-byte the same whether or not the flags exist.
3. **Shadow is triggered *only* by those flags/env.** There is no implicit "am I under Shadow?"
   detection that changes behavior. Nothing fires unless you pass a positive rate.

So merging the Shadow cost model into a multiclient/interop branch (like `devnet-5`) is safe: the
**normal interop image runs exactly as before** because nobody sets the flags in an interop run.

## Can one branch build both the interop image and the Shadow image?

**Yes — they're two separate images from the same source tree:**

| Image | Built from | Contains Shadow? | Used for |
|-------|-----------|------------------|----------|
| **Interop image** | root `Dockerfile` (`make docker-build`) | The cost model is *present but dormant* | multiclient interop / devnets |
| **Shadow gate image** | `shadow/Dockerfile` (`make shadow-docker-*`) | gean **+ the Shadow simulator binary** | running the gate |

The root `Dockerfile` has **zero** Shadow references — it's the normal client image, and the cost
model inside it stays off unless flagged. `shadow/Dockerfile` layers the Shadow simulator on top of
a gean image for running the gate. Same branch, same code, two build targets that don't interfere.
The fuzzer (Chapter 6) uses a *third* image, `gean:shadow-base` — really just the interop image
under another tag, since all the fuzzer needs is a gean binary that *understands* the flags.

## Practical takeaways

- To **use the rate flags**, any build works — they're in every gean binary, off by default. You do
  not need a special "shadow build."
- To **run the in-repo gate**, use `make shadow-docker-run` (Chapter 7); on a Mac this is emulated
  amd64 and will fail at Shadow startup — run it on amd64 (CI or a Linux box) instead.
- To **run interop sweeps**, drive Shadow through the **lean-shadow-fuzzer** (Chapters 6+), which
  only needs the gean image, not any harness branch.
- Shipping the cost model onto `devnet-5`/`main` is safe: it never changes an interop run.
