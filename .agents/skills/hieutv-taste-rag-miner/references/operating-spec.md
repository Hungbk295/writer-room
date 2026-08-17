# Hiếu TV Taste RAG operating specification

## Contents

1. Memory model and evidence classes
2. Canonical project and stable state
3. Cleaning and rhetorical segmentation
4. Decision mining and schemas
5. Consolidation
6. QMD indexing and retrieval
7. Evaluation, reporting, and failure behavior

## 1. Memory model and evidence classes

Maintain these distinctions:

```text
Knowledge = what is true
Content = what was discussed
Style = how something was expressed
Taste = which editorial choice was preferred in a situation
Decision Memory = evidence of that choice
Principle = repeated stable preference across decisions
Judgment = whether a precedent applies now
```

The primary retrieval unit is:

```text
Editorial Situation → Decision → Boundary → Reason → Transfer Conditions
```

Label evidence precisely:

- `OBSERVED`: directly visible in the transcript.
- `INFERRED`: a plausible rationale; use language such as "likely rationale"
  or "inferred editorial purpose" and never claim known author intent.
- `SYNTHETIC`: model-generated nearby alternatives used to reveal a boundary;
  label each `synthetic_counterfactual` and never claim the creator considered
  it.
- `DISTILLED`: a pattern supported by multiple independent videos.

Editorial effectiveness, factual correctness, epistemic strength, and
investment opinion are separate. Preserve rhetorically useful high-risk cases
with explicit qualification instead of silently converting claims to facts.

Do not learn exact phrases, greetings, filler, catchphrases, or surface sentence
templates. Abstract choices into sequences and transferable decision geometry.

## 2. Canonical project and stable state

Create this structure when absent:

```text
hieutv-taste-rag/
├── input/
├── store/
│   ├── sources/
│   ├── decisions/<source-slug>/
│   ├── principles/
│   └── patterns/
├── state/
│   ├── source-manifest.jsonl
│   ├── run-state.json
│   ├── rejected-cases.jsonl
│   └── principle-candidates.jsonl
├── review/low-confidence/
├── reports/runs/
└── eval/
    ├── retrieval-cases.json
    └── qmd-bench.json
```

Markdown files are canonical. QMD's SQLite index is disposable retrieval
infrastructure. Never write its tables directly or modify unrelated QMD
collections/configuration.

For every raw transcript calculate `SHA256(raw bytes)` and record one current
manifest row:

```json
{"path":"/absolute/source.txt","source_id":"src_5e1980fd213a","source_hash":"...","processed_at":"RFC3339","pipeline_version":"1.0.0","decision_count":17}
```

Skip only when path, hash, and pipeline version all match. If content changes,
identify the old source row, delete only generated source/decision/review
artifacts owned by its previous `source_id`, regenerate, and replace the
manifest row. Never duplicate memories across reruns.

Use deterministic identifiers:

```text
source_id  = src_<first 12 chars of raw SHA256>
segment_id = <source_id>_s001
decision_id = dc_<SHA256(source_id + segment_id + decision_type + normalized selected strategy)[:12]>
```

Use semantic slugs for principles and patterns, such as
`p_hidden-cost-over-obvious-cost` and `sp_story-consequence-concept`.

## 3. Cleaning and rhetorical segmentation

Inputs are Vietnamese `.txt` or `.md` transcripts and may contain ASR errors,
timestamps, boilerplate, `[am nhac]` markers, repeated fragments, mixed English
finance terms, and damaged paragraphing.

Cleaning may remove music/boilerplate markers, repair certain ASR duplication,
restore conservative punctuation and paragraphs, and correct only obvious
spelling mistakes. It must not strengthen claims, add facts, improve arguments,
invent examples, summarize away reasoning, or remove genuine rhetorical
repetition. Never modify the original input.

Write each source memory with frontmatter and these sections:

```markdown
---
source_id: src_xxx
creator: hieutv
source_type: transcript
language: vi
title: ...
topic: ...
raw_hash: ...
processed_at: ...
---

# Title

## Argument map

## Rhetorical map

## Clean transcript
```

Segment by coherent rhetorical function, usually 150–800 words: intro,
audience framing, question, default belief, belief challenge, personal story,
thesis, argument, mechanism, example, analogy, counterargument, qualification,
emotional implication, second-order implication, summary, and call to action.
Do not force decisions from every segment. For long sources, process sequential
windows with adjacent context, retain a source-level thesis summary, then run a
whole-source consolidation pass.

## 4. Decision mining and schemas

