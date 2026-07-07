# 16. Case studies

Theory and decision trees are scaffolding; this chapter is the building. Each case is a *real* incident
worked end to end — the symptom, the evidence, the method, the conclusion — so you can see the debugging
playbook (**[chapter 15](15-debugging-playbook)**) applied to messy reality. Study the *method* more than
the answer: symptom → shape → evidence → conclusion, no guessing.

## Case 1 — "gean finalizes slower than ethlambda" (a peer was down)

**Symptom.** On a 3-client run (zeam, ethlambda, gean), gean's `finalized_slot` trailed ethlambda's by
several slots. First instinct: a gean finality bug.

**Evidence, in order.**
1. gean's `[chain] block …` lines appeared every slot *except* those with `proposer=0`. → one proposer's
   blocks were missing.
2. Block-count breakdown from gean's chain: `proposer=0` produced **3** blocks; `proposer=1` and
   `proposer=2` produced **75** each. → validator 0 (zeam) almost never proposed.
3. Cross-client: zeam's log stopped after ~slot 9. → zeam *died early*; its proposal slots were empty
   thereafter.
4. Interop check: gean's head and finalized **roots matched ethlambda's byte-for-byte** at shared slots
   (`head@226 = 0x233d0458…` on both; `finalized@220 = 0x2fe58d7d…` on both).

**Conclusion.** Not a gean bug. A *peer* (zeam) fell over; gean and ethlambda finalized correctly on the
remaining 2/3 supermajority. The decisive evidence was **root agreement across clients**
(**[chapters 11](11-finality), [12](12-fork-choice-vs-state-transition)**).

**Lesson.** "gean is slower" was really "a peer is absent." Always cross-check before suspecting your own
client; **root agreement** is the strongest interop-health signal.

## Case 2 — the aggregation cost cliff (a *modeled* timing effect)

**Symptom.** In Shadow stress runs, as the modeled prover rate dropped, `finalized_slot` strained and
then stalled — finality fell off a cliff past a threshold.

**Evidence.** Aggregation duration crossed the ~1.6 s per-slot session budget; the off-tick worker,
protecting the tick clock, truncated the remaining aggregation pass, so **fewer aggregates** were
produced, so **fewer votes** reached the tally, so justification advanced slower
(**[chapter 09](09-attestation-processing)**).

**Conclusion.** A **liveness** effect from modeled prover cost, not a finality-logic bug. The fix was a
self-calibrating budget-trim in the aggregation worker: bound each pass to the remaining budget (keep
children first, defer raw votes), so the chain keeps finalizing under a slow prover — with **no change to
the state transition**.

**Lesson.** "Won't finalize" is frequently **votes not arriving** (timing/aggregation), distinguishable
from a tally bug by diffing the justification state (**[chapter 15](15-debugging-playbook)**). And this is
exactly why Shadow *models* prover cost — a CPU-free sim would have hidden the cliff
(**[chapter 14](14-shadow-execution)**).

## Case 3 — the spec's own fixtures fail (an upstream determinism inconsistency)

**Symptom.** `make test-spec` aborted before gean was even tested: leanSpec's *own* fixture generation
(`uv run fill`) failed **3 equivocation tests** at the pinned commit (`551 passed, 3 failed`).

**Evidence.**
1. The 3 failing tests were all added by the same commit — the #1181 *equal-slot equivocation
   determinism* PR.
2. Fixture generation runs **leanSpec's** pytest; gean is not involved (it only consumes generated
   fixtures). So the failure is upstream.
3. The failing test's docstring stated the intended behavior explicitly: *"the two votes tie on slot, so
   the larger attestation-data root wins… head is fork_b."* leanSpec's own fork choice produced a
   *different* head during fixture generation (`head_slot` actual ≠ expected).

