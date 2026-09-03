---
title: "Writer V2: Blind Study Planning and Claim Boundary"
status: approved
version: "1.1"
date: 2026-09-02
owners: [Product Owner, Writer Room Engineering]
---

# Solution Design Document

## Validation Checklist

### CRITICAL GATES (Must Pass)

- [x] All required design sections are complete.
- [x] No unresolved design placeholder remains.
- [x] The public state machine remains `STUDY -> WRITE -> GATE -> EDIT_REVIEW -> REPAIR`.
- [x] `DIVERGE`, `RESEARCH`, and `CONFRONT` are internal STUDY sub-calls, not new public phases or UI stages.
- [x] DIVERGE cannot see the source pack or ResearchMap; RESEARCH cannot see hypotheses, selected hook, General Pack, Formula, or Persona Pack.
- [x] Claim Boundary defines all five assertion kinds, exact-substring anchors, and the rule that a stance marker never overrides factual detection.
- [x] The independent Claim Boundary review is folded into the existing EDIT_REVIEW call, so the approved post-hook run has at most six model calls.
- [x] A committed RESEARCH checkpoint is reusable after interruption and is never repeated merely because a later sub-call failed.
- [x] All architecture decisions in this document have been confirmed by the owner.

### QUALITY CHECKS (Should Pass)

- [x] Research describes evidence and uncertainty without producing an outline.
- [x] Three hypotheses differ in thesis and belief shift, not wording alone.
- [x] Confrontation may keep, rebuild, or reject a hypothesis and may rewrite or reject the selected hook.
- [x] Formula, General Pack, and Persona Pack influence prose only after the evidence confrontation is complete.
- [x] Source quantity is not treated as source independence or truth.
- [x] Recovery, hash pinning, legacy-run compatibility, failure behavior, and minimum fixtures are specified.
- [x] Cost estimates are labelled as artifact-size estimates rather than billed-token telemetry.
- [x] Beat declarations control required planning metadata but never disable whole-script factual detection.
- [x] Factual paraphrase permission is bounded by code-derived selected claims and exact-quote specifics.

## Constraints

| ID | Constraint |
|---|---|
| CON-1 | The owner approved the full-fidelity STUDY design: exactly three planned sub-calls in order, `DIVERGE -> RESEARCH -> CONFRONT`. A two-call MVP is not the target. |
| CON-2 | `WriterRunV2.phase` and the visible UI state machine do not gain DIVERGE, RESEARCH, or CONFRONT values. While any of the three runs, the public phase is `STUDY`. |
| CON-3 | DIVERGE is source-blind. Its prompt, envelope, staged files, and CLI conversation may not contain the Topic Pack, ResearchMap, source IDs, source quotes, prior STUDY output, General Pack, Formula, or Persona Pack. |
| CON-4 | RESEARCH is hypothesis-blind. It may see the pinned title, brief, audience, Topic Pack, and source manifest, but not the selected hook, DIVERGE artifact, candidate hypotheses, General Pack, Formula, or Persona Pack. |
| CON-5 | CONFRONT sees only validated DIVERGE and RESEARCH artifacts, the selected hook, the planning contract, and an optional compact allowlist of approved Persona experience IDs. It does not receive the raw Topic Pack, General Pack, Formula, Persona prose, source quotes outside ResearchMap, or unapproved Persona entries. |
| CON-6 | DIVERGE, RESEARCH, CONFRONT, and the initial WRITE use fresh CLI context. Reusing the visible author terminal identity must not reuse conversation memory that breaks blindness or lets raw planning topology leak into prose. |
| CON-7 | DIVERGE returns three hypotheses, not three prose outlines. Each hypothesis uses a distinct provocation from `CONTRADICTION`, `ZOOM_IN`, `EXTREME_TEST`, and `INVERSION`; at least three of the four must be exercised. |
| CON-8 | RESEARCH uses a strict allowlist schema and cannot emit outline, hook, thesis, beat order, narration, intro, ending, or recommended story topology fields. |
| CON-9 | Research status means what the pack attests, not external truth. The allowed statuses are `ATTESTED`, `MULTI_SOURCE_ATTESTED`, `DISPUTED`, and `REJECTED`; the system must not relabel them “verified.” |
| CON-10 | Multiple videos count as independent support only when `SUPPORTS`/`QUALIFIES` evidence belongs to independently established origin groups. `CONTRADICTS` evidence never increases attestation strength; repetition inside one channel or shared upstream material is not independent corroboration. |
| CON-11 | CONFRONT is allowed to invalidate the writer's initial idea. A loop that can only patch evidence into the chosen hook is rejected as confirmation bias. |
| CON-12 | General Pack, Formula, and Persona prose remain WRITE inputs. They do not shape research collection or hypothesis generation. CONFRONT may receive only approved Persona experience IDs needed to validate a `PERSONA` beat; no stance/experience text crosses that boundary. |
| CON-13 | Every protected assertion in WRITE/REPAIR output is represented by a unique exact-substring `assertionAnchor`; metadata supplied by the writer is untrusted until validated. |
| CON-14 | Assertion kinds are exactly `FACT`, `COMMON_KNOWLEDGE`, `STANCE`, `HYPOTHETICAL`, and `PERSONA_EXPERIENCE`. A writer cannot create an additional exemption class. |
| CON-15 | A factual detector can never be disabled by “theo tôi,” “tôi tin,” “với tôi,” or another stance marker. A factual payload claimed as STANCE is evaluated as FACT or PERSONA_EXPERIENCE. |
| CON-16 | STANCE does not need a ResearchMap claim, but it must trace to an approved Persona Pack stance entry. PERSONA_EXPERIENCE must trace to an eligible experience archetype. An entry marked pending approval, rejected, or sharing a duplicate stable ID is ineligible. |
| CON-17 | Deterministic Claim Boundary rules are the minimum floor. An independent editor must also review empirical propositions that have no number or readily detected proper noun. |
| CON-18 | A semantic-only Claim Boundary failure cannot automatically become DONE after an unreviewed repair. Under the six-call ceiling it fails closed for human review. |
| CON-19 | The post-hook semantic call budget is five calls without REPAIR and six with REPAIR: three STUDY calls, WRITE, EDIT_REVIEW, and at most one REPAIR. No planning loop or second editor pass is added. |
| CON-20 | Every model dispatch that actually starts consumes the run budget, including a retry. Recovery must prefer a committed checkpoint, and automatic work stops before starting call seven. |
| CON-21 | Existing Topic Pack, General Pack, Formula, and hook hashes remain pinned. If an optional Persona Pack supplies the CONFRONT experience-ID allowlist or WRITE prose, its hash is pinned before CONFRONT and remains pinned through gate/review/repair. A checkpoint is reusable only when all inputs relevant to that checkpoint still match. |
| CON-22 | This delivery adds no live Google, Reddit, social, browser, external API, database, or search dependency. Future source types may enter through a separately validated Topic Pack contract. |
| CON-23 | DIVERGE, RESEARCH, and CONFRONT dispatch sequentially. They are not parallelized on the same Writer item/attempt because current lane write ownership and checkpoint ordering assume sequential stages. |
| CON-24 | Every final-plan beat declares exactly one kind: `FACTUAL`, `NARRATIVE`, or `PERSONA`. FACTUAL requires claim/evidence grounding; NARRATIVE requires neither; PERSONA requires one coordinator-approved Persona experience ID. |
| CON-25 | A declared beat kind is never factual permission. Assertion Boundary scans the entire final script independently of beat kinds; factual signals inside NARRATIVE or PERSONA prose still require an authorized claim and fail closed otherwise. |
| CON-26 | FACT prose may paraphrase an authorized `ResearchClaim.text`, but every protected specific in that prose must match a protected specific in one of that permission's exact selected evidence quotes. Paraphrase authorizes wording, never number/name drift. |
| CON-27 | Authorized claim permissions are derived by code only from CONFRONT-selected supporting/qualifying evidence. The writer, editor, and model output cannot add permission records, and the full set of non-rejected ResearchMap claims is never an authorization list. |
| CON-28 | For non-terminal hook KEEP/REWRITE, every `hookVerdict.claimId` belongs to the union of grounded FACTUAL beat claims. A terminal hook REJECT is exempt because it produces no plan. |
| CON-29 | Editor defects carry a machine-readable `kind` and `code`. Any `CLAIM_BOUNDARY` defect routes directly to `FAILED_GATE`; only `READING_EXPERIENCE` defects are eligible for the existing one-shot automatic repair. |

## Implementation Context

### Required Context Sources

#### Documentation Context

```yaml
- doc: docs/specs/002-writer-agent-mvp/solution-design.md
  relevance: HIGH
  why: "Defines the original Writer pipeline boundary, artifact-first behavior, and hard-gate posture."

- doc: docs/specs/003-external-writer-library-mcp/solution-design.md
  relevance: MEDIUM
  why: "Repository precedent for immutable references, bounded interfaces, fail-closed validation, and compatibility."

- doc: writer-room-data/writer/persona-pack.md
  relevance: CRITICAL
  why: "Defines the narrator stance registry, experience archetypes, forbidden borrowed identity, and approval markers used by ADR-004."
```

