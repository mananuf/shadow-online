# 18. Mastery questions

The test of expertise is not recall — it's being able to *defend* a claim from the spec down to the code
and up to the debugger. This chapter is a graded question bank with model answers. Work them **closed
book** first; if you can answer the "expert" tier from memory and justify each answer, you own state
transitions, SSZ, and the time model. Answers are deliberately terse — expand them aloud.

## Tier 1 — Foundations

**Q1. What are the four phases of the state transition, in order?**
> `process_slots` → `process_block_header` → `process_operations` (attestations) → verify `state_root`.
> Order is load-bearing: header assumes the slot is set; operations assume the header is bound; the root
> check assumes all mutations are done. ([ch 07](07-state-transition-pipeline))

**Q2. Why do nodes re-execute blocks instead of trusting the proposer's `state_root`?**
> A block is a *claim*; re-execution *checks* it. Trusting the claim would let a malicious proposer
> convince you of an invalid transition. ([ch 01](01-introduction))

**Q3. Valid vs canonical — which mechanism decides each?**
> Validity = the state transition (is this block well-formed and does its root match?). Canonicity = fork
> choice (which valid block is the head?). ([ch 01](01-introduction), [12](12-fork-choice-vs-state-transition))

**Q4. Why does one divergent field fork the network?**
> `state_root = hash_tree_root(state)`; one different field ⇒ different root ⇒ you accept/reject
> differently than everyone else ⇒ different chain. Agreement is byte-exact. ([ch 01](01-introduction), [06](06-ssz-foundations))

## Tier 2 — The three domains

**Q5. Explain the deferred `state_root`.**
> A header can't contain the root of the state that includes it (a cycle), so it's stored with a zero
> root and filled on the *next* slot's `process_slots` from the now-known `hash_tree_root(state)`. Getting
> this wrong makes *every* root wrong. ([ch 04](04-slots), [06](06-ssz-foundations))

**Q6. What does `hash_tree_root` commit to besides the field bytes?**
> **Field order** (container roots are built in declaration order) and **length** (`mix_in_length` folds
> list/bitlist counts in). So `[a,b]` and a longer list hash differently even if the data looks similar.
> ([ch 06](06-ssz-foundations))

**Q7. Two clocks — name them and their jobs.**
> Wall-clock slot (`(now−genesis)/SECONDS_PER_SLOT`) schedules *duties*; `store.time` (interval counter,
> advanced by `on_tick`) gates *acceptance* deterministically. ([ch 05](05-time-model))

**Q8. Why must XMSS proving run off the tick loop?**
> The Engine is single-threaded; the tick *is* the clock. Proving on it delays every subsequent duty (and
> under Shadow, breaks the modeled timing). ([ch 05](05-time-model), [13](13-gean-implementation))

## Tier 3 — Consensus mechanisms

**Q9. LMD-GHOST in two sentences.**
> Each validator's *latest* vote counts; starting from the finalized/justified anchor, walk toward the
> child with the heaviest supporting subtree until a leaf — that's the head. Adding votes shifts weight,
> which can move the head (a reorg). ([ch 12](12-fork-choice-vs-state-transition))

**Q10. Why can gean's `finalized_slot` move *down*?**
> It's the *head chain's* finalized view, re-derived each update — not a global maximum. A reorg onto a
> branch that finalized fewer slots lowers it, by design (a losing higher-finalized fork must not latch
> finality above the head). True finality still can't be reorged under honest supermajority. ([ch 11](11-finality))

**Q11. Why is prune coupled to a vote-index remap?**
> Pruning compacts the proto-array, changing node indices; stored votes reference those indices, so they
> must be remapped in lockstep or weights point at the wrong nodes. ([ch 12](12-fork-choice-vs-state-transition))

**Q12. Equal-slot equivocation — how is the head kept deterministic?**
> Break the equal-slot tie toward the **larger canonical attestation-data root**; keep the max
> `(slot, hash_tree_root)` per validator, so the head is a pure function of store contents, independent of
> arrival order. Block production uses the same secondary key. ([ch 12](12-fork-choice-vs-state-transition))

## Tier 4 — Expert / debugging