Ask what meaningful, non-inevitable editorial choice is visible. Strong cases
resolve trade-offs such as clear/provocative, technical/accessible,
abstract/concrete, safe/opinionated, personal/impersonal, first-order/
second-order, logic/emotion, compression/repetition, story/framework, or
strength/defensibility.

Use one primary `decision_type`:

```text
hook_strategy question_framing angle_selection belief_challenge
thesis_strength argument_order concept_introduction concept_explanation
evidence_selection example_selection analogy_selection personal_story_usage
second_order_consequence claim_strength uncertainty_calibration
counterargument_handling audience_assumption jargon_calibration
emotional_framing repetition_strategy compression_strategy
transition_strategy closing_strategy call_to_action
```

Add a type only when none fits. Generate 3–8 structural geometry tags by asking:
"If all nouns were replaced, what problem remains?"

Common tags include:

```text
young_audience early_career large_financial_commitment high_irreversibility
low_liquidity future_uncertainty loss_of_optionality social_norm
status_signaling default_belief hidden_cost second_order_effect
asymmetric_risk delayed_payoff cashflow_constraint fear_of_missing_out
identity_pressure career_flexibility compounding behavioral_bias
uncertain_return high_narrative_temptation moderate_evidence
abstract_financial_concept low_financial_literacy
```

Write one compact 250–600 word Markdown file per accepted decision. Put the most
retrieval-important semantic text near the top: situation, problem, geometry,
observed strategy, boundary, rationale, and transfer conditions. Prefer
Vietnamese analysis with stable English taxonomy terms.

Use this schema:

```markdown
---
id: dc_xxxxxxxxxxxx
memory_type: decision_case
creator: hieutv
domain: personal_finance
topic: ...
decision_type: second_order_consequence
source_id: src_xxxxxxxxxxxx
segment_id: src_xxxxxxxxxxxx_s007
evidence_status: observed_choice_inferred_rationale
human_validated: false
confidence: 0.87
editorial_value: high
epistemic_risk: medium
decision_geometry:
  - loss_of_optionality
  - large_financial_commitment
principle_candidates:
  - hidden-cost-over-obvious-cost
---

# Retrieval-oriented title

## Editorial situation
## Editorial problem
## Observed choice
## Why this is editorially interesting
## Decision boundary
### Too safe — synthetic counterfactual
### Preferred region — observed strategy
### Too far — synthetic counterfactual
## Likely rationale
## Transfer conditions
## Do not transfer blindly
## Source evidence
```

Counterfactuals must be reasonable adjacent choices, not strawmen. Useful
boundaries include generic/sweet spot/dramatic, technical/accessible/
oversimplified, detached/balanced/overemotional, cautious/defensible/
unsupported certainty, and compressed/adequate/overexplained. Use non-linear
nearby alternatives when a spectrum does not fit.

Score confidence by evidence clarity:

```text
0.90–1.00 obvious observed pattern and role
0.80–0.89 strong with well-supported inferred rationale
0.70–0.79 useful but interpretation-dependent
0.60–0.69 weak; quarantine unless unusually valuable
below 0.60 reject
```

Automatic acceptance requires `confidence >= 0.75`; quarantine lower cases
under `review/low-confidence/`, outside QMD's primary store. Score
`editorial_value` as low/medium/high/signature and `epistemic_risk` as
low/medium/high independently.

Every accepted case may propose zero to three `principle_candidates`. Append
one JSONL event per candidate with case ID, source ID, slug, confidence, and
timestamp. Do not create a principle immediately.

Reject generic statements such as "uses storytelling" or "has strong hooks."
Accept only cases that explain situation, choice, alternatives, trade-off,
evidence status, boundary, transfer, and failure conditions.

## 5. Consolidation

Promote a principle only when supported by at least three accepted decisions
from three distinct source videos. Five sources gives stronger confidence. A
principle must include preference, likely reason, applicable conditions,
boundary, exceptions, supporting cases, source diversity, and confidence.
Never promote a topical position such as "young people should not buy houses."

Principle frontmatter and body:

```markdown
---
id: p_hidden-cost-over-obvious-cost
memory_type: principle
creator: hieutv
domain: personal_finance
support_count: 3
source_count: 3
confidence: 0.84
status: active
supporting_cases: [dc_xxx, dc_yyy, dc_zzz]
---

# Hidden cost over obvious cost
## Principle
## Why it works
## Apply when
## Boundary
## Common failure mode
## Supporting precedents
```