No external web documentation is required. This is an internal orchestration and validation change.

#### Code Context

```yaml
- file: packages/daemon/src/writer/writer-run-v2.ts
  relevance: CRITICAL
  why: "Current single-call STUDY implementation, public phase machine, prompts, settle listener, recovery, WRITE/EDIT_REVIEW/REPAIR envelopes, and DONE transition."

- file: packages/daemon/src/writer/deterministic-gate.ts
  relevance: CRITICAL
  why: "Current numeric, proper-noun, hypothetical, common-knowledge, ledger, beat-anchor, identity, and length checks; shared specific normalization may be exported, but the gate remains independent from Claim Boundary."

- file: packages/daemon/src/writer/run-store-v2.ts
  relevance: HIGH
  why: "Atomic persisted run state and legacy JSON compatibility for checkpoint metadata."

- file: packages/daemon/src/writer/persona-pack.ts
  relevance: HIGH
  why: "Current optional Persona Pack reader/hash boundary; approval-aware registry parsing must be added behind this boundary."

- file: packages/daemon/src/team/lane-scheduler.ts
  relevance: HIGH
  why: "Stage artifact layout, turn keys, input hashing, session groups, fresh context, and settle events used by all three sub-calls."

- file: packages/daemon/test/writer/writer-run-v2.test.ts
  relevance: CRITICAL
  why: "Primary orchestration, state transition, prompt/envelope, recovery, and call-count regression suite."

- file: packages/daemon/test/writer/deterministic-gate.test.ts
  relevance: CRITICAL
  why: "Primary fixture suite for deterministic assertion classification and factual-risk behavior."
```

### Implementation Boundaries

```text
Hook selected by human
        |
        v
+-------------------------- Writer V2 / public phase STUDY --------------------------+
| DIVERGE (hook, no source) ---> RESEARCH (source, no hook/hypotheses) ---> CONFRONT |
|          checkpoint D                 checkpoint R                   checkpoint C   |
+------------------------------------------------------------------------------------+
        | validated final StudyArtifact
        v
WRITE (permissions + General + Formula + optional Persona)
        |
        +--> Deterministic Gate -----+
        |                             +--> Combined typed gate
        +--> Assertion Boundary -----+            |
                                                   v
                                   independent typed EDIT_REVIEW
                                      |                     |
                                      | READING_EXPERIENCE  | CLAIM_BOUNDARY
                                      v                     v
                              one REPAIR -> re-gate      FAILED_GATE
                                      |
                                      v
                               DONE or FAILED_GATE
```

Inside scope:

- Internal STUDY orchestration, schemas, validation, checkpoint/resume, evidence mapping, assertion metadata, deterministic rules, editor contract, and tests.
- Additive persisted fields needed to recover the internal sub-call cursor and enforce the model-call budget.

Outside scope:

- New public phases, new UI stages, a Writer v3, a new database, source acquisition, live web research, automatic hook-generation loops, multiple repair rounds, or automatic persona approval.
- Human-moves A/B restyling, which remains outside the Writer pipeline.

### External Interfaces

No new public endpoint is required. Existing Writer V2 create/configure/run/continue/read routes retain their shapes and phase values. Responses may expose additive diagnostic checkpoint metadata, but clients must not need it to render the existing phase machine.

#### System Context Diagram

```text
Web/API client
    |
    | existing Writer V2 commands and WriterRunV2 response
    v
writer-run-v2.ts (thin coordinator)
    |-- story-planning.ts     DIVERGE + CONFRONT contracts
    |-- research-map.ts       RESEARCH contract and pack grounding
    |-- assertion-boundary.ts assertion classification and editor index
    |-- deterministic-gate.ts existing hard gate + deterministic floor
    |-- writer-hard-gate.ts   typed result combination and editor routing
    |-- LaneScheduler         immutable stage inputs/artifacts and fresh contexts
    `-- run-store-v2.ts       atomic public run + internal checkpoint cursor
```

#### Interface Specifications

| Interface | Compatibility rule |
|---|---|
| `POST .../runs/:id/run` | Still starts a run whose public phase becomes `STUDY`; internally dispatches DIVERGE first. |
| `POST .../runs/:id/continue` | Resumes from the newest valid checkpoint and does not rerun a committed RESEARCH artifact. It remains bounded by the six-call counter. |
| Writer run response | Existing `status`, `phase`, `study`, `draft`, gate results, and defects remain readable. New checkpoint fields are additive and optional for legacy data. |
| Lane settle events | Add three internal stage identifiers to the Writer V2 allowlist; no event is translated into a public phase. |

### Cross-Component Boundaries

- `writer-run-v2.ts` decides what runs next but does not implement schema parsing or assertion classification.
- `research-map.ts` may read/validate Topic Pack material but cannot construct prose order.
- `story-planning.ts` may compare hypotheses with a validated ResearchMap but cannot accept raw Topic Pack text.
- `assertion-boundary.ts` creates the deterministic classification floor and compact reviewer index; it does not decide narrative quality.
- `deterministic-gate.ts` remains pure, testable, and independent. It receives only its legacy gate input; the coordinator separately calls Assertion Boundary and hands both results to `writer-hard-gate.ts`.
- LaneScheduler owns immutable inputs, artifact hashes, stage isolation, and dispatch attempts. Run Store owns resumable cursor state.

### Project Commands

```bash
bun test packages/daemon/test/writer/writer-run-v2.test.ts packages/daemon/test/writer/deterministic-gate.test.ts
bun test packages/daemon
bun run typecheck
```

## Solution Strategy

The existing STUDY call has one model inspect the source topology and immediately turn that topology into an outline. Even when it covers every keyword and removes overlapping videos, the resulting article can inherit the source pack's category order and read like a compressed essay. The replacement separates invention, observation, and judgment:

1. DIVERGE creates three genuinely different belief journeys while blind to source structure.
2. RESEARCH creates an evidence map while blind to all proposed journeys.
3. CONFRONT forces each journey to survive contradiction, missing evidence, and falsifiers before producing one final outline.
4. WRITE applies the channel's craft and identity only after the evidence-shaped plan is settled.
5. Claim Boundary permits a narrator voice without turning “I think” into a factual escape hatch.

This is progressive alignment, not progressive source patching. Evidence can rebuild or reject the initial idea and hook; the system therefore gains human-like revision without pretending that source repetition equals lived truth.

This SDD supersedes the earlier MVP's monolithic STUDY call, all-beats-grounded planning assumption, and absence of an explicit stance/claim permission boundary. It preserves the existing Writer V2 public lifecycle and legacy facts ledger while adding typed internal artifacts; it does not overlap the Spy/source-acquisition designs.

## Building Block View

### Components

#### 1. Thin Writer Coordinator

`writer-run-v2.ts` retains lifecycle ownership. It selects the next internal STUDY sub-call, stages only allowed inputs, records call budget, commits validated results, derives the legacy `StudyArtifact`, and preserves the existing WRITE/GATE/EDIT_REVIEW/REPAIR transitions.

#### 2. Research Map

`research-map.ts` defines the RESEARCH prompt contract, strict allowlist parser, exact-quote/source-ID validation, independent-origin semantics, claim-specific provenance, code-derived claim permissions, size limits, and conversion from selected evidence to the legacy `factsLedger`.

#### 3. Story Planning

`story-planning.ts` defines DIVERGE candidates, the four provocations, meaningful-distinctness checks, CONFRONT deltas, verdicts, typed beats, hook-to-beat claim containment, evidence-to-beat mapping, and final plan validation.

#### 4. Assertion Boundary

`assertion-boundary.ts` defines the five assertion kinds, exact anchor validation, persona registry references, classification priority, deterministic findings, compact editor input, and semantic-boundary finding schema.

#### 5. Combined Hard-Gate Contract

`writer-hard-gate.ts` combines already-computed deterministic and Assertion Boundary results, validates typed editor defects, and selects `CLEAN`, `AUTO_REPAIR`, or `FAILED_GATE`. It imports the two result types; neither underlying validator imports it or the other validator in reverse.

#### 6. Independent Editor

The existing editor remains a different agent/session from the author. Its current reading-experience checklist gains a Claim Boundary section and a compact admissibility index. It still receives no raw Topic Pack, General Pack, Formula, or writer reasoning.

### Directory Map

```text
packages/daemon/src/writer/
├── writer-run-v2.ts          # MODIFY: thin coordinator, internal cursor, dispatch/settle/recovery
├── research-map.ts           # NEW: ResearchMap schema, validation, ledger derivation
├── story-planning.ts         # NEW: DIVERGE/CONFRONT schemas, prompts, validation
├── assertion-boundary.ts     # NEW: ADR-004 contract and deterministic boundary floor
├── writer-hard-gate.ts       # NEW: typed result combination, editor defect validation/routing
├── deterministic-gate.ts     # MODIFY: remain independent; export shared specific normalization only
├── persona-pack.ts           # MODIFY: stable IDs and approval/eligibility index
└── run-store-v2.ts           # MODIFY only for additive legacy defaults if required