**Q13. `state_root` mismatch on a block ethlambda accepted — your procedure?**
> Serialize both post-states and **byte-diff** them. Fixed-field diff ⇒ transition-logic bug (which field
> names the phase). Offset/length diff ⇒ SSZ/length bug. Bytes match but root differs ⇒ merkleization
> (field order / `mix_in_length`). ([ch 15](15-debugging-playbook), [06](06-ssz-foundations))

**Q14. Two nodes, identical blocks and votes, different heads — bug class and confirming check?**
> A **determinism** bug (networking can explain different inputs, never different outputs from identical
> inputs). Confirm by comparing the latest-vote extraction for an equivocating validator; suspect the
> equal-slot tie-break. ([ch 12](12-fork-choice-vs-state-transition), [15](15-debugging-playbook))

**Q15. A block is "rejected" — first thing you check?**
> **Parent availability.** Most "rejections" are out-of-order gossip (parent not yet imported) or clock
> issues (future horizon), not transition bugs. Walk the master tree from the top. ([ch 15](15-debugging-playbook))

**Q16. When the spec's *code* fails the spec's own *test*, what do you do?**
> Recognize it as an **upstream inconsistency**; validate your client against the documented **intent**
> and the vectors that *do* generate; escalate upstream. Don't contort the client to match a broken
> fixture. ([ch 16](16-case-studies))

**Q17. Justify a legitimate gean/spec code difference.**
> gean's `ProcessSlots` is O(1) where the spec loops; the empty-slot effect is materialized (bounded) in
> `ProcessBlockHeader`. Legitimate because the **output bytes / `state_root` are identical** — you judge
> by the post-state, not the code path. ([ch 04](04-slots), [07](07-state-transition-pipeline))

**Q18. `finalized_slot` stuck while head advances and blocks land every slot — hypothesis?**
> Liveness: votes not reaching quorum on one branch (missing aggregates, split votes), not a tally bug.
> Confirm by diffing justification state across blocks — flat ⇒ liveness, growing-but-below-quorum ⇒
> split votes. ([ch 09](09-attestation-processing), [11](11-finality))

## Tier 5 — Design & judgment

**Q19. Why does gean keep `ForkChoice` outside `ConsensusStore` and `statetransition` pure?**
> Purity makes the transition spec-faithful and deterministically testable; keeping fork choice out of
> the store enforces the valid/canonical boundary and lets it be tested in isolation with store data as
> parameters. ([ch 12](12-fork-choice-vs-state-transition), [13](13-gean-implementation))

**Q20. Why model XMSS cost as a sleep rather than just running the real prover under Shadow?**
> Shadow doesn't charge CPU, so real proving would take ~0 virtual time and the sim's timing would be
> unrepresentative. A default-off, off-loop sleep after the real op restores realistic timing without
> touching logic. ([ch 14](14-shadow-execution))

**Q21. Why is a *smaller* spec a *safer* one?**
> Fewer fields and rules ⇒ fewer places for seven independent clients to diverge ⇒ fewer interop forks.
> Simplicity is a safety property when byte-exact agreement is required. ([ch 01](01-introduction), [03](03-state))

## How to grade yourself
- **Tiers 1–2 from memory:** you can hold the model.
- **Tiers 3–4 with justification:** you can debug it.
- **Tier 5 with tradeoffs:** you can *own* it — defend design choices, not just recall behavior.

## Cross references
Every question links to its home chapter. If an answer felt shaky, that link is your next re-read.

---

### Key takeaways
- Mastery = **defending** a claim spec → code → debugger, not recalling it.
- The expert-tier reflexes: `state_root` mismatch ⇒ **byte-diff**; same-inputs-different-head ⇒
  **determinism**; "rejected" ⇒ check **parent/clock first**; "won't finalize" ⇒ suspect **liveness**.
- A legitimate gean/spec difference is judged by **identical output bytes**, never matching code paths.

### Exercises
1. Answer Tiers 1–3 closed-book; check each against its chapter.
2. For each Tier-4 question, write the *one* diagnostic action that resolves it.

### Debugging exercise
- Pick any three Tier-4 questions and, for each, write the exact command/diff you'd run in gean to
  resolve it.

### Questions to verify understanding
- Which three questions here would you ask a candidate to tell a "knows the words" engineer from one who
  "can debug Devnet"?