Promote a style pattern only after a meaningful sequence appears in three
different sources. Useful sequences include story → consequence → concept →
generalization; inherited belief → contextual challenge → replacement model;
and simple numeric example → financial consequence → life consequence.

Style pattern schema:

```markdown
---
id: sp_story-consequence-concept
memory_type: style_pattern
creator: hieutv
support_count: 3
source_count: 3
confidence: 0.84
supporting_cases: [dc_xxx, dc_yyy, dc_zzz]
---

# Story → consequence → concept
## Pattern
## Best use
## Why it works
## Avoid when
## Supporting cases
```

Merge semantic duplicates at the principle/pattern layer. Retain independent
cross-source decisions as evidence. Merge same-source duplicate decisions.
Preserve contradictions and refine conditional boundaries rather than forcing
one universal rule. New evidence may strengthen, weaken, condition, split,
merge, or retire a distilled memory.

Maintain a corpus taste profile only after sufficient evidence. For each
comparative dimension (for example specificity, compression, jargon density,
claim strength, uncertainty calibration, story density, second-order
reasoning), store a range, supporting decisions, counterexamples, and
confidence—never a bare pseudo-objective score.

## 6. QMD indexing and retrieval

Detect installed syntax first:

```bash
command -v qmd
qmd --help
qmd collection help
qmd status
```

Never reinstall QMD, change embedding models, edit its SQLite tables, clean
unrelated collections, or use force embedding casually.

Preferred four-collection topology:

```bash
qmd collection add /abs/store/sources --name hieutv-sources --mask '**/*.md'
qmd collection add /abs/store/decisions --name hieutv-decisions --mask '**/*.md'
qmd collection add /abs/store/principles --name hieutv-principles --mask '**/*.md'
qmd collection add /abs/store/patterns --name hieutv-patterns --mask '**/*.md'
```

Requested aggregate compatibility topology:

```bash
qmd collection add /abs/store --name hieutv --mask '**/*.md'
```

Do not register both topologies for one project. Before adding any collection,
use `qmd collection show <name>`. If it exists at another path, stop; do not
remove or repoint it automatically. Add context once and prefer excluding these
collections from unrelated unscoped searches.

After canonical writes:

```bash
qmd update
qmd embed -c <collection>
```

For large batches, checkpoint every 3–5 new sources. Never run `qmd embed -f`
for normal incremental ingestion.

Transform a writing request into a Situation Query before retrieval:

```text
Domain and audience
Editorial problem
Decision geometry
Rhetorical need
Claim/risk profile
Intent: analogous editorial decisions, not surface-topic matches
```

Use a structured query supported by the installed QMD version:

```bash
qmd query -c hieutv -n 12 --format json \
  $'intent: Find analogous editorial decisions by geometry, not merely topic.\nlex: loss_of_optionality hidden_cost early_career\nvec: A young audience faces a socially desirable irreversible commitment under future uncertainty.\nhyde: A decision case reframes an obvious price discussion around reduced flexibility and second-order life consequences.'
```

Fetch full documents with `qmd get` or `qmd multi-get` before relying on them.
Rerank 10–15 candidates by geometry, audience, life stage, editorial problem,
rhetorical goal, risk profile, and transferability. Return 3–6 precedents and
state similarity, difference, transfer, non-transfer, and adaptation for each.

## 7. Evaluation, reporting, and failure behavior

Maintain `eval/retrieval-cases.json` with same-topic, exact, alias, and most
importantly cross-topic/same-geometry cases. Examples:

- a young worker's car loan should retrieve home-ownership optionality cases;
- an emergency fund should retrieve liquidity-as-ability-to-exit cases;
- spending all savings on an overseas degree should retrieve irreversible
  commitment, liquidity, and future-opportunity cases.

After each batch run at least:

1. same-topic retrieval;
2. same geometry with different topic;
3. principle/trade-off lookup.

If same-topic works but cross-topic repeatedly fails, enrich the early
`editorial_problem`, `decision_geometry`, and `transfer_conditions` language.
Benchmark only after expected documents exist; never optimize solely for
same-topic precision.

Write `reports/latest.md` plus a timestamped copy containing discovered,
skipped, processed, and failed files; accepted/rejected/quarantined counts;
principle and pattern changes; QMD update/embed status; smoke-test results;
contradictions; and extraction weaknesses.

If one transcript fails, log and continue. If QMD fails, keep canonical
Markdown and mark indexing pending. If QMD is unavailable, finish extraction
when possible. Never delete inputs or unrelated state. Restrict stale artifact
replacement to the affected source ID.