packages/daemon/test/writer/
├── writer-run-v2.test.ts         # MODIFY: three-call flow, blindness, recovery, budget
├── deterministic-gate.test.ts    # MODIFY: assertion fixtures and priority
├── research-map.test.ts          # NEW: strict schema and exact grounding
├── story-planning.test.ts        # NEW: candidate/confront validation
├── assertion-boundary.test.ts    # NEW: permission/specific/whole-script fixtures
└── writer-hard-gate.test.ts      # NEW: typed editor defect and routing fixtures
```

No Writer v3 module or alternate public pipeline is introduced.

### Interface Specifications

#### DIVERGE artifact

```ts
type Provocation = 'CONTRADICTION' | 'ZOOM_IN' | 'EXTREME_TEST' | 'INVERSION';

interface StoryHypothesis {
  id: string;
  provocation: Provocation;
  thesisHypothesis: string;
  beliefBefore: string;
  beliefAfter: string;
  centralTension: string;
  hookDebt: string;
  beatQuestions: string[];
  evidenceNeeds: string[];
  falsifiers: string[];
  proposedPayoff: string;
}

interface DivergeArtifact {
  schemaVersion: 'writer-study-diverge-v1';
  hypotheses: [StoryHypothesis, StoryHypothesis, StoryHypothesis];
}
```

Validation rules:

- Exactly three hypotheses, with three distinct provocations.
- `thesisHypothesis`, `beliefBefore`, `beliefAfter`, and `centralTension` must be materially distinct across candidates after normalization; a wording-only variation is rejected.
- `evidenceNeeds` and `falsifiers` are questions/conditions, never asserted source facts.
- Source IDs, verbatim quotes, named source hosts, raw-pack fragments, outline section order, and fabricated statistics are prohibited.
- `CONTRADICTION` searches for a credible opposing truth; `ZOOM_IN` narrows to one consequential mechanism; `EXTREME_TEST` stress-tests the claim at a boundary case; `INVERSION` asks when the apparent lesson reverses.

#### ResearchMap artifact

```ts
type ResearchStatus =
  | 'ATTESTED'
  | 'MULTI_SOURCE_ATTESTED'
  | 'DISPUTED'
  | 'REJECTED';

interface ResearchSourceAudit {
  videoId: string;
  mainClaim: string;
  angle: string;
  originGroup: string;
  limitations: string[];
}

interface ResearchEvidence {
  id: string;
  claimId: string;
  videoId: string;
  quote: string;
  relation: 'SUPPORTS' | 'CONTRADICTS' | 'QUALIFIES';
}

interface ResearchClaim {
  id: string;
  text: string;
  status: ResearchStatus;
  evidenceIds: string[];
  independentOriginGroups: string[];
  caveats: string[];
}

interface ResearchMap {
  schemaVersion: 'writer-research-map-v1';
  sourceAudit: ResearchSourceAudit[];
  claims: ResearchClaim[];
  evidence: ResearchEvidence[];
  conflicts: Array<{ claimIds: string[]; explanation: string }>;
  openQuestions: string[];
  overusedAngles: string[];
}
```

The interface above is the **validated in-memory shape**. Raw RESEARCH model
output omits `ResearchSourceAudit.originGroup` and
`ResearchClaim.independentOriginGroups`; both keys are outside the raw schema
allowlist. After video/evidence references validate, application code hydrates
`originGroup` from coordinator-pinned provenance and derives each claim's
`independentOriginGroups` from its evidence. If code already knows an answer,
the model is not asked to repeat it merely so code can compare the repetition.

Validation rules:

- One `sourceAudit` entry per Topic Pack video ID and no unknown video ID.
- Every evidence quote is an exact substring of the pinned Topic Pack and its video association is valid.
- Every referenced claim/evidence ID resolves; rejected claims cannot enter the facts ledger.
- `MULTI_SOURCE_ATTESTED` requires positive (`SUPPORTS`/`QUALIFIES`) evidence from at least two distinct, nonempty `originGroup` values pinned by the coordinator. `CONTRADICTS` evidence is excluded from supporting-origin counts. The research agent may not emit either provenance field; their presence is `RESEARCH_SCHEMA`, even when the value happens to match.
- Any claim containing both positive and `CONTRADICTS` evidence is ineligible for `ATTESTED` or `MULTI_SOURCE_ATTESTED`; it must be `DISPUTED` or `REJECTED`. `DISPUTED` requires both evidence directions plus a nonempty claim caveat or top-level conflict payload, so the agent cannot choose the stronger label for the same evidence set.
- Every protected specific in `ResearchClaim.text` must resolve to the same canonical specific in at least one exact evidence quote owned by that claim. Protected specifics include money, measured percentages, ages, dated years, “N lần” multiples, and detected proper nouns. A claim containing an invented or drifted specific fails RESEARCH before it can become permission.
- Until a separately trusted provenance extension is wired, current pack paths conservatively pin every origin to `unknown`, so multi-source status cannot pass. This is a temporary safe fallback, not the final provenance design; neither model output nor repeated videos may upgrade it.
- The top-level and nested schemas use explicit allowlists. Keys or sections that encode hook, thesis, outline, beat order, intro, ending, narration, recommendation, or story spine are rejected.
- Serialized output is capped at 60 KiB. An oversize artifact fails with `RESEARCH_ARTIFACT_OVERSIZE`; the coordinator does not automatically repeat the raw-pack call merely to ask for compression.

#### CONFRONT artifact

```ts
type HypothesisVerdict = 'KEEP' | 'REBUILD' | 'REJECT';
type HookStatus = 'KEEP' | 'REWRITE' | 'REJECT';
type StoryBeatKind = 'FACTUAL' | 'NARRATIVE' | 'PERSONA';

interface ConfrontDelta {
  field: string;
  before: string;
  after: string;
  reason: string;
  claimIds: string[];
}

interface HypothesisAssessment {
  hypothesisId: string;
  verdict: HypothesisVerdict;
  supportClaimIds: string[];
  counterClaimIds: string[];
  falsifierHits: string[];
  unsupportedEvidenceNeeds: string[];
  deltas: ConfrontDelta[];
  rebuiltHypothesis?: StoryHypothesis;
}

interface HookVerdict {
  status: HookStatus;
  rationale: string;
  claimIds: string[];
  replacementHook?: SelectedHook;
}

interface StoryPlanBeat extends WriterVideoPlanBeat {
  kind: StoryBeatKind;
  personaEntryId?: string;
}

interface ConfrontArtifact {
  schemaVersion: 'writer-study-confront-v1';
  assessments: [HypothesisAssessment, HypothesisAssessment, HypothesisAssessment];
  selectedHypothesisId?: string;
  hookVerdict: HookVerdict;
  finalPlan?: Omit<WriterVideoPlan, 'progression'> & {
    progression: StoryPlanBeat[];
  };
  beatEvidence?: Array<{
    beatIndex: number;
    claimIds: string[];
    evidenceIds: string[];
  }>;
}

interface ConfrontValidationContext {
  divergeArtifact: DivergeArtifact;
  researchMap: ResearchMap;
  selectedHook: SelectedHook;
  approvedPersonaExperienceIds?: readonly string[];
}
```

Validation rules:

- All three candidate IDs are assessed once. Every claim/evidence reference resolves to the validated ResearchMap.
- KEEP requires enough non-rejected support and no hit on a declared falsifier.
- REBUILD requires explicit before/after deltas and a rebuilt belief shift; it is not a synonym for minor wording edits.
- REJECT cannot be selected. At least one KEEP/REBUILD candidate is required to proceed.
- `hookVerdict.status=REWRITE` requires a valid replacement hook and evidence-linked reason. It may tighten grounding while preserving the human-selected promise; a materially different promise is `REJECT` and requires human choice. `REJECT` produces no final plan and fails STUDY with `HOOK_REVIEW_REQUIRED`; it does not trigger an automatic hook loop.
- FACTUAL beats have exactly one `beatEvidence` mapping with non-rejected claim IDs and supporting/qualifying evidence IDs. NARRATIVE beats have no `beatEvidence` and no Persona ID. PERSONA beats have no `beatEvidence` and require one ID from the coordinator-pinned approved Persona experience allowlist.
- Beat kind controls required planning metadata only. It is not passed to Assertion Boundary as an exemption and never suppresses whole-script factual scanning.
- For hook KEEP/REWRITE, `hookVerdict.claimIds` must be a subset of the union of grounded FACTUAL beat claim IDs. Hook REJECT remains the terminal no-plan exception.
- The application, not the model, derives the legacy `factsLedger` and `AuthorizedClaimPermission[]` from selected FACTUAL evidence records. The existing minimum of three unique ledger entries remains until separately changed by the owner.
- A DISPUTED claim may be selected only when the plan preserves its conflict/caveat; an uncaveated beat is rejected. Planning and Claim Boundary use one deliberately narrow caveat-marker registry and the same acceptance/rejection fixtures; vocabulary expansion is a contract change. Ledger derivation must retain at least the existing minimum of three grounded entries.
- Serialized DIVERGE and CONFRONT outputs are capped at 16 KiB and 32 KiB respectively.

#### Authorized claim permission

```ts
interface AuthorizedClaimPermission {
  claimId: string;
  text: string;
  status: Exclude<ResearchStatus, 'REJECTED'>;
  caveats: string[];
  evidenceIds: string[];
  quotes: string[];
}
```

The permission list is a code-derived capability object, not model output. For each claim selected by a FACTUAL beat, it contains only that claim's selected supporting/qualifying evidence IDs and their exact quotes. The identical immutable list is staged for WRITE, supplied to Assertion Boundary, and projected into the independent editor index. Unselected ResearchMap claims confer no permission. The legacy `factsLedger` remains in parallel for the old gate until coordinator migration is complete.

#### Checkpoint metadata

```ts
type InternalStudyStage =
  | 'study-diverge-v1'
  | 'study-research-v1'
  | 'study-confront-v1';

