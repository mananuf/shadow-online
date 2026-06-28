# 12. Troubleshooting

Every entry here is something we actually hit while producing this guide. Each has the exact symptom
and the fix.

## "pull access denied for gean … repository does not exist"

```
Error response from daemon: pull access denied for gean, repository does not exist
docker pull --platform linux/arm64 gean:shadow-base  → non-zero exit
```

**Cause.** The fuzzer pulls each `[clients]` image with `docker pull` *only if* `docker image
inspect` fails. `gean:shadow-base` is a **local** image (you built it), not in any registry, so if
inspect transiently fails the pull then fails too. We saw this as a one-off when the daemon was busy
mid-build.

**Fix.** Confirm the image exists and inspect works, then re-run:

```bash
docker image inspect gean:shadow-base >/dev/null && echo OK
docker build -t gean:shadow-base ../gean     # rebuild if it's genuinely missing
```

## gean nodes exit immediately: "ATTESTATION_COMMITTEE_COUNT=N disagrees with gean's 1"

```
ERROR [node] load genesis config: ATTESTATION_COMMITTEE_COUNT=4 disagrees with gean's 1
… Shadow: managed processes in unexpected final state
```

**Cause.** You set `total_subnets > 1`. gean only supports a single subnet today
(`AttestationCommitteeCount = 1`, enforced in `internal/genesis/load.go`). See Chapter 9.

**Fix.** Set `total_subnets = { min = 1, max = 1 }` for any run that includes gean.

## Observatory says "No rendered runs yet" / the run page is blank

**Cause.** The run completed Shadow but the sweep was interrupted before the `Collecting stats…` /
`Rendering…` steps, so there's no `stats.json` and no manifest entry. `render_notebooks.py` needs
`stats.json` to exist.

**Fix.** Regenerate stats from the existing logs, then render (no need to re-run Shadow):

```bash
RUN=fuzzer-output/<run-id>
uv run python -c "import json; from shadow_fuzzer import stats_shadow; \
  m=json.load(open('$RUN/run-metadata.json')); \
  json.dump(stats_shadow.collect_stats('$RUN', m), open('$RUN/stats.json','w'), indent=2)"
uv run python scripts/render_notebooks.py --run-dir $RUN
```

## `render_notebooks.py`: `ModuleNotFoundError: No module named 'papermill'`

**Cause.** The notebook dependency group isn't installed.

**Fix.** `uv sync --group notebooks`.

## stats.json shows "No block events found" even though the chain finalized

**Cause.** No log **parser** for the client, so the fuzzer fell back to the zeam text parser, which
can't read the other client's log format. `chain_status` (finality) is client-agnostic and still
works, which is why finality shows but block/attestation events don't.

**Fix.** Add `shadow_fuzzer/clients/<client>.py` (a `ClientParser` matching that client's log lines)
and register it in `shadow_fuzzer/clients/__init__.py` before the zeam fallback. For gean this
parser already exists (Chapter 10). Then regenerate stats as above.

## A multi-client run crawls (1% after several minutes)

**Cause.** Shadow runs the **real** XMSS proving for every node. Heavier clients (or many nodes)
make wall-clock time balloon even though *simulated* time is short — a 120 s sim can take hours.

**Fix.** Shrink the run: fewer `total_nodes`, shorter `duration_secs`. For a quick interop check, 4
nodes / 60–90 s is plenty to see blocks and (often) finalization. Reserve large/long runs for a
Linux server. The `--shadow-xmss-*` *rate* sleeps are virtual time and do **not** add wall-clock —
the cost is the real proving.

## gean nodes drift off slot time at high aggregated-verify rate

**Cause.** `SleepVerifyAggregated` currently runs on gean's tick loop (Chapter 5 gotcha), so a large
`--shadow-xmss-verify-aggregated-signatures-rate` blocks the clock.

**Fix.** Keep that rate modest, or set only the aggregate + single-verify rates (both off-loop)
until the handler is moved off the `select` loop.

## "Shadow is running as root" / `sched_getaffinity` / "Opening unsupported proc file" WARNs

**Not errors.** These are Shadow's syscall-shim diagnostics (it intercepts CPU-affinity and some
`/proc` reads). They appear in every run and are safe to ignore. Look for `processes failed: N` in
the progress line and `ERROR`/`panic` in node stderr instead.

## Where to look when a node misbehaves

```bash
RUN=fuzzer-output/<run-id>
ls "$RUN/shadow.data/hosts/"                       # one dir per node
sed -E 's/\x1b\[[0-9;]*m//g' "$RUN"/shadow.data/hosts/<node>/*.stderr | less   # de-colored logs
grep -liE "panic|fatal|error" "$RUN"/shadow.data/hosts/*/*.stderr              # which nodes failed
```

gean logs to **stderr** (the `.stdout` file is empty). Strip ANSI color codes as shown to make the
logs greppable.
