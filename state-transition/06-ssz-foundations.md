# 6. SSZ foundations

SSZ (Simple Serialize) is the format that turns a consensus object into bytes, and — separately — into
a single 32-byte **hash tree root**. It is the second of your three specialization areas, and it is
inseparable from the state transition: phase 4 of the transition (**[chapter 07](07-state-transition-pipeline)**)
computes `hash_tree_root(state)` and compares it to the block's claimed `state_root`. That root *is*
an SSZ merkleization. So a serialization bug and a transition bug produce the **same symptom** — a
`state_root` mismatch — and only someone who owns SSZ can tell them apart.

> **One-sentence definition.** SSZ maps every consensus type to (a) a canonical byte string and (b) a
> deterministic Merkle root, such that any two nodes computing either agree exactly, and any single
> field can be proven against the root with a small branch.

## Theory — why SSZ exists (PDF §2.1)

Ethereum consensus needs a serialization with three properties that general formats (RLP, protobuf,
JSON) don't all provide:

1. **Deterministic.** One value → exactly one byte string. No optional whitespace, no field-order
   ambiguity, no canonicalization choices. Two clients *must* produce identical bytes or their roots
   diverge and the network forks.
2. **Merkleization-friendly.** The layout is designed so a value's Merkle tree is trivial to build and
   a single field is cheaply provable. This is what lets a light client verify one validator's balance
   against a 32-byte root without downloading the state.
3. **Simple.** A small type system with mechanical rules — easy to implement identically in Go, Rust,
   Python, Zig. Simplicity *is* a safety property when seven clients must agree byte-for-byte.

Two independent outputs, never confuse them:

- **Serialization** → the wire/storage bytes (`Marshal`).
- **Merkleization** → the `hash_tree_root` (a 32-byte commitment). The `state_root` is this one.

## The type system (PDF §2.2)

| Category | Types | Fixed or variable size? |
|----------|-------|-------------------------|
| **Basic** | `uintN` (8/16/…/256), `boolean` | Fixed |
| **Vector** | `Vector[T, N]` — exactly N elements | Fixed iff T is fixed |
| **List** | `List[T, N]` — 0..N elements | **Variable** |
| **Bitvector** | `Bitvector[N]` — N bits | Fixed |
| **Bitlist** | `Bitlist[N]` — 0..N bits | **Variable** |
| **Container** | struct of named fields | Fixed iff all fields fixed |
| **Union** | one of several types (unused in `lstar`) | Variable |

"Fixed size" means the serialized length is known from the type alone. "Variable" means it depends on
the value (how many elements/bits). This distinction drives the whole serialization algorithm.

## Serialization mechanics (PDF §2.3)

A container is serialized as **two regions**: a fixed part, then a variable part.

- Each **fixed-size** field is written inline, in order, little-endian.
- Each **variable-size** field writes a **4-byte offset** in the fixed part (pointing to where its
  bytes begin in the variable part), and its actual bytes go into the variable part in field order.

```
  Container { a: uint64 (fixed), b: List (variable), c: uint32 (fixed) }

  ┌──────── fixed part ────────┬──────── variable part ────────┐
  │ a(8B) │ offset→b (4B) │ c(4B) │ b's elements …               │
  └───────┴───────────────┴──────┴──────────────────────────────┘
                     └───────────────────────────►┘
```

Decoding reads offsets to slice out each variable field. This is exactly where **deserialization
hardening** matters (PDF §2.3.3): a malformed offset must be rejected, never trusted. The spec requires
the **first offset to be at least one offset-word wide** (`≥ 4`); a zero first offset is contradictory
(it claims zero elements yet a full-scope element) and must be rejected up front. This is the
`leanSpec` #1177 fix — a decoder that skips it can be fed a malformed blob.

### Bitlists and the sentinel bit (PDF §2.3.2)

A `Bitlist[N]` packs bits into bytes, then appends a **sentinel bit**: a single `1` bit one position
past the last data bit. That sentinel is how the *length* survives serialization — without it, trailing
zero bits would be ambiguous. To read the length you find the highest set bit and subtract one.

gean's implementation (`internal/types/bitlist.go`):

```go
func BitlistLen(b []byte) uint64 { … }        // length via the sentinel bit
func BitlistGet(b []byte, i uint64) bool { … } // bit i
func BitlistFromIndices(ids []uint64) []byte { … }
```