interface StudyCheckpoint {
  stage: InternalStudyStage;
  artifactHash: string;
  inputHashes: string[];
  promptVersion: string;
  attempt: number;
  committedAt: string;
}

interface StudyPlanningState {
  schemaVersion: 'writer-study-planning-v1';
  diverge?: StudyCheckpoint;
  research?: StudyCheckpoint;
  confront?: StudyCheckpoint;
  modelCallsStarted: number;
}
```

The internal state is additive. Legacy runs without it use the existing single-STUDY recovery path; new runs require it.

#### Assertion contract (ADR-004)

```ts
type AssertionKind =
  | 'FACT'
  | 'COMMON_KNOWLEDGE'
  | 'STANCE'
  | 'HYPOTHETICAL'
  | 'PERSONA_EXPERIENCE';

interface AssertionAnchor {
  id: string;
  quote: string;
  kind: AssertionKind;
  claimIds?: string[];
  stanceId?: string;
  personaEntryId?: string;
}

interface AssertionBoundaryInput {
  script: string;
  assertionAnchors: unknown;
  permissions: readonly AuthorizedClaimPermission[];
  personaRegistry?: PersonaRegistry;
  pinnedPersonaPackHash?: string;
}
```

Anchor rules:

- `quote` is copied verbatim from the final script and must identify exactly one occurrence. If a short phrase repeats, the writer expands the quote until it is unique.
- Anchors are minimal complete assertions, are ordered by script position, and may not partially overlap. Exact duplicates are rejected.
- The gate scans the entire script independently of the supplied anchors. Every detected protected assertion must be fully covered by one anchor; a missing anchor fails as `ASSERTION_UNANCHORED`. The independent reviewer performs the same completeness check for semantic empirical claims.
- FACT requires at least one ID in the code-derived `AuthorizedClaimPermission[]`; an arbitrary non-rejected ResearchMap claim is insufficient. The prose may paraphrase the authorized `text`, but each protected specific in the anchored prose must canonically match one in the exact selected `quotes` of its cited permissions. If the claim is DISPUTED, the anchored prose must also preserve its conflict/caveat.
- COMMON_KNOWLEDGE has no claim ID but must pass the bounded existing common-knowledge rules. Money, age, year, study attribution, named-case detail, measured percentage, and “N times” comparisons are never exempt by this kind.
- STANCE requires an eligible `stanceId` and is limited to preference, value judgment, or policy choice owned by the narrator. It cannot carry a descriptive statistic, named case, study result, empirical generalization, or hidden biography. A clearly normative personal threshold may contain a number only when the same number/unit and policy are explicitly present in the approved stance entry; this never authorizes a descriptive prevalence or outcome claim.
- HYPOTHETICAL requires a visible hypothetical marker in the anchored prose, anonymous actors, prospective/modal framing, and no implied past testimony or source attribution.
- PERSONA_EXPERIENCE requires an eligible `personaEntryId`, the pinned Persona Pack hash, and compliance with that archetype's forbidden-detail/required-guardrail notes. Source-pack testimony may not be transformed into first-person experience.
- `stanceId` and `personaEntryId` use stable IDs derived from the registry heading, such as `stance-1.4` and `experience-A3`. Text marked pending approval is not eligible. If an ID appears more than once, the colliding ID is rejected everywhere: WRITE permission, deterministic validation, and the editor index.

Classification priority is fail-closed:

1. Detect first-person past/biographical testimony; classify it as PERSONA_EXPERIENCE unless it is removed.
2. Detect source-like factual payload: descriptive numbers in protected categories, named entities/cases/studies, attribution, causal or comparative empirical propositions, and ResearchMap-like claims.
3. A visibly hypothetical, anonymous, prospective statement may be HYPOTHETICAL; the marker cannot legalize named testimony or a disguised source assertion.
4. A bounded whitelist may classify ordinary convention as COMMON_KNOWLEDGE.
5. Only after the prior detectors do not fire may an evaluative sentence be STANCE. The one numeric exception is an exact approved normative threshold described above; it is checked against the Persona Pack, not inferred from a stance prefix.

Therefore “Theo tôi, 70%...” is FACT, never STANCE. The writer-declared kind does not override the effective kind computed by the gate/reviewer.

Specific matching is deliberately stricter than semantic paraphrase. VND spelling may normalize to the same amount (`800 triệu` and `0,8 tỷ`), but a nearby amount does not. Given exact evidence `năm ngoái tôi lỗ gần 800 triệu`, `có người lỗ gần 800 triệu chỉ trong một năm` may pass, while `có người mất gần một tỷ chỉ trong một năm` fails `ASSERTION_SPECIFIC_UNAUTHORIZED`. The phrase “một năm” in this fixture paraphrases “năm ngoái”; it does not authorize money drift.

#### Typed editor and combined gate contract

```ts
type EditorDefectKind = 'READING_EXPERIENCE' | 'CLAIM_BOUNDARY';

type ReadingExperienceDefectCode =
  | 'MEMORY_ANCHOR_WEAK'
  | 'PROGRESSION_FLAT'
  | 'STRUCTURE_SWAPPABLE'
  | 'HOOK_PAYOFF_MISSED'
  | 'ENDING_DECAY'
  | 'PACING'
  | 'PROSE_DRY'
  | 'CLARITY';

type ClaimBoundaryDefectCode =
  | 'EMPIRICAL_CLAIM_UNAUTHORIZED'
  | 'SPECIFIC_DRIFT'
  | 'DISPUTED_UNQUALIFIED'
  | 'PERSONA_UNAUTHORIZED'
  | 'ASSERTION_UNANCHORED'
  | 'SOURCE_MISREPRESENTED'
  | 'ARITHMETIC_ERROR';

interface EditorDefectBase {
  quote: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  note: string;
}

type EditorDefect = EditorDefectBase & (
  | { kind: 'READING_EXPERIENCE'; code: ReadingExperienceDefectCode }
  | { kind: 'CLAIM_BOUNDARY'; code: ClaimBoundaryDefectCode }
);

interface CombinedWriterGateResult {
  passed: boolean;
  deterministic: GateResult;
  claimBoundary: AssertionBoundaryResult;
  violations: Array<
    | { source: 'DETERMINISTIC'; code: GateViolationCode; detail: string; quote?: string }
    | { source: 'CLAIM_BOUNDARY'; code: AssertionBoundaryViolationCode; detail: string; quote?: string }
  >;
}
```

Editor codes use disjoint allowlists per kind. Reading-experience codes cover memory, progression, structure, payoff, ending, pacing, and prose clarity. Claim-boundary codes cover unauthorized empirical claims, specific drift, disputed-claim qualification, Persona provenance, assertion completeness, source misrepresentation, and arithmetic. The parser rejects a code paired with the wrong kind. Routing is deterministic: no defects plus a clean combined gate is `CLEAN`; a failed code-computed gate or reading defect is eligible for the existing one-shot `AUTO_REPAIR`, after which both code validators run again; any editor-declared `CLAIM_BOUNDARY` defect is `FAILED_GATE` immediately because no second semantic review fits the six-call ceiling. `deterministic-gate.ts` remains unaware of Assertion Boundary; the coordinator invokes both validators and gives their results to the combiner.

#### Data Storage Changes

LaneScheduler keeps immutable stage inputs and committed result artifacts under the existing layout:

```text
workspaces/pipeline/{runId}/piece/
└── attempts/{attempt}/
    ├── study-diverge-v1/
    ├── study-research-v1/
    └── study-confront-v1/