**Conclusion.** An **upstream leanSpec inconsistency** at that pin: its #1181 code disagrees with its own
#1181 test. gean's implementation *matches the documented intent* (keep the max `(slot, canonical
root)` — **[chapter 12](12-fork-choice-vs-state-transition)**), so gean is correct-to-intent; it simply
can't be fixture-validated for that one feature until the upstream resolves. Workaround: generate the
other ~548 vectors (excluding the broken file) to validate everything else.

**Lesson.** The spec is the oracle — but the oracle can be *internally inconsistent* at a given commit.
When the spec's *code* fails the spec's *test*, escalate upstream; validate your client against the
intent (docstring) and the vectors that *do* generate, and don't contort your client to match a broken
fixture.

## Case 4 — the hardening gaps (spec-to-gean drift, caught by /spec-compliant)

**Symptom.** A spec-compliance sweep across 7 leanSpec commits found gean drifted on 4 hardening changes.

**Evidence & fixes** (each a mini-transition/fork-choice lesson):
- **Equal-slot equivocation determinism (#1181).** gean's latest-vote extraction kept the *first-seen*
  vote on an equal-slot tie (arrival-order dependent). Fix: keep the max `(slot, canonical data root)`
  in `ExtractLatestAttestations`, making the head order-independent
  (**[chapter 12](12-fork-choice-vs-state-transition)**).
- **`BLOCK_TOO_FAR_IN_FUTURE` (#1182).** gean had no clock-horizon guard on block import. Fix: reject
  `block.slot > store.Time()/IntervalsPerSlot + 1` at the `blockprocessor` boundary
  (**[chapters 05](05-time-model), [08](08-block-processing)**).
- **`HEAD_NOT_DESCENDANT_OF_FINALIZED` (#1179).** Attestation admission didn't reject a vote whose head
  was off the finalized subtree. Fix: add the finalized→head ancestry check
  (**[chapter 09](09-attestation-processing)**).
- **Justification typed rejections (#1178).** gean returned `nil` for an empty registry and never checked
  the vote-matrix length. Fix: `EMPTY_VALIDATOR_REGISTRY` + `JUSTIFICATION_VOTES_LENGTH_MISMATCH`
  (**[chapter 09](09-attestation-processing)**).

**Conclusion.** All four were **hardening** (DoS bounds, determinism, typed rejections) — none changed the
happy path, but each was a real spec divergence that could bite in adversarial or edge conditions. Each
mirrored its leanSpec function precisely, with a spec↔gean mapping recorded.

**Lesson.** Drift is usually in the **edges** (malformed input, equivocation, far-future slots), not the
common path. `/spec-compliant` across a commit range is how you find it before Devnet does. And a
one-field guard can be the difference between "rejects a doomed block cheaply" and "forced into an
unbounded loop."

## The method, distilled

Across all four cases the *procedure* was identical:

```
symptom  →  gather evidence (logs, block counts, cross-client roots)
         →  identify the shape (liveness? determinism? upstream? drift?)
         →  localize (which client / which phase / which field)
         →  conclude with evidence, not guesswork
```

Notice what never appears: "I think it's probably…". Every conclusion rests on a diff, a count, or a
root comparison.

## Cross references
- **[15 — Debugging playbook](15-debugging-playbook)** — the decision trees these cases apply.
- **[09](09-attestation-processing)**, **[11](11-finality)**, **[12](12-fork-choice-vs-state-transition)** —
  the mechanisms the cases exercised.
- **[17 — Common bugs](17-common-bugs)** — the recurring shapes generalized.

---

### Key takeaways
- Real incidents are solved by **method**, not intuition: symptom → evidence → shape → localize →
  conclude.
- **Root agreement across clients** is the strongest interop-health signal; a "slow" client is often an
  absent *peer*.
- "Won't finalize" is often **liveness** (votes not arriving), distinguishable from a tally bug by
  diffing justification state.
- The **spec can be internally inconsistent** at a pin; validate against intent + working vectors and
  escalate upstream.
- Drift lives in the **edges** — `/spec-compliant` finds it before Devnet does.

### Exercises
1. For Case 1, list the exact sequence of evidence and why root agreement was decisive.
2. For Case 2, explain the causal chain from "slow prover" to "stalled finality" in one line.

### Debugging exercise
- You see a 3-client run where one client's `finalized_slot` trails. Write the first three evidence
  checks you'd run, in order (hint: Case 1).

### Code-reading assignment
- Find the four hardening fixes from Case 4 in gean (`store/payloads.go`, `blockprocessor/process.go`,
  `attestation/validate.go`, `statetransition/attestations.go`). For each, name the leanSpec rejection
  reason it implements.

### Questions to verify understanding
- Why is "a peer is down" a more common explanation than "my client's finality is broken"?
- When the spec's code fails the spec's own test, what is the correct engineering response?
