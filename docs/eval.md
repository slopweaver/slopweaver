# Eval

How Slopweaver turns "is retrieval any good?" into a repeatable number, so every future retrieval or
model change has to _move that number_ to earn its place. The harness only **measures** — it ships no
change to embeddings, retrieval, or the model. It runs locally and keyless, on [promptfoo](https://promptfoo.dev).

## What it measures

The artifact under test is the `ask` answer: a structured `{tldr, details, citations[]}` over a
retrieved slice. `ask --json` also exposes the slice itself (`retrievedRefs`) apart from what the answer
cited (`citedTokens`), so we can grade at **two points** and keep them distinct:

- **Retrieval recall@k** — did the expected records reach the candidate slice at all?
  `|expected ∩ slice| / |expected|`. A miss here is the _retriever_ dropping a record before grounding
  ever saw it (e.g. recency decay burying an old-but-relevant record).
- **Answer recall + citation precision** — of the expected records, how many did the answer cite
  (`|expected ∩ cited| / |expected|`), and of what it cited, how much was right
  (`|expected ∩ cited| / |cited|`)? A miss here _with_ a slice hit is the model having the record and
  not using it.

Separating them is what makes a red case **actionable** instead of just "worse".

Retrieval recall is **deterministic** (fixed corpus + fixed query ⇒ the same slice every run) and is the
**headline gate**. Answer recall and citation precision are **stochastic** (the model chooses what to
cite), so they are advisory and reported as a median over reps with the observed range.

> Answer recall can _exceed_ retrieval recall. That is not a bug: `ask` lets an answer cite a record a
> gold digest _mentions_ (grounded by the digest, not the record's own retrieval), so a record can be
> cited without being individually retrieved. The deterministic gate counts only records that actually
> reached the slice, so it is unaffected.

## The golden set (ground truth we own)

The gate scores against a **hand-labelled, frozen** expected-grounding set — `GOLDEN_CASES` in
`src/eval/scorer.ts`, `{ question, kind, expectedGrounding: sourceId[] }`. Labels are chosen by
**reading the corpus** — the specific records that genuinely answer each question — and are **never**
graded against `ask`'s own citations. That kills the circular-grading hole: the gate can't drift toward
the retriever's own opinion of what is relevant.

12 questions span four classes (three each), because each stresses retrieval differently:

| Class           | What it stresses                                                       |
| --------------- | ---------------------------------------------------------------------- |
| `single-fact`   | one specific record holds the answer                                   |
| `aggregation`   | a correct answer must rest on several records at once                  |
| `recency`       | the answer lives in an **old** record — recency decay is the adversary |
| `cross-cutting` | one design thread running through several PRs                          |

The corpus is Slopweaver's own public GitHub history, ingested into the local corpus store — public, so the
scoreboard is reproducible by anyone.

## Who judges (the alignment guard)

Three tiers, by competence:

1. **Objective gate** — deterministic recall/precision vs the labels we own. No model, so it can't drift
   from them. This is the only thing that gates.
2. **Advisory faithfulness** _(arrives in PR4)_ — one LLM check that every claim is backed by a cited
   record. It flags; it never gates. Bias mitigations (A/B-order swap, mask the baseline, a different
   judge model where the CLI allows) are documented there — an LLM judge is the one place misalignment
   can creep in, so it is deliberately kept off the gate.
3. **Subjective quality** — "is this the answer I'd have wanted?" stays a human call in promptfoo's
   side-by-side. The judge is triage, not verdict.

## Reproduce

```bash
yarn eval              # run every golden case once through promptfoo, score with the deterministic gate
yarn eval:view         # open the promptfoo view (per-case answers + the three named metrics)
yarn eval:scoreboard   # run 3 reps/case and regenerate docs/eval-baseline.md (metrics only)
```

`yarn eval` scores each case via a pure promptfoo assertion (`eval/groundingAssertion.ts` →
`scoreGrounding`); no model touches the gate. `yarn eval:scoreboard` writes the baseline snapshot
([docs/eval-baseline.md](./eval-baseline.md)) — metrics only, no answer text, so it is always safe to
commit.

## The baseline, and the case that bites

See [docs/eval-baseline.md](./eval-baseline.md) for the full per-case scoreboard. The headline baseline:
**mean retrieval recall@k 55%**, with **5 of 12 cases red**. The shape is the whole point of measuring:

- **`single-fact` is solved** — all three score 100% retrieval recall. Retrieval nails "one record holds
  the answer".
- **`recency` is broken** — all three score **0%**. The oldest records (the May roadmap comments) never
  reach the slice: this is the **completeness gap**, reproduced as a red cluster. Answer recall is 0%
  too, so the miss is purely retrieval — the model can't cite what it never saw.
- **broad `aggregation` is weak** — "what shipped across v0.1?" scores 20% (1 of 5 PR records reaches the
  slice); retrieval favours a few records over the full set a "what shipped" answer needs.

v0.2 only _reproduces_ this — the fix (decay half-life / slice-cap tuning) is a retrieval change, so it
belongs to v0.3 and must justify itself by **moving this number**.

## The deterministic regression gate

The scoreboard above is the **semantic** picture (hybrid BM25⊕cosine) — it needs the on-device embedder,
so it is human-run and advisory. The gate that actually **blocks a PR** is a separate, **deterministic**
measurement so it can run hermetically in CI (no embedder, no Claude, no live GitHub, no wall clock):

- **Retrieval:** BM25 × recency-decay only (the lexical floor a code change can silently regress).
- **Corpus:** a frozen, hygiene-audited fixture — [`eval/fixtures/corpus.bronze.jsonl`](../eval/fixtures/corpus.bronze.jsonl)
  (the golden set's own records; the two early porting PRs are excluded as they reference private terms).
- **Time:** a pinned reference instant, so recency decay never drifts.
- **Baseline:** [`eval/baseline.recall.json`](../eval/baseline.recall.json) — an **overall floor + per-cluster
  floors** (per-cluster catches a recency/aggregation drop a mean would hide). It is byte-reproducible:
  `scoreRecall` over the fixture equals the stored floors exactly.

`slopweaver dev gate` composes this regression check with the hygiene gate and the PR-format check into
one non-zero-exit gate, writing a JSONL run log + a baseline↔candidate diff under `$SLOPWEAVER_HOME/ledgers/`.
The floors move **only** through `yarn eval:rebaseline --write --reason "…"` (refused in CI without an
explicit override) — never from the gate itself. See [dev-gate.md](./dev-gate.md).

## Not yet here

The advisory faithfulness judge + human review surface, and a semantic (embedder) regression track, are
later PRs. This gate is the deterministic lexical floor; the semantic scoreboard stays the advisory companion.