```

The run JSON stores only checkpoint pointers/hashes, the model-call counter, and the final derived `StudyArtifact`. It does not duplicate the raw Topic Pack or entire intermediate artifacts. Writes remain atomic through Run Store.

ResearchMap and checkpoint artifacts remain under `workspaces/pipeline`; they are not written into `writer-room-data/`, whose repository ignore rules can silently omit newly generated files. Any future load-bearing General/Persona/Style source artifact intentionally added under `writer-room-data/` requires an explicit tracking check during delivery.

#### Internal API Changes

Recommended pure functions:

```ts
validateDivergeArtifact(value: unknown): ValidationResult<DivergeArtifact>
validateResearchMap(value: unknown, pinnedPack: WriterPack): ValidationResult<ResearchMap>
validateConfrontArtifact(
  value: unknown,
  diverge: DivergeArtifact,
  research: ResearchMap,
): ValidationResult<ConfrontArtifact>
deriveAuthorizedClaimPermissions(
  research: ResearchMap,
  selectedEvidenceIds: readonly string[],
): ValidationResult<AuthorizedClaimPermission[]>
deriveStudyArtifact(research: ResearchMap, confront: ConfrontArtifact): StudyArtifact
nextStudyAction(run: WriterRunV2, artifacts: ArtifactReader): StudyAction
validateAssertionBoundary(input: AssertionBoundaryInput): AssertionBoundaryResult
buildClaimBoundaryReviewIndex(input: BoundaryIndexInput): BoundaryReviewIndex
combineWriterGateResults(
  deterministic: GateResult,
  claimBoundary: AssertionBoundaryResult,
): CombinedWriterGateResult
validateTypedEditorReview(value: unknown, script: string): EditorReviewValidationResult
routeEditorOutcome(gate: CombinedWriterGateResult, defects: readonly EditorDefect[]): EditorRoute
```

All validators are deterministic, side-effect free, and directly unit-tested. Dispatch functions receive already validated/pinned inputs.

#### Application Data Models

The final `StudyArtifact` preserves the existing downstream contract:

```ts
interface StudyArtifact {
  coverageMap: CoverageEntry[];
  gap: string;
  outline: WriterVideoPlan;
  factsLedger: LedgerEntry[];
  /** Required for new planning runs; absent only on readable legacy artifacts. */
  authorizedClaims?: AuthorizedClaimPermission[];
  planning?: {
    schemaVersion: 'writer-study-planning-v1';
    selectedHypothesisId: string;
    hookVerdict: HookVerdict;
    effectiveHook: SelectedHook;
    researchArtifactHash: string;
    confrontArtifactHash: string;
  };
}
```

`coverageMap` is derived from `ResearchMap.sourceAudit`; `gap` is derived from the selected/rebuilt central tension; `outline` comes from validated CONFRONT; and both `factsLedger` and `authorizedClaims` are mechanically derived from selected FACTUAL evidence. `effectiveHook` equals the human selection on KEEP and the validated replacement on REWRITE; the original `run.selectedHook` remains available for audit. Existing persisted runs without `authorizedClaims` remain readable but cannot be silently certified under the new Claim Boundary.

WRITE and REPAIR draft artifacts add required `assertionAnchors`. Legacy completed drafts remain readable but are not silently re-certified under ADR-004.

#### Integration Points

- The settle listener accepts all three internal STUDY stage IDs and commits one checkpoint per valid artifact.
- WRITE starts with `freshContext=true` and receives the final plan, `effectiveHook`, the code-derived `authorizedClaims`, General Pack, Formula contract/content as currently applicable, and optional pinned Persona Pack. It does not receive raw ResearchMap topology or CONFRONT conversation memory.
- The coordinator calls the legacy deterministic gate and Assertion Boundary independently, then combines their typed results. Assertion Boundary receives `authorizedClaims`, never the whole ResearchMap. Beat kinds do not alter either scan.
- EDIT_REVIEW receives the script, outline, effective hook, writer assertion anchors, combined findings, and a compact projection of the same authorized claim/stance/experience records. It receives no raw source files.
- REPAIR may receive precise code-computed gate violations and `READING_EXPERIENCE` defects; both code validators run again afterward. Any editor-declared `CLAIM_BOUNDARY` defect bypasses automatic repair and ends as `FAILED_GATE` with exact quote and required classification/source/persona repair.

### Implementation Examples

Valid narrator stance:

```json
{
  "id": "a-stance-1",
  "quote": "Với tôi, giữ quyền đổi ý quan trọng hơn tối đa hóa lợi nhuận.",
  "kind": "STANCE",
  "stanceId": "stance-1.4"
}
```

Invalid factual payload disguised as stance:

```json
{
  "id": "a-bad-1",
  "quote": "Theo tôi, 70% người Việt không có quỹ dự phòng.",
  "kind": "STANCE",
  "stanceId": "stance-1.1"
}
```

The effective kind is FACT. Without a claim ID present in the code-derived permission list, the gate rejects it.

## Runtime View

### Primary Flow

```text
1. Human selects a hook and starts Writer V2.
2. Coordinator pins title/brief/audience/hook/pack/general/formula/persona hashes,
   sets status RUNNING + phase STUDY, and checks call budget.
3. DIVERGE launches with freshContext=true and no source/craft/persona files.
4. Validator commits checkpoint D.
5. RESEARCH launches with freshContext=true, Topic Pack files, and no hook/hypotheses.
6. Validator grounds quotes/statuses, then commits checkpoint R.
7. CONFRONT launches with freshContext=true using D + R + selected hook and, when available, approved Persona experience IDs; it receives no raw pack or Persona prose.
8. Validator enforces typed beats and hook-claim containment, commits checkpoint C,
   then derives legacy factsLedger plus AuthorizedClaimPermission[] from FACTUAL evidence.
9. Public phase advances to WRITE; a fresh context receives final plan, permissions,
   and craft/persona inputs.
10. WRITE emits script plus assertionAnchors.
11. Coordinator runs the legacy deterministic gate and whole-script Assertion Boundary,
    then combines both typed results without either validator importing the other.
12. EDIT_REVIEW independently checks experience, story quality, arithmetic, and
    semantic Claim Boundary using the compact permission index.
13a. Clean combined gate + no defect: DONE.
13b. Failed combined gate or READING_EXPERIENCE defect: one REPAIR, then rerun both
     deterministic validators; DONE requires the repaired combined gate to pass.
13c. Any editor-declared CLAIM_BOUNDARY defect: FAILED_GATE with exact repair notes;
     no unreviewed automatic repair is allowed to become DONE.
