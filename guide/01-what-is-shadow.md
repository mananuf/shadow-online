# 1. What is Shadow?

**Shadow** is a discrete-event **network simulator** that runs *real, unmodified application
binaries* — but replaces the operating system and network underneath them with a deterministic
simulation. You give Shadow a YAML file describing a set of hosts, their IP addresses, a network
topology with latencies and bandwidths, and the exact command to launch on each host. Shadow then
runs every process for real, intercepting their syscalls (time, sockets, `epoll`, threads…) so
that the whole network executes on **one machine**, in **virtual time**, and **reproducibly**.

Two properties make it powerful for consensus clients:

1. **It runs the real binary.** Unlike a model or a mock, Shadow executes the actual gean (or
   zeam, lantern…) binary, with its real networking stack, real gossip, real signature
   verification. If it works in Shadow, it is the same code path that runs on a devnet.
2. **It is deterministic and virtual-time.** A 2-minute "simulated" run can take more or less than
   2 minutes of wall-clock, but the *simulated clock* advances independently of how fast your
   laptop is. Re-running with the same seed produces the same result. That makes flaky,
   timing-dependent consensus bugs reproducible.

## What it's used for in lean consensus

The lean-consensus effort has many client teams — **ethlambda, zeam, ream, grandine, lantern,
nlean, qlean, and gean** — that must interoperate on the same network. The dangerous bugs are
*interop* bugs: a block one client produces that another rejects, a gossip encoding mismatch, an
attestation aggregation that doesn't verify across clients, or a fork that won't finalize when
clients are mixed.

You cannot catch those reliably on a single-client local testnet. You need **many clients on one
network, under controlled latency, reproducibly** — which is exactly what Shadow provides. The
community drives this through the **lean-shadow-fuzzer** (covered in Chapter 6), which sweeps
randomized-but-reproducible network configurations and reports whether the network produces
blocks, propagates attestations, and **finalizes**, across all participating clients.

> **Mental model.** A devnet is "real machines, real time, hard to reproduce." Shadow is "real
> binaries, simulated time and network, perfectly reproducible, all on your laptop." It sits
> between unit tests and a live devnet.

## Where Shadow runs

Shadow is **Linux-only** — it relies on Linux syscall interception. On macOS (including Apple
Silicon) you run it **inside a Linux container**: the lean-shadow-fuzzer's `docker-arm` runner
builds a composite Linux/arm64 image containing both the Shadow binary and the client binaries,
then runs the simulation inside that container. That is how every example in this guide was
produced on an Apple-Silicon Mac.

## The catch that the next chapter is about

Shadow does **not** charge CPU time. When a process does heavy computation between syscalls,
Shadow's virtual clock does not advance to account for it — the computation appears to take ~0
virtual time. For most applications that's fine. For a **post-quantum consensus client whose
signature operations are genuinely slow**, it is not fine at all: the most expensive part of the
client would run "for free," and the simulation would be wildly unrepresentative of real timing.

That single fact is the reason gean (and every other lean client) needed code changes to be
"Shadow-compatible." Chapter 2 explains it.
