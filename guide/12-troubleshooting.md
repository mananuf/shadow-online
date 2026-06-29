# 12. Troubleshooting

Every entry here is something we actually hit while producing this guide. Each has the exact symptom
and the fix.

## `make shadow-docker-run` on a Mac: `pidfd_open failed … "Function not implemented"`

```
=== gate: run simulation (nodes=3 stop_time=120s) ===
pidfd_open failed for Pid(78): Os { code: 38, kind: Unsupported, message: "Function not implemented" }
called `Result::unwrap()` on an `Err` value: PoisonError { .. }
fatal runtime error: failed to initiate panic, error 5, aborting
```

**Cause.** gean's in-repo gate image (`shadow/Dockerfile`) is pinned to **linux/amd64**. On an
Apple-Silicon Mac that runs under QEMU emulation, and QEMU does not implement `pidfd_open` — so
**Shadow itself crashes at startup, before any gean node launches.** This is not a gean bug; the
client never even boots. (The image *builds* fine under emulation — it's the simulation runtime
that fails.)

**Fix.** Don't emulate amd64 Shadow on Apple Silicon. Either:

- Run the gate on **native amd64** — the `shadow-gate` CI job (`ubuntu-latest`) does exactly this,
  or use any amd64 Linux box; or
- On a Mac, run Shadow through the **lean-shadow-fuzzer's `docker-arm` runner** (Chapters 6–7),
  which uses a native **arm64** Shadow base (`kamilsa/shadow-arm`) and runs without emulation.

See Chapter 1 ("Where Shadow runs") for the native-vs-emulated rule.

## gean nodes exit 1 immediately under **stock** Shadow (amd64): unsupported UDP `setsockopt`

```
=== gate: run simulation (nodes=3 stop_time=120s) ===
[WARN] setsockopt SO_BROADCAST not yet implemented for udp; ignoring and returning 0
[WARN] setsockopt called with unsupported level 0  and opt 10    # IPPROTO_IP   / IP_MTU_DISCOVER
[WARN] setsockopt called with unsupported level 41 and opt 23    # IPPROTO_IPV6 / IPV6_MTU_DISCOVER
[ERROR] process 'node0.gean.1000' exited with status Normal(1); expected end state was running
Error: 3 managed processes in unexpected final state
```

**What happened.** This is from the `shadow-gate` CI job on **native amd64** with **stock Shadow
v3.3.0**. Shadow built and ran, but every gean node exited status 1 within the first millisecond of
simulated time — it **never booted**, never reached genesis. The proximate cause is gean's
**QUIC/UDP socket setup**: go-libp2p/quic-go sets several UDP socket options at connection setup
(GSO, ECN `IP_RECVTOS`/`IPV6_RECVTCLASS`, DF/path-MTU `IP_MTU_DISCOVER`, packet-info), and stock
Shadow 3.3.0 doesn't implement all of them. quic-go's `newConn` aborts if the options it treats as
required fail, so the QUIC transport fails to start and gean exits.

**Why the fuzzer's runs (Chapter 8) still boot.** Those use the **arm64** `kamilsa/shadow-arm` base
(a different Shadow build) and a `gean:shadow-base` image that may predate the current quic-go.
The stock-Shadow-v3.3.0 + current-branch combination is what trips here — which is exactly the kind
of regression the gate exists to catch.

**How to diagnose precisely.** The Shadow log shows the *unsupported* options but not gean's own
error. Capture the node stderr to see which call quic-go treated as fatal:

```bash
# add to the gate (or run locally on amd64 Linux):  upload shadow.data as an artifact, then:
sed -E 's/\x1b\[[0-9;]*m//g' run1.data/hosts/node0/*.stderr | grep -iE 'quic|ecn|setsockopt|listen|transport'
```

**Likely fixes** (to evaluate once the exact call is pinned): a newer Shadow with broader sockopt
support; a go-libp2p/quic-go transport option that skips the unsupported setup; or, if it is the ECN
path, note that `QUIC_GO_DISABLE_ECN` does **not** help (it only flips the capability flag, it does
not suppress the `setsockopt`). This is open at the time of writing — the gate is red on purpose
until it's resolved.

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
