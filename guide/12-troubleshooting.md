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

**This is now fixed** — the gate no longer pins amd64. It bases on the arm64 `kamilsa/shadow-arm`
image and runs on a native `ubuntu-24.04-arm` runner, so `make shadow-docker-run` runs **natively on
Apple Silicon** (no QEMU, no `pidfd_open`). You'll only hit the crash above on an old checkout that
still compiles upstream amd64 Shadow. General rule (Chapter 1): run Shadow on its native arch, never
emulated.

## gean nodes exit 1 immediately under **stock** Shadow (amd64): "setting DF failed"

Captured gean stderr (from the `shadow-gate` CI artifact):

```
INFO  [node] initializing from genesis
ERROR [network] create p2p host: create libp2p host: failed to listen on any addresses:
                [setting DF failed for both IPv4 and IPv6]
ERROR [node] fatal: create libp2p host: failed to listen on any addresses:
                [setting DF failed for both IPv4 and IPv6]
```

with these Shadow-side warnings just before the exit:

```
[WARN] setsockopt SO_BROADCAST not yet implemented for udp; ignoring and returning 0
[WARN] setsockopt called with unsupported level 0  and opt 10    # IPPROTO_IP   / IP_MTU_DISCOVER
[WARN] setsockopt called with unsupported level 41 and opt 23    # IPPROTO_IPV6 / IPV6_MTU_DISCOVER
```

**Confirmed root cause.** gean reaches genesis init, then dies creating the libp2p host. The exact
fatal call is quic-go's **`setDF`** (set the IP *Don't-Fragment* bit for path-MTU discovery): it
calls `setsockopt(IP_MTU_DISCOVER)` and `setsockopt(IPV6_MTU_DISCOVER)`, and **returns a fatal error
when *both* fail** (`sys_conn_df_linux.go`). Stock Shadow v3.3.0 doesn't implement `IP_MTU_DISCOVER`
and returns an error for both families, so quic-go aborts the listener → libp2p host creation fails →
gean exits 1. There is **no env knob** to disable DF in quic-go (unlike `QUIC_GO_DISABLE_GSO` /
`QUIC_GO_DISABLE_ECN`).

**Why the fuzzer's runs (Chapter 8) boot fine.** They use the **arm64 `kamilsa/shadow-arm`** base,
whose Shadow build *ignores-and-returns-0* for `IP_MTU_DISCOVER` (the way stock Shadow already does
for `SO_BROADCAST`). So `setDF` succeeds and gean boots. **gean is not broken — upstream stock Shadow
v3.3.0 is simply stricter than the Shadow the ecosystem actually runs.** (Both report version 3.3.0;
Kamil's is a patched build.)

**Fix (applied).** The gate now bases on **`kamilsa/shadow-arm`** instead of compiling upstream
Shadow — `shadow/Dockerfile` does `FROM kamilsa/shadow-arm` and copies the gean binary in (the same
shape the fuzzer uses). That image is arm64-only, so the gate runs on a native **`ubuntu-24.04-arm`**
runner, and `make shadow-docker-run` now works natively on Apple Silicon too. `QUIC_GO_DISABLE_ECN` /
`QUIC_GO_DISABLE_GSO` do **not** help (neither touches `setDF`); patching quic-go is possible but
invasive for a sim-only concern, so aligning the Shadow base is the clean fix.

> **Heads-up — there's a *second* bug behind this one.** Once gean boots, it still won't finalize
> unless genesis is anchored to Shadow's virtual clock — see the next entry.

## Chain boots but never advances (head/finalized stuck at 0): genesis in the sim future

**Cause.** Shadow's virtual clock starts at **unix 946684800 (2000-01-01 UTC)**, but `keygen`'s
`--genesis-delay` sets genesis from the *wall clock* (now + delay, ~2026). Genesis then sits ~26
simulated years in the future, so no slot ever fires — nodes boot, peer, and sit at slot 0.

**Fix.** Anchor genesis to Shadow's epoch, not wall-clock. `run-gates.sh` now uses
`--genesis-time $((SHADOW_EPOCH + GENESIS_DELAY))` with `SHADOW_EPOCH=946684800`; the Makefile's
`shadow-setup` does the same. With genesis ~30 s into the sim and a 120 s `stop_time`, a 3-node run
reaches **head ≈ 22, finalized ≈ 19** — gate green.

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
