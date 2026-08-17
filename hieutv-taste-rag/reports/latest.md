+# Taste RAG corpus consolidation — 2026-08-12T03:13:25Z

## Run summary

- Run type: corpus-level consolidation of the completed 30-source batch
- Transcript ingestion in this pass: none
- Discovered canonical source rows: 30
- Previously processed sources inspected: 30
- Skipped: 0
- Failed: 0
- Accepted decision cases inspected: 229
- Quarantined decisions: 0
- Rejected decisions recorded: 0
- Accepted cases below the 0.75 gate: 0
- Input integrity: 30/30 manifest paths present and raw SHA-256 hashes unchanged
- Input transcripts modified: no
- QMD update/embed: not run by explicit user instruction
- Retrieval smoke tests: not run because QMD was excluded from this consolidation pass

## Candidate-state consolidation

- Candidate events before consolidation: 463
- Candidate events after consolidation: 458
- Distinct candidate slugs before consolidation: 407
- Distinct candidate slugs after consolidation: 393
- Stale candidate references after consolidation: 0
- Duplicate case/source/slug events after consolidation: 0
- State write: validated JSONL and atomically replaced

Semantic merges were limited to labels expressing the same decision geometry:

- `expose-tool-goal-inversion`, `goal-map-before-instrument`, `step-back-from-tool-to-purpose`, and `define-goal-by-function-before-mechanism` → `purpose-before-tool-optimization`
- `replace-binary-with-bounded-permission` → `permission-with-present-boundaries`
- `hold-rate-constant-to-reveal-scale` and the redundant co-label `concrete-scale-for-abstract-forces` → `scale-contrast-before-generalization`
- `story-to-concept-ladder`, `demonstrate-concept-before-naming-it`, and `concrete-process-before-taxonomy` → `concrete-experience-to-concept-ladder`
- `translate-commitment-into-lost-optionality`, `optionality-after-affordability`, `opportunity-cost-as-lost-trajectory`, `show-life-formula-behind-payment`, and `second-order-cost-over-monthly-price` → `trace-visible-cost-to-loss-of-agency`
- Redundant `concrete-cycle-before-generalization` on a case already carrying `walk-one-example-through-full-mechanism` was removed.

Neighboring choices such as `mechanism-before-claim`, `qualify-spectacular-number-as-illustrative`, `constraint-before-permission`, and `preserve-exceptions-in-agency-claims` were retained because they encode different boundaries or rhetorical operations.

No accepted decision file was deleted. Same-source cases that propose the same distilled preference remain distinct when their observed editorial choices differ; only one representative per source was counted in a promoted memory where repeated same-source evidence would inflate diversity.

## Principle changes

Five principles were promoted; none existed before this pass:

- `p_purpose-before-tool-optimization`: 4 counted cases / 4 sources, confidence 0.88
- `p_external-control-to-internal-agency`: 3 / 3, confidence 0.86
- `p_operationalize-ideal-with-selective-boundary`: 3 / 3, confidence 0.84
- `p_permission-with-present-boundaries`: 4 / 4, confidence 0.86
- `p_trace-visible-cost-to-loss-of-agency`: 5 / 5, confidence 0.89

No sub-threshold principle was promoted. No principle was retired, split, or weakened because the corpus previously had no canonical principle files.

## Style-pattern changes

Three style patterns were promoted; none existed before this pass:

- `sp_scale-contrast-before-generalization`: 5 cases / 5 sources, confidence 0.89
- `sp_concrete-experience-to-concept-ladder`: 4 / 4, confidence 0.88
- `sp_walk-one-example-through-full-mechanism`: 3 / 3, confidence 0.91

No sequence with fewer than three accepted cases from three distinct videos was promoted.

## Contradictions and retained boundaries

- Purpose-before-tool does not imply rejecting money, work, or mechanisms. Several cases preserve income and safety constraints; the principle is conditional on first identifying the actual goal.
- Agency is not total control. The promoted principle preserves structural barriers, power, luck, legal/ethical limits, and the risk of blaming people who lack exit resources.
- Permission and discipline coexist. The corpus supports present enjoyment or self-priority only inside explicit affordability, reciprocity, health, waste, budget, or safety boundaries; it does not supply one universal threshold.
- Operationalizing an ideal does not validate one implementation. Selective nonreaction, passion-as-observation, and joint/separate household finance are context-specific configurations, not interchangeable prescriptions.
- The experience-to-concept ladder is not a rigid story-first formula. One supporting case states a scoped personal definition before concrete stories and only then generalizes; the invariant is an explicit bridge between concrete evidence and abstraction.
- Scale contrasts can clarify a mechanism but can also overstate it. Spectacular numbers remain illustrative, and financial return examples remain unverified source assertions rather than forecasts.
- Cost-to-agency chains remain conditional. Salary dependence, mortgages, family dependence, and large purchases can reduce optionality through named mechanisms, but none guarantees loss of freedom.

## Extraction weaknesses and factual-risk notes

- All 229 decision cases are marked `human_validated: false`; consolidation confidence therefore reflects corpus evidence, not external human review.
- The absence of quarantined and rejected cases across a 229-case automated corpus may indicate generous extraction or scoring. This pass enforced the recorded 0.75 gate but did not re-mine transcripts.
- Candidate generation was highly fragmented (407 labels for 229 cases). The clear semantic duplicates were merged, but many singleton candidates remain intentionally sub-threshold rather than being forced into broad principles.
- Several financial cases contain high-risk source assertions, illustrative returns, unverified market sizes, or incomplete calculations. Distilled memories preserve their editorial use while explicitly withholding factual endorsement.
- Same-source repeated candidates were not counted as independent source support. Where multiple cases from one source expressed the same distilled preference, the promoted file uses a single representative.
- No QMD retrieval evaluation was performed, so cross-topic retrieval quality after these canonical changes remains pending.

## Validation

- 5 principle files and 3 pattern files parse as valid YAML-frontmatter Markdown.
- Every promoted memory has at least 3 supporting accepted cases from 3 distinct source IDs.
- Every supporting case exists; declared `support_count` and `source_count` match the files.
- All 458 candidate events reference an existing accepted case with the matching source ID.
- Candidate JSONL parses successfully and contains no duplicate case/source/slug event.
- All 30 manifest transcript hashes still match raw bytes.


## QMD indexing (2026-08-12T03:15:24Z)

- Collection: `hieutv`
- Topology: aggregate `store/` compatibility mode
- Embedding: completed incrementally
- Lexical smoke test: passed command gate
- Vector smoke test: passed command gate