Bitlists appear in gean's `AggregatedAttestation.aggregation_bits` and in the state's
`justifications_validators` — and a length computed from a **missing or wrong sentinel** is a classic
source of the `JUSTIFICATION_VOTES_LENGTH_MISMATCH` rejection (see ch 09).

## Merkleization and hash tree roots (PDF §2.4)

The `hash_tree_root` is built bottom-up:

1. **Chunk.** Serialize the value's contents into 32-byte chunks (packing basic types together).
2. **Pad.** Pad the chunk count up to the next power of two with zero chunks.
3. **Tree.** Hash pairs bottom-up until one 32-byte root remains.
4. **Mix in length.** For lists and bitlists, hash the root together with the element count
   (`mix_in_length`) — so `[a, b]` and `[a, b, 0]` get *different* roots. This is why length is part of
   the commitment, not just the data.

```
  chunks:  c0  c1  c2  c3        (padded to power of two)
            \  /    \  /
            h01      h23
              \      /
              root(data)
                 │  mix_in_length(N)  ← for List/Bitlist
              hash_tree_root
```

A container's root is the tree over its fields' roots, in declaration order. **Field order is part of
the commitment** — reorder two fields and every root changes.

## Generalized indices and proofs (PDF §2.5)

Every node in the Merkle tree has a **generalized index**: root = 1, its children 2 and 3, theirs 4–7,
and so on (`2·i`, `2·i+1`). A field's generalized index is its position in this numbering. A **Merkle
proof** for a field is the sibling hashes along the path from that field's leaf to the root; a verifier
re-hashes up the path and checks it equals the known root. That is how you prove *"validator 42's
balance is X"* against a 32-byte `state_root` without the whole state — the mechanism behind light
clients and cross-chain state proofs.

## Gean implementation — generated, never hand-written

gean does **not** hand-write SSZ. Struct fields carry `ssz-size`/`ssz-max` tags, and `sszgen`
generates the `*_encoding.go` files. The object→file mapping (from the `make sszgen` target):

| Type(s) | Generated file |
|---------|----------------|
| `ChainConfig` | `types/config_encoding.go` |
| `Checkpoint` | `types/checkpoint_encoding.go` |
| `Validator` | `types/validator_encoding.go` |
| `AttestationData, Attestation, SignedAttestation, AggregatedAttestation, SingleMessageAggregate, SignedAggregatedAttestation` | `types/attestation_encoding.go` |
| `BlockHeader, BlockBody, Block, MultiMessageAggregate, SignedBlock` | `types/block_encoding.go` |
| `State` | `types/state_encoding.go` |
| `BlocksByRangeRequest` | `types/blocks_by_range_encoding.go` |

**Rules that are non-negotiable:**

- **Never hand-edit `*_encoding.go`.** They are generated. To change a type, edit the struct + tags and
  run `make sszgen`. If generation fails, stop and report — never hand-write SSZ as a fallback. A
  hand-tweaked encoder that disagrees with the generator by one byte forks the network silently.
- The generator uses **fastssz** at runtime; offset validation, chunking, and `mix_in_length` live in
  the library and the generated code.

### Spec → gean mapping

| leanSpec | gean | Notes |
|----------|------|-------|
| `serialize(obj)` | `obj.MarshalSSZ()` | Generated |
| `hash_tree_root(obj)` | `obj.HashTreeRoot()` | Generated; the `state_root` uses `State.HashTreeRoot()` |
| SSZ type definitions | struct + `ssz-*` tags | `internal/types/*.go` |
| `Bitlist` ops | `BitlistLen/Get/FromIndices` | `internal/types/bitlist.go` |
| list-decoder offset check | fastssz offset validation | library-level |

## How SSZ affects the state transition

- **`state_root` *is* `HashTreeRoot(state)`.** Phase 4 of the transition succeeds iff the SSZ root you
  compute equals the block's claim. SSZ correctness is transition correctness.
- **The deferred `state_root`.** A block header stores a *zero* `state_root` when first recorded,
  because a header cannot contain the root of a state that includes that header (a cycle). The real
  root is filled in on the *next* slot's processing. This is a direct consequence of merkleization:
  the root commits to everything, so it can't be known until everything (including the header) is
  placed. Miss this and every root is wrong.
- **Length is committed.** Because `mix_in_length` folds element counts into the root, an off-by-one in
  a list or a wrong bitlist sentinel changes the root even when the data bytes look right.

## Debugging techniques — the root mismatch

A `state_root` mismatch says "our post-states differ." SSZ tools localize it:

```
state_root mismatch
        │
        ├─ Serialize BOTH states (yours + a client that accepted the block).
        │  Diff the bytes. First differing byte → the guilty region.
        │
        ├─ Differing byte in a FIXED field?   → a transition-logic bug wrote a
        │                                         wrong value (ch 07–09)
        ├─ Differing OFFSET (in the fixed part) → a variable field has the wrong
        │                                         length; suspect a list/bitlist
        ├─ Bytes match but ROOT differs?      → a merkleization bug:
        │                                         wrong field order, missing
        │                                         mix_in_length, wrong padding
        └─ Decode fails on a peer's bytes?    → offset hardening: first offset < 4,
                                                 non-monotonic, or past scope (#1177)
```

The highest-leverage move is the **byte diff of the two serialized states** — it turns an opaque
32-byte mismatch into a named field. Then decide: fixed-value difference ⇒ transition bug; length/offset
difference ⇒ SSZ/encoding bug.

## Common mistakes

- **Hand-editing generated encoders** to "fix" a root — forks the network. Fix the struct + tags,
  regenerate.
- **Confusing serialize with hash_tree_root** — they are different outputs; a wire round-trip passing
  doesn't prove the root is right (and vice versa).
- **Forgetting `mix_in_length`** reasoning — assuming `[a,b]` and `[a,b]` with a stray trailing entry
  hash the same. They don't.
- **Wrong bitlist sentinel** — a length off by one cascades into `_LENGTH_MISMATCH` rejections.
- **Field reordering** — changing struct field order (or tags) without regenerating and without
  realizing the root changed.

## Mental models

- **Two outputs, one type.** Serialization is for the wire; the hash tree root is for agreement. The
  `state_root` is always the second.
- **The root is a fingerprint of *structure and length*, not just bytes.** `mix_in_length` and field
  order are baked in.
- **Offsets are the only place a decoder trusts attacker-supplied numbers** — which is why hardening
  them (first-offset ≥ 4, monotonic, in-scope) is a security property, not a nicety.

## Cross references

- **[07 — The state transition pipeline](07-state-transition-pipeline)** — phase 4 uses the root; the
  deferred `state_root`.
- **[03 — The State](03-state)** — the object whose root is the `state_root`.
- **[09 — Attestation processing](09-attestation-processing)** — bitlists in aggregation bits and
  justification votes.
- **[15 — Debugging playbook](15-debugging-playbook)** — the full root-mismatch workflow.

## Further reading

- `lean_consensus.pdf` §2 *Simple Serialize (SSZ)* (all of it — §2.3 serialization, §2.4
  merkleization, §2.5 proofs).
- gean: `internal/types/*.go` (+ the `make sszgen` target), `internal/types/bitlist.go`. fastssz.

---

### Key takeaways
- SSZ produces **two** outputs: canonical **bytes** (serialize) and a 32-byte **hash tree root**
  (merkleize). The `state_root` is the root of `State`.
- Serialization = fixed part + 4-byte offsets into a variable part; offsets are the hardening-critical,
  attacker-influenced numbers.
- Merkleization chunks → pads → trees → **mixes in length**; field order and length are part of the
  commitment.
- gean's encoders are **generated** (`sszgen`/fastssz) — never hand-edit them; a one-byte disagreement
  forks the network.
- A serialization bug and a transition bug share one symptom (`state_root` mismatch); the **byte diff**
  tells them apart.

### Exercises
1. Serialize (on paper) a container `{a: uint32 = 1, b: List[uint8] = [7,8]}`. Show the fixed part
   (with the offset) and the variable part.
2. Explain why `[a, b]` and `[a, b]`-with-a-different-length hash to different roots.
3. Why must the first offset of a non-empty variable-size list be ≥ 4?

### Debugging exercises
1. Two clients disagree on `state_root`, but their serialized states are byte-identical. What class of
   bug is it, and name three specific causes.
2. gean rejects a peer's block body with a decode error but ethlambda accepts it. Where do you look
   first, and what does that tell you about which client is wrong?

### Code-reading assignment
- Open `internal/types/bitlist.go` and work out, by hand, how `BitlistLen` uses the sentinel bit.
- Find the `make sszgen` target and confirm which file `State`'s encoder lives in. Then find where the
  live code calls `State.HashTreeRoot()` during the transition.

### Questions to verify understanding
- Why is "simplicity" a *safety* property for SSZ specifically?
- Why can't a block header contain the `state_root` of the state that includes it, and how does the
  protocol resolve the cycle?
- How does a Merkle proof let a light client verify one field against a 32-byte root?
