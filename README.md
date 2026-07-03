# Shadow Simulation Mastery Guide

A complete, hands-on guidebook for running **gean** (the Go lean-consensus client) under the
**Shadow** network simulator via the **lean-shadow-fuzzer**, and for reading every metric the
runs produce. Written to take you from "what is Shadow" to driving multi-client interop sweeps
and debugging them.

This folder ships the guide in two interchangeable forms — same content, one source:

- **`guide/`** — the canonical Markdown chapters. Readable on GitHub or any editor.
- **`web/`** — a deployable Vite + React single-page app that renders those same Markdown
  chapters with navigation, syntax highlighting, and the embedded chart images.
- **`assets/`** — real chart PNGs generated from local Shadow runs (see `scripts/export_charts.py`).

## Read it as Markdown

Start at [`guide/01-what-is-shadow.md`](guide/01-what-is-shadow.md) and walk the numbered chapters.

| # | Chapter | What you learn |
|---|---------|----------------|
| 01 | [What is Shadow](guide/01-what-is-shadow.md) | The simulator, why lean-consensus uses it |
| 02 | [Why prover cost must be modeled](guide/02-why-prover-cost.md) | The core reason gean needed changes |
| 03 | [gean's Shadow support](guide/03-gean-shadow-support.md) | The cost model + flags — all gean ships; the fuzzer drives it |
| 04 | [gean branch & image strategy](guide/04-gean-branch-strategy.md) | Interop safety, and the one image (`:shadow`) the fuzzer pulls |
| 05 | [Maintaining gean's Shadow code](guide/05-maintaining-gean-shadow.md) | Change cadence, the fuzzer integration, the known gotcha |
| 06 | [The lean-shadow-fuzzer](guide/06-fuzzer-overview.md) | What the repo is and how it's wired |
| 07 | [Setup & your first run](guide/07-setup-first-run.md) | Prereqs → build → run → render → Observatory |
| 08 | [One subnet, one client](guide/08-one-subnet-one-client.md) | The canonical gean run, walked end to end |
| 09 | [Multiple subnets, one client](guide/09-multi-subnet-one-client.md) | Config mechanics + gean's single-subnet limit |
| 10 | [Multiple clients & subnets](guide/10-multi-client-multi-subnet.md) | Interop sweeps (zeam + gean) |
| 11 | [Metrics mastery — beginners to pro](guide/11-reading-the-metrics.md) | Foundations → gean's live `/metrics` + budgets → Observatory charts → pro diagnosis |
| 12 | [Troubleshooting](guide/12-troubleshooting.md) | Every error we hit and how to fix it |
| 13 | [Reference cheat-sheet](guide/13-reference-cheatsheet.md) | Flags, knobs, commands on one page |

## Run it as a web page

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in web/dist/ — deploy anywhere
```

The React app reads `guide/*.md` directly, so the page and the Markdown never drift.

## Regenerate the chart images

```bash
# from the lean-shadow-fuzzer checkout, for any completed run dir
uv run --with kaleido --with networkx --with pyyaml python \
  ../shadow/scripts/export_charts.py \
  fuzzer-output/<run-id> ../shadow/assets/<run-id>
```

## The two repos this guide spans

- **gean** — `../gean` — the client. Shadow support lives in `internal/shadow/` + three CLI flags.
- **lean-shadow-fuzzer** — `../lean-shadow-fuzzer` — the harness that drives Shadow and renders results.
