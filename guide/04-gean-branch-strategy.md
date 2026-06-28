# 4. gean branch strategy: `shadow` vs `main` vs `devnet-5`

There are **two different "Shadow" things** in gean, and conflating them causes confusion. This
chapter separates them.

## The two layers

1. **The cost-model package** (`internal/shadow`, three flags) from Chapter 3. This is *lightweight*
   and *consensus-agnostic*. It is being merged into `main` like any normal feature.
2. **The simulator harness** — the heavier glue that actually drives a Shadow run from inside the
   gean repo: a Dockerized "gate runner," keygen `--genesis-time` / `--genesis-delay` overrides,
   amd64 build notes. This lives on a **long-lived `shadow` branch that is deliberately kept off
   `main`.**

## The `shadow` branch

`git branch -a` shows a local and remote `shadow` branch alongside the devnet branches. The
`shadow` branch is a **strict superset of `main`**: `git log shadow..main` is empty, and
`git log main..shadow` is a handful of `feat(shadow): …` commits (the harness, the gate runner,
the keygen genesis-time/delay overrides, the amd64 requirement docs).

It is kept off `main` on purpose — the harness is heavyweight and only needed for running
simulations, not for being a consensus client. To stop it rotting, a CI workflow continuously
rebases it onto `main`.

### The auto-rebase workflow: `.github/workflows/shadow-rebase.yml`

- **Trigger:** every push to `main` (plus manual `workflow_dispatch`).
- **What it does:** checks out `origin/shadow`, runs `git rebase origin/main`, and on success
  pushes with `git push origin shadow --force-with-lease` (the lease guards against clobbering a
  concurrent update).
- **On conflict:** it captures the conflicting filenames, aborts the rebase, writes a "Shadow
  rebase failed" summary to the GitHub Actions run, and **fails the job** — so drift surfaces
  loudly in the Actions UI instead of silently rotting.
- **Concurrency:** a newer push to `main` cancels an in-flight rebase (`cancel-in-progress`).

That commit you may have seen — `ci(shadow): auto-rebase the shadow branch onto main` — is this
workflow.

## How `devnet-5` differs

`devnet-5` is an **entirely separate track**. `git log main..devnet-5` is spec/correctness work:
`LEAN_SPEC_COMMIT_HASH` bumps, state-transition and fork-choice fixes, restart/anchor fixes. It
carries **no Shadow code at all**. The `shadow` branch and `devnet-5` share no shadow-specific
commits; they're orthogonal.

| Branch | Purpose | Carries Shadow code? | Lifecycle |
|--------|---------|----------------------|-----------|
| `main` | The client's mainline | The **cost-model** (once merged) | normal |
| `shadow` | Simulator **harness** | Yes — the heavyweight harness | long-lived, auto-rebased onto `main` |
| `devnet-5` | Spec/STF/fork-choice for the devnet-5 milestone | No | milestone track |
| `feat/shadow-sim-xmss-rates` | Upstreams the **cost-model** to `main` | Yes — just `internal/shadow` + flags | short-lived feature branch |

## Why this split is the right shape

- The **cost model** is tiny and safe, so it belongs in `main` where every build has it (off by
  default). No reason to hide it on a branch.
- The **harness** (Docker gate runner, genesis-time overrides) is operational tooling that would
  bloat `main` and isn't part of being a consensus client. Keeping it on an auto-rebased branch
  gives you "always works against the latest main" without polluting main.
- **Interop spec work** (`devnet-5`) moves fast and independently; coupling it to Shadow would slow
  both. They stay separate.

## Practical takeaways

- To *use the rate flags*, you only need `main` (or this guide's feature branch) — no `shadow`
  branch required. That's all the fuzzer's `gean-cmd.sh` invokes.
- To *run the in-repo gate harness* (an alternative to the fuzzer), you check out the `shadow`
  branch. Most users will drive Shadow through the **lean-shadow-fuzzer** instead (Chapters 6+),
  which only needs the gean *binary/image*, not the `shadow` branch.
- If the `shadow-rebase` job goes red, `main` moved in a way that conflicts with the harness —
  someone needs to resolve the rebase on the `shadow` branch. The job summary lists the
  conflicting files.
