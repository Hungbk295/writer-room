---
name: hieutv-taste-rag-miner
description: Build and incrementally maintain a searchable editorial Taste RAG from Vietnamese Hiếu TV transcript .txt or .md files. Use when ingesting transcripts, cleaning and rhetorically segmenting sources, mining contrastive editorial decision cases, consolidating cross-source principles and style patterns, indexing those Markdown memories with QMD, or evaluating cross-topic retrieval by decision geometry. This learns editorial judgment rather than transcript topics or creator wording.
---

# Hiếu TV Taste RAG Miner

Build a canonical Markdown memory of editorial decisions, then use QMD only as
the retrieval index. Optimize for fewer, richer, contrastive, transferable
decision cases instead of transcript chunks.

## Load the operating rules

Before ingesting, consolidating, retrieving, or evaluating, read
[`references/operating-spec.md`](references/operating-spec.md) completely. It
contains the evidence classes, schemas, taxonomy, confidence gates,
idempotency contract, and QMD safety rules.

## Choose the QMD topology

Use one topology per project; do not index the same canonical files through
both topologies.

- Prefer `four` when the user wants the full design: `hieutv-sources`,
  `hieutv-decisions`, `hieutv-principles`, and `hieutv-patterns`.
- Use `aggregate` only when the user explicitly asks for one collection such
  as `hieutv`. Point it at `store/`, whose subdirectories still preserve the
  four memory types. The bundled runner defaults to this requested
  compatibility mode.

In either topology, never index `review/low-confidence/` into the primary
decision corpus.

## Ingest a transcript batch

1. Resolve the input directory and the Taste RAG project root.
2. Detect QMD with `command -v qmd`, inspect `qmd --help`, `qmd collection
   help`, and `qmd status`; never reinstall QMD or change its models.
3. Create the project structure specified in the operating reference without
   changing any input file.
4. Discover `.txt` and `.md` recursively unless the request narrows the set.
5. Hash raw bytes with SHA-256. Skip only when path, hash, and pipeline version
   all match the manifest.
6. For a changed source, remove only generated artifacts owned by its previous
   `source_id`, then regenerate them.
7. Clean conservatively, build source and rhetorical maps, mine meaningful
   decisions, generate adjacent synthetic counterfactuals, score confidence,
   and write accepted or quarantined cases.
8. Continue after per-file semantic failures; log them. Stop only for unreadable
   input, unwritable output, or unsafe/indeterminate QMD behavior.
9. After the batch, consolidate principle candidates and style sequences
   across independent videos. Enforce the promotion thresholds.
10. Index only after canonical Markdown is safely written. Run incremental
    `qmd update` and `qmd embed -c <collection>` without `-f`.
11. Run same-topic, cross-topic/same-geometry, and principle lookup smoke tests.
12. Write `reports/latest.md` and a timestamped run report.

For automated `.txt` batches in this repository, run:

```bash
.agents/skills/hieutv-taste-rag-miner/scripts/run-ingestion-loop.sh \
  /absolute/path/to/transcripts \
  /absolute/path/to/hieutv-taste-rag
```

The runner invokes Codex once per changed transcript, performs a final
cross-source consolidation pass, registers the aggregate QMD collection
`hieutv`, embeds it incrementally, and performs smoke tests. Use `--dry-run`
before a costly corpus run. Use `--self-test-qmd` to verify QMD collection,
embedding, and vector retrieval in an isolated temporary index.

## Mine one source

Keep whole-source awareness even when processing long windows. Write:

- `store/sources/<source-slug>.md` with provenance, argument map, rhetorical
  map, and cleaned transcript;
- one 250–600 word Markdown document per accepted decision under
  `store/decisions/<source-slug>/`;
- sub-threshold cases under `review/low-confidence/<source-slug>/`;
- manifest and candidate JSONL state using atomic replacement when modifying
  existing state.

Ask of each rhetorical segment:

> What meaningful editorial choice is visible here that could plausibly have
> been handled differently while remaining reasonable?

Create no case if the answer is merely a topic summary, generic style label,
or trivial presentational fact.

## Apply the hard gate

Accept a decision only if it clearly identifies:

1. editorial situation and problem;
2. observed choice;
3. reasonable synthetic alternatives;
4. resolved trade-off and decision boundary;
5. observed evidence versus inferred rationale;
6. 3–8 topic-independent geometry tags;
7. transfer and non-transfer conditions;
8. editorial value separately from epistemic risk.

Accept automatically at `confidence >= 0.75`. Quarantine `0.60–0.74`. Reject
below `0.60`. Do not upgrade financial claims into facts, infer author intent
as known, or learn catchphrases as Taste Memory.

## Consolidate cautiously

Promote a principle or style pattern only with at least three decision cases
from three distinct source videos. Retain repeated cross-source decisions as
support; merge same-source semantic duplicates. Preserve contradictions when
they reveal conditional boundaries. Never promote a topical opinion into a
taste principle.

## Retrieve for writing

Transform the writing prompt into a Situation Query containing audience,
editorial problem, decision geometry, rhetorical need, and risk profile.
Retrieve about 10–15 decision candidates, then rerank by geometry, audience,
life stage, editorial problem, rhetorical goal, risk, and transferability.
Return only 3–6 precedents.

For each selected precedent state what is similar, what differs, what
transfers, what must not transfer, and how to adapt it. Fetch full QMD documents
before relying on snippets. Retrieve precedents; never clone prose.