```

### Checkpoint and Resume Flow

On start or `continue`, the coordinator validates checkpoint input hashes, artifact hashes, prompt versions, and pinned inputs before choosing one action:

| Newest valid state | Resume action |
|---|---|
| Valid CONFRONT artifact, final StudyArtifact not persisted | Re-derive StudyArtifact locally; do not call a model; advance to WRITE if budget permits. |
| Valid DIVERGE + RESEARCH | Dispatch CONFRONT only. |
| Valid DIVERGE only | Dispatch RESEARCH only. |
| Valid RESEARCH only | Dispatch DIVERGE, then CONFRONT; never rerun RESEARCH. This covers a crash window where run JSON lost D but immutable R survived. |
| No valid checkpoint | Dispatch DIVERGE. |
| Artifact exists but hash/input pin is invalid | Fail closed with `STUDY_CHECKPOINT_INVALID`; do not guess or silently rerun raw source. |

Crash windows are handled as follows:

- Artifact committed but run JSON not updated: scan the existing committed stage artifact, verify its ledger hash, then reconstruct checkpoint metadata.
- Run JSON updated but next dispatch not started: dispatch only the next missing stage.
- Turn interrupted without a committed artifact: retry that sub-call only if starting it does not exceed the six-call counter.
- RESEARCH committed and CONFRONT failed: reuse RESEARCH exactly; no raw-pack model call repeats.
- `hookVerdict=REJECT`: end with `HOOK_REVIEW_REQUIRED`. A human-selected replacement hook starts a new run; no automatic rewrite loop consumes the remaining budget. Cross-run ResearchMap reuse is not required in this delivery.

Every actual model launch increments `modelCallsStarted` before dispatch. A crash between increment and launch may conservatively consume a slot; cost safety wins over an accidental seventh call.

### Error Handling

| Error | Result | Repair note |
|---|---|---|
| Blindness envelope contains a forbidden field/file | `FAILED` before dispatch | Name the field/file and sub-call contract. |
| Invalid/missing exact source quote | RESEARCH artifact rejected | Identify evidence ID, video ID, and unmatched quote. |
| Claimed independent support shares one origin group | RESEARCH artifact rejected/downgraded | List the colliding evidence IDs/origin group. |
| Claim text contains a number/name absent from its own exact evidence | RESEARCH artifact rejected | Quote the drifted specific and the claim/evidence IDs that failed to authorize it. |
| Hypotheses differ only in wording | DIVERGE artifact rejected | Name normalized duplicate fields and required provocation change. |
| No hypothesis survives CONFRONT | Existing `FAILED` terminal handling | Return each verdict/falsifier and request a new human hook/brief decision. |
| NARRATIVE/PERSONA beat carries factual grounding metadata, or FACTUAL beat lacks it | CONFRONT artifact rejected | Name beat index, declared kind, and required/forbidden fields. |
| PERSONA beat cites a missing/pending/rejected ID | CONFRONT artifact rejected | Name beat index and require an approved experience ID or a different beat kind. |
| Hook KEEP/REWRITE cites a claim absent from grounded FACTUAL beats | CONFRONT artifact rejected | Name the orphan hook claim and require a supporting beat or terminal REJECT. |
| Hook rejected by evidence | `HOOK_REVIEW_REQUIRED` | Give evidence-linked reason; do not silently preserve the hook. |
| Checkpoint tampering/hash mismatch | `STUDY_CHECKPOINT_INVALID` | Name stage, expected hash, and actual hash. |
| Call seven would start | `MODEL_CALL_BUDGET_EXHAUSTED` | Show calls consumed by stage/attempt; require human action. |
| STANCE contains protected factual payload | `FAILED_GATE` | Quote exact prose, effective kind FACT, and missing claim ID. |
| FACT paraphrase changes a protected number/name | `FAILED_GATE` | Quote the drifted specific and the selected exact evidence quotes; preserve the source specific or remove it. |
| Persona experience lacks eligible ID | `FAILED_GATE` | Quote exact prose and require removal or an approved Persona Pack entry. |
| Independent reviewer emits `CLAIM_BOUNDARY` defect | `FAILED_GATE` | Preserve typed code/quote/note; do not route through unreviewed automatic repair. |

### Complex Logic

#### Meaningful candidate distinctness

Normalization removes punctuation, stop phrases, and provocation labels, then compares the core thesis/belief transition tokens. Deterministic similarity is a floor, not semantic proof: the DIVERGE prompt must also explain why each candidate changes what the viewer believed before and after. Identical belief shifts with different examples fail.

#### Facts ledger derivation

The model never writes arbitrary ledger quotes after CONFRONT. For each selected beat evidence ID, code resolves the validated ResearchEvidence, ResearchClaim, and source video; rejected claims are excluded; duplicate evidence is collapsed by `(videoId, exact quote)` regardless of how many agent-authored claim IDs reuse it. Claim/evidence authorization remains separate from the legacy ledger and must not inflate evidence breadth by duplicating the same transcript substring. This closes the current path where an agent can invent several fact labels around one real quote and satisfy the ledger minimum.

#### Claim permission and protected specifics

Research validation canonicalizes protected specifics in every `claim.text` and checks them against only that claim's exact evidence quotes. Money is compared by canonical amount/unit, so spelling changes do not create drift; names are normalized without granting fuzzy entity substitution. This is the root invariant that makes claim-text paraphrase usable.

After CONFRONT, code groups only selected FACTUAL supporting/qualifying evidence by claim and emits `AuthorizedClaimPermission[]`. Assertion Boundary checks cited IDs against that list and checks each protected script specific against the permission's selected exact quotes. Claim text authorizes the proposition's wording; quotes authorize its concrete specifics. The editor receives the same records to assess semantic drift that deterministic comparison cannot decide.

#### Beat declaration is not authority

Typed beats make planning less essay-like: a transition, question, or rhythm beat need not invent claim IDs merely to satisfy a topology quota. The trade-off is an intentionally independent final scan. No branch in deterministic gate or Assertion Boundary reads a NARRATIVE declaration as permission to skip prose; if factual signals appear, the normal FACT rules fire. PERSONA IDs similarly prove only approved narrator material and cannot authorize external facts embedded inside that prose.

#### Effective assertion kind

The writer's `kind` is a claim, not authority. Deterministic signals may raise STANCE/COMMON_KNOWLEDGE to FACT or PERSONA_EXPERIENCE. The independent reviewer handles propositions such as “bất động sản luôn an toàn hơn cổ phiếu,” which can be empirical without a number or detected proper noun. No layer can downgrade a factual detector merely because the sentence begins with a personal-opinion marker.

## Deployment View

This is an in-process daemon change using existing filesystem artifacts and LaneScheduler. It requires no new service, database migration, port, secret, network permission, or deployment topology.

### Single Application Deployment

- **Environment:** existing local Writer Room daemon and filesystem workspace.
- **Configuration:** no new environment variable or secret.
- **Dependencies:** existing LaneScheduler, Run Store, Writer packs, and configured author/editor agents.
- **Performance:** one raw-pack model input per planned run; intermediate artifacts use the specified byte caps.

### Multi-Component Coordination

Rollout order:

1. Land Persona Pack support and its optional file without enabling unbounded stance permission.
2. Land origin/status, quote dedupe, duplicate-Persona, and shared-caveat fail-closed fixes.
3. Land claim-text specific provenance before any claim becomes paraphrase permission.
4. Land code-derived permissions, typed beats, hook-to-beat containment, and typed editor/combined-result contracts behind pure tests.
5. Only after those contracts pass, wire the thin coordinator and checkpoint recovery in `writer-run-v2.ts` under a separate approval gate.
6. Switch new Writer V2 runs to the internal three-call STUDY flow while preserving read/recovery behavior for existing single-STUDY runs.

Prompt versions and internal stage IDs are bumped once for this design. The discarded lateral-gap STUDY prompt is not shipped separately; its four provocations live in DIVERGE.

## Cross-Cutting Concepts

### Pattern Documentation

- **Artifact before transition:** a phase/cursor advances only after validating and hash-checking the committed result.
- **Least-context prompt:** each sub-call receives only the context its epistemic role requires.
- **Fail closed:** unknown fields, unresolved IDs, pending persona entries, and ambiguous assertion anchors do not become permissive defaults.
- **Deterministic floor + independent semantic review:** code covers machine-detectable risk; a separate editor covers meaning the floor cannot reliably infer.
- **Compatibility adapter:** the new research/planning artifacts derive the legacy StudyArtifact instead of forcing WRITE/UI to understand internal topology.

### User Interface & UX

- UI continues to show STUDY while all three sub-calls run.
- Optional diagnostic copy may show “đang phát triển giả thuyết,” “đang lập bản đồ nguồn,” or “đang đối chiếu,” but these are labels, not public states and are not required for initial delivery.
- A hook rejection or semantic Claim Boundary failure must present an evidence-linked, exact-quote repair note rather than a generic agent failure.
- Recovery is idempotent; clicking Continue must not visibly restart raw source study after RESEARCH has committed.

### System-Wide Patterns

- **Observability:** record stage, attempt, artifact/input hashes, bytes in/out, elapsed time, call counter, and resume decision. Token/cost fields are reported only when real provider telemetry exists.
- **Privacy/identity:** source hosts never become the narrator; Persona Pack entry IDs cannot authorize forbidden original-host identity or detail.
- **Performance:** raw Topic Pack is presented to exactly one planned model call. Intermediate byte caps prevent CONFRONT and editor inputs from regrowing to pack size.
- **Determinism:** validators, hash pinning, ledger derivation, call budget, and checkpoint selection are pure/replayable.
- **Security:** stage paths and artifact IDs are coordinator-generated; model output cannot select arbitrary filesystem paths.

### Multi-Component Patterns

- Stage ID allowlists, settle handling, recovery scanners, prompt versions, and tests change together.
- Persona stable IDs/eligibility use one parser shared by WRITE envelope, deterministic gate, and editor index.
- Claim/evidence IDs use one ResearchMap validator shared by CONFRONT, ledger derivation, WRITE anchors, and editor index.
- DISPUTED caveat markers use one narrow predicate and one shared fixture registry across story planning and Claim Boundary.
- Authorized claims are derived once from selected FACTUAL evidence and projected unchanged into WRITE, Assertion Boundary, and editor inputs.
- Dependency direction is coordinator/combiner → deterministic gate + Assertion Boundary. `deterministic-gate.ts` never imports `assertion-boundary.ts` or the combiner.
- Existing `DONE` invariant remains: only a passed latest deterministic gate and a clean independent review can finish automatically.

## Architecture Decisions

### ADR-001: Preserve the public pipeline; split STUDY internally

- **Status:** Accepted
- **Decision:** Keep Writer V2 and its public phases. Implement three internal stage IDs under STUDY.
- **Reason:** Full epistemic separation is needed without adding UI/state-machine migration cost or maintaining a competing v3.
- **Rejected alternatives:** One monolithic STUDY call; five or six planning calls; new public planning phases.

### ADR-002: Enforce two-way blindness with inputs and fresh context

- **Status:** Accepted
- **Decision:** DIVERGE is source-blind; RESEARCH is hook/hypothesis-blind; every sub-call starts a clean CLI context.
- **Reason:** Removing a file from the envelope is insufficient if the persistent terminal conversation can leak it.
- **Rejected alternatives:** Prompt-only instruction to “ignore” visible context; hypothesis generation after research.

### ADR-003: Generate hypotheses with four provocations, not three finished outlines

- **Status:** Accepted
- **Decision:** Produce three belief-journey hypotheses using at least three distinct provocations: contradiction, zoom-in, extreme test, inversion.
- **Reason:** Three source-blind finished outlines create premature commitment and triple output cost. Hypotheses preserve divergence while leaving evidence free to rebuild topology.
- **Rejected alternatives:** Three wording variants; three full essays/outlines; shipping lateral-gap inside the old STUDY prompt.

### ADR-004: Separate narrator stance from factual claims

- **Status:** Accepted
- **Decision:** Use the five-kind assertion contract, exact-substring anchors, code-derived authorized claims, persona references, deterministic floor, and independent reviewer. Factual detection has priority over stance and beat-kind declarations.
- **Reason:** Narrator voice needs room for values and interpretation, but “theo tôi” must not become a bypass for statistics, empirical comparisons, named cases, or invented biography.
- **Rejected alternatives:** Require every sentence to have a source claim; allow all first-person statements without ledger; rely only on the writer's declared kind; rely only on regex.

### ADR-005: Fold Claim Boundary into EDIT_REVIEW and fail semantic defects closed

- **Status:** Accepted
- **Decision:** The independent editor performs both reader-quality and semantic-boundary review in one call. Its defects carry a typed discriminator/code; every `CLAIM_BOUNDARY` defect goes to human `FAILED_GATE`, not an unreviewed automatic repair.
- **Reason:** A second post-repair semantic review would be call seven. Auto-passing a semantic rewrite without that review would weaken the hard gate.
- **Rejected alternatives:** Separate Claim Boundary call; seventh verification call; automatic DONE after a semantic boundary repair checked only by regex.

### ADR-006: Commit immutable sub-call checkpoints and resume forward

- **Status:** Accepted
- **Decision:** Commit D, R, and C artifacts independently with hashes/input pins. Resume from the newest compatible artifact; never repeat a valid raw-pack RESEARCH call.
- **Reason:** RESEARCH is the largest input and is independent of the hook/hypotheses by design.
- **Rejected alternatives:** Persist only final StudyArtifact; rerun all three calls after any interruption; trust run JSON without artifact verification.

### ADR-007: Use attestation and origin groups, not truth labels

- **Status:** Accepted
- **Decision:** Research records what sources attest, conflict about, or reject. Multi-source strength requires distinct coordinator-pinned origin groups among positive evidence only; contradictory evidence forces a disputed/rejected status.
- **Reason:** A video pack can be internally repetitive or wrong. “Verified” would overstate what the pipeline knows.
- **Rejected alternatives:** Majority vote by video count; treat channel repetition as independent confirmation; automatic live web verification in this scope.

### ADR-008: Apply craft and persona after evidence planning

- **Status:** Accepted
- **Decision:** General Pack, Formula, and Persona prose remain WRITE-only inputs; a compact allowlist of approved Persona experience IDs may enter CONFRONT solely to validate PERSONA beats, and the full eligibility index feeds the later gate/editor.
- **Reason:** Research should map reality and uncertainty, not search for evidence that fits a preferred formula or borrowed storytelling voice.
- **Rejected alternatives:** Show General/Formula to DIVERGE or RESEARCH; use source experiences as narrator biography.

### ADR-009: Type beats without treating declarations as authority

- **Status:** Accepted
- **Decision:** Final-plan beats are FACTUAL, NARRATIVE, or PERSONA. Only FACTUAL beats need claim/evidence mapping; PERSONA needs an approved experience ID. The final script is always scanned independently of those declarations.
- **Reason:** Forcing evidence onto transitions and rhythm beats recreates source-backed essay topology. Trusting the model's kind would create a trivial bypass, so kind changes planning obligations but not factual permission.
- **Rejected alternatives:** Ground every beat; let NARRATIVE bypass Claim Boundary; infer beat kind after prose without an explicit planning contract.

### ADR-010: Permit claim-text paraphrase while pinning exact specifics

- **Status:** Accepted
- **Decision:** FACT wording may paraphrase `ResearchClaim.text`. Every protected specific in claim text must first trace to that claim's evidence, and every protected specific in final prose must trace to the cited permission's selected exact quotes.
- **Reason:** Exact-quote-only prose reads copied and rigid, while unconstrained semantic paraphrase permits number/name drift. Two-stage specific validation preserves natural language without widening factual detail.
- **Rejected alternatives:** Exact-quote-only authorization; fuzzy numeric equivalence; treat a nearby rounded amount as the same fact; trust claim text without validating its specifics.

### ADR-011: Derive capabilities and hook support from factual beats

- **Status:** Accepted
- **Decision:** Code derives `AuthorizedClaimPermission[]` from selected FACTUAL evidence, and non-terminal hook claim IDs must be a subset of grounded FACTUAL beat claims.
- **Reason:** A model-authored permission list or all non-rejected claims would silently expand authority. Hook containment keeps the opening promise attached to a beat that actually carries evidence without adding a second hook-evidence schema.
- **Rejected alternatives:** Agent-declared permissions; authorize all non-rejected ResearchMap claims; separate `hookEvidenceIds`; permit an evidence claim used only by the hook.

## Quality Requirements

| ID | Quality | Measurable target |
|---|---|---|
| QR-1 | Epistemic isolation | Tests inspect every staged prompt, envelope, file, input hash, and `freshContext`; no forbidden input appears in DIVERGE or RESEARCH, and initial WRITE also starts fresh. |
| QR-2 | Factual grounding | 100% of ResearchEvidence quotes resolve exactly to the pinned pack/video; every protected claim-text specific resolves to that claim's evidence; every final FACT anchor resolves to a code-derived permission and its protected specifics resolve to selected exact quotes. |
| QR-3 | Recovery | For crashes after D, R, or C, Continue dispatches at most the next missing call; a valid R is never called again. |
| QR-4 | Cost bound | At most six actual post-hook model launches per run. Planned path is five without repair and six with repair. |
| QR-5 | Artifact size | DIVERGE <= 16 KiB, RESEARCH <= 60 KiB, CONFRONT <= 32 KiB serialized JSON. |
| QR-6 | Compatibility | Existing completed/single-STUDY run JSON remains readable; public phase unions and UI routing do not change. |
| QR-7 | Hard-gate safety | All minimum Claim Boundary fixtures pass/fail as specified; neither a stance marker nor NARRATIVE/PERSONA beat declaration suppresses a factual violation. |
| QR-8 | Identity safety | Pending Persona entries, source-host identity, and unregistered first-person experiences cannot pass automatically. |
| QR-9 | Observability | Each run records exact stage attempts and artifact byte sizes; cost estimates are not shown as telemetry. |

### Artifact-Size Cost Estimate

This is an estimate from current artifacts, not billed-token telemetry:

- Sampled Topic Pack: 212,588 bytes (about 208 KiB / 213 kB) and 39,247 whitespace-delimited words.
- Observed old STUDY output: about 27-30 KiB.
- General Pack: about 47 KiB; Persona Pack: about 19.8 KiB.
- Current post-hook path: 3 calls without repair (`STUDY + WRITE + EDIT_REVIEW`), 4 with repair.
- Approved path: 5 calls without repair (`DIVERGE + RESEARCH + CONFRONT + WRITE + EDIT_REVIEW`), 6 with repair.
- Call increase: approximately 67% on a no-repair run and 50% on a repair run.
- The raw 212 KiB pack enters one planned model call only. DIVERGE is a small title/hook contract; CONFRONT consumes capped DIVERGE + ResearchMap artifacts; WRITE consumes the final compact study plus existing craft/persona inputs.
- Based on those artifact sizes, the expected total token increase is approximately 20-40%. This range must be replaced, not silently refined, when provider billed-token telemetry is available.

Approximate per-sub-call envelope, derived from byte/word counts rather than provider usage:

| Sub-call | Artifact-derived estimate |
|---|---|
| DIVERGE | Small title/brief/hook input plus a <=16 KiB output; roughly 2K-5K combined tokens depending on Vietnamese tokenization. |
| RESEARCH | One 212,588-byte raw pack input, roughly 60K-80K estimated input tokens, plus a <=60 KiB ResearchMap, roughly 8K-15K output tokens. |
| CONFRONT | Capped DIVERGE + ResearchMap input, roughly 10K-20K estimated tokens, plus a <=32 KiB output, roughly 4K-8K tokens. |

These are planning ranges only. They must not be displayed or billed as observed usage.

## Acceptance Criteria

1. **Given** a new Writer V2 run with a selected hook, **when** Run starts, **then** its public phase is STUDY and its first internal stage is `study-diverge-v1`.
2. **Given** a DIVERGE dispatch, **then** no source/general/formula/persona file or source-derived field is staged, and `freshContext` is true.
3. **Given** a RESEARCH dispatch, **then** Topic Pack parts are staged once, while the selected hook and DIVERGE artifact are absent from prompt, envelope, files, and conversation context.
4. **Given** three hypotheses that share the same belief shift or provocation, **then** DIVERGE validation rejects them with a precise distinctness note.
5. **Given** a ResearchMap containing an outline-like key, unresolved source ID, non-exact quote, or false multi-origin status, **then** validation rejects it before CONFRONT.
6. **Given** a valid ResearchMap and hypotheses, **when** CONFRONT runs, **then** every candidate receives KEEP/REBUILD/REJECT, hookVerdict is present, and every selected factual beat resolves to allowed claim/evidence IDs.
7. **Given** a CONFRONT REJECT hook verdict, **then** WRITE does not start and the run reports `HOOK_REVIEW_REQUIRED` with evidence-linked reasons.
8. **Given** a crash after RESEARCH commits, **when** Continue runs, **then** it verifies and reuses that artifact and does not launch another raw-pack RESEARCH call.
9. **Given** a tampered or input-incompatible checkpoint, **then** recovery fails closed rather than using or silently regenerating it.
10. **Given** any sequence of retries, **when** six model launches have started, **then** no seventh launch occurs and the run reports `MODEL_CALL_BUDGET_EXHAUSTED`.
11. **Given** `Với tôi, giữ quyền đổi ý quan trọng hơn tối đa hóa lợi nhuận.` anchored as STANCE with an eligible stance ID, **then** it passes without a ResearchMap claim.
12. **Given** `Theo tôi, 70% người Việt không có quỹ dự phòng.` anchored as STANCE without a claim ID, **then** the effective kind is FACT and it fails.
13. **Given** `Tôi tin bất động sản luôn an toàn hơn cổ phiếu.` without an allowed claim, **then** the independent reviewer flags the empirical comparison even though the deterministic floor may not detect a number/entity.
14. **Given** `Tôi từng mất 500 triệu vì quyết định này.` without an eligible Persona experience ID, **then** it fails as PERSONA_EXPERIENCE; a source quote cannot legalize it as narrator history.
15. **Given** `Giả sử bạn có 100 triệu để chia thành hai khoản.` with a unique HYPOTHETICAL anchor, visible marker, and anonymous actor, **then** it passes the hypothetical rule.
16. **Given** a factual assertion anchored to a non-rejected claim/evidence entry, **then** it passes Claim Boundary subject to existing arithmetic, identity, length, and other gate rules.
17. **Given** any stance marker wrapped around a protected number, named case, study, or empirical payload, **then** the marker never suppresses the corresponding factual violation.
18. **Given** a Persona Pack entry marked pending approval, **then** neither STANCE nor PERSONA_EXPERIENCE can cite it as eligible.
19. **Given** a semantic-only Claim Boundary defect from EDIT_REVIEW, **then** the run ends `FAILED_GATE` with exact prose and repair guidance; it cannot become DONE through an unreviewed repair.
20. **Given** an existing legacy Writer V2 run, **then** it remains readable/recoverable without fabricating new checkpoint or assertion certification.
21. **Given** a valid final StudyArtifact, **when** initial WRITE dispatches, **then** it starts with `freshContext=true` and cannot inherit DIVERGE/RESEARCH/CONFRONT conversation memory.
22. **Given** positive evidence from one origin and contradictory evidence from another, **then** the claim cannot pass as `ATTESTED` or `MULTI_SOURCE_ATTESTED`; a `DISPUTED` label also requires a nonempty caveat or conflict payload.
23. **Given** one exact `(videoId, quote)` reused under three claim IDs, **then** ledger derivation counts one unique entry, not three.
24. **Given** two Persona Pack sections with the same stable ID, **then** that ID is ineligible for narrator permission and absent from the editor eligibility index even when both headings say approved.
25. **Given** `ResearchClaim.text` containing a protected amount/name absent from all evidence quotes owned by that claim, **then** RESEARCH rejects it before CONFRONT.
26. **Given** FACTUAL, NARRATIVE, and PERSONA beats, **then** only FACTUAL requires claim/evidence mapping, only PERSONA requires an approved experience ID, and forbidden cross-kind metadata is rejected.
27. **Given** a NARRATIVE beat whose final script prose contains an amount, percentage, age, dated year, multiple, proper noun, study/data attribution, or external case, **then** whole-script detection still requires FACT permission; changing the beat kind never makes it pass.
28. **Given** selected evidence for claims A and B while non-rejected claim C remains unselected, **then** code emits permissions only for A/B with only their selected evidence IDs/quotes, and C cannot authorize WRITE/gate/editor prose.
29. **Given** hook KEEP/REWRITE referencing a claim outside the union of grounded FACTUAL beat claims, **then** CONFRONT rejects it; terminal hook REJECT remains valid without a plan.
30. **Given** evidence quote `năm ngoái tôi lỗ gần 800 triệu`, **then** FACT paraphrase `có người lỗ gần 800 triệu chỉ trong một năm` preserves the protected amount and may pass, while `có người mất gần một tỷ chỉ trong một năm` fails for specific drift.
31. **Given** an editor defect, **then** its code must belong to its declared kind; any editor-declared `CLAIM_BOUNDARY` defect routes to `FAILED_GATE`, while code-computed gate failures and `READING_EXPERIENCE` defects may route to one-shot repair and must pass both code validators afterward.

Minimum automated assertion fixtures are acceptance criteria 11-19 and 25-31. The implementation must keep the paraphrase pair in criterion 30 verbatim as a regression fixture because it distinguishes wording freedom from numeric drift.

## Risks and Technical Debt

| Risk | Impact | Mitigation / accepted debt |
|---|---|---|
| Blindness is broken by persistent CLI memory | Confirmation bias survives despite clean envelopes | Require `freshContext=true` and assert it in orchestration tests. |
| Strict key allowlist cannot detect an outline hidden in prose | Research may still smuggle story topology | Prompt prohibition plus field/size validation; treat semantic leakage as reviewable telemetry and add fixtures when observed. |
| Trusted origin provenance is not yet wired for current packs | False impression of independent corroboration | Treat all current groups as the same/`unknown` temporary fallback; multi-source status requires a future coordinator-pinned provenance extension and never agent inference. |
| DIVERGE candidates are superficially distinct | Confrontation becomes three wording options | Distinct provocations, belief-shift fields, normalization floor, and rejection fixtures. |
| ResearchMap grows toward raw-pack size | Token increase exceeds estimate | Byte caps, exact selected quotes only, one raw-pack call, no repeated source text in CONFRONT. |
| Deterministic factual detector misses semantic empirical claims | Unsourced fact passes as opinion | Independent editor; semantic findings fail closed rather than trusting one unreviewed repair. |
| Model declares NARRATIVE to avoid planning evidence | Unsupported factual prose appears lightly grounded | Treat beat kind only as planning metadata; scan the entire script and require authorized FACT anchors whenever factual signals appear. |
| Claim-text paraphrase drifts a number/name | Natural wording silently changes the fact | Validate claim specifics against owned evidence first, then validate script specifics against selected exact permission quotes. |
| Compact Persona ID allowlist leaks persona content into CONFRONT | Craft/identity biases evidence planning | Include approved experience IDs only, with no prose, stance text, pending entries, or source biography; DIVERGE/RESEARCH remain persona-blind. |
| Persona Pack currently contains pending stance entries | Stance feature appears present but safely rejects entries | Surface eligibility clearly; owner approval is a content decision outside this implementation. |
| Six-call cap reduces automatic recovery after multiple model failures | Run may stop even though another retry could work | Persist checkpoints, count launches visibly, and return precise human continuation notes. Cost safety is intentional. |
| Additive run-state fields drift from artifact ledger | Resume chooses wrong stage | Artifact hash/input-pin verification is authoritative; run JSON is a cursor/cache, not proof. |
| Current hypothetical/common-knowledge behavior has legacy edge cases | ADR-004 may change old test expectations | Lock the new priority with explicit fixtures; read old runs without retroactively marking them compliant. |
| No live external verification | “Real” means faithful to pack, not universally true | Use attestation language, conflicts, caveats, origin groups, and never claim external verification. |

## Glossary

| Term | Meaning |
|---|---|
| **DIVERGE** | Source-blind generation of three competing belief-journey hypotheses. |
| **RESEARCH** | Hypothesis-blind mapping of Topic Pack claims, evidence, conflicts, limits, and origin groups. |
| **CONFRONT** | Evidence-based KEEP/REBUILD/REJECT comparison that produces the final plan or stops the run. |
| **ResearchMap** | Strict non-narrative artifact describing what the pack attests and where it conflicts or lacks evidence. |
| **Provocation** | One of contradiction, zoom-in, extreme test, or inversion used to force a materially different hypothesis. |
| **Claim Boundary** | Contract separating sourced facts, bounded common knowledge, narrator stance, hypotheticals, and approved persona experience. |
| **Assertion anchor** | A unique verbatim script substring carrying assertion kind and required provenance IDs. |
| **Authorized claim permission** | Code-derived capability containing one selected claim plus only its selected supporting/qualifying evidence IDs and exact quotes. |
| **Protected specific** | A concrete amount, measured percentage, age, dated year, multiple, or detected proper noun that must trace to exact evidence rather than semantic similarity. |
| **Beat kind** | FACTUAL, NARRATIVE, or PERSONA planning metadata; it controls required beat fields but never grants final-script factual permission. |
| **Effective kind** | Classification computed by gate/reviewer after factual/persona priority; it may be stricter than the writer-declared kind. |
| **Typed editor defect** | Exact-quote defect labeled READING_EXPERIENCE or CLAIM_BOUNDARY with a kind-specific machine-readable code. |
| **Origin group** | Best-known upstream provenance cluster used to avoid counting repeated material as independent support. |
| **Attested** | Present in the source pack; not a claim that the outside world has independently verified it. |
| **Checkpoint** | Hash-pinned, validated immutable sub-call artifact that allows forward resume without repeating completed work. |
