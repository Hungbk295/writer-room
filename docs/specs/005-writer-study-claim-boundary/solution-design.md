---
title: "Writer V2: Blind Study Planning and Claim Boundary"
status: approved
version: "1.0"
date: 2026-09-01
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

## Constraints

| ID | Constraint |
|---|---|
| CON-1 | The owner approved the full-fidelity STUDY design: exactly three planned sub-calls in order, `DIVERGE -> RESEARCH -> CONFRONT`. A two-call MVP is not the target. |
| CON-2 | `WriterRunV2.phase` and the visible UI state machine do not gain DIVERGE, RESEARCH, or CONFRONT values. While any of the three runs, the public phase is `STUDY`. |
| CON-3 | DIVERGE is source-blind. Its prompt, envelope, staged files, and CLI conversation may not contain the Topic Pack, ResearchMap, source IDs, source quotes, prior STUDY output, General Pack, Formula, or Persona Pack. |
| CON-4 | RESEARCH is hypothesis-blind. It may see the pinned title, brief, audience, Topic Pack, and source manifest, but not the selected hook, DIVERGE artifact, candidate hypotheses, General Pack, Formula, or Persona Pack. |
| CON-5 | CONFRONT sees only validated DIVERGE and RESEARCH artifacts plus the selected hook and planning contract. It does not receive the raw Topic Pack, General Pack, Formula, or Persona Pack. |
| CON-6 | DIVERGE, RESEARCH, CONFRONT, and the initial WRITE use fresh CLI context. Reusing the visible author terminal identity must not reuse conversation memory that breaks blindness or lets raw planning topology leak into prose. |
| CON-7 | DIVERGE returns three hypotheses, not three prose outlines. Each hypothesis uses a distinct provocation from `CONTRADICTION`, `ZOOM_IN`, `EXTREME_TEST`, and `INVERSION`; at least three of the four must be exercised. |
| CON-8 | RESEARCH uses a strict allowlist schema and cannot emit outline, hook, thesis, beat order, narration, intro, ending, or recommended story topology fields. |
| CON-9 | Research status means what the pack attests, not external truth. The allowed statuses are `ATTESTED`, `MULTI_SOURCE_ATTESTED`, `DISPUTED`, and `REJECTED`; the system must not relabel them “verified.” |
| CON-10 | Multiple videos count as independent support only when `SUPPORTS`/`QUALIFIES` evidence belongs to independently established origin groups. `CONTRADICTS` evidence never increases attestation strength; repetition inside one channel or shared upstream material is not independent corroboration. |
| CON-11 | CONFRONT is allowed to invalidate the writer's initial idea. A loop that can only patch evidence into the chosen hook is rejected as confirmation bias. |
| CON-12 | General Pack, Formula, and Persona Pack remain WRITE inputs. They do not shape research collection or hypothesis generation. |
| CON-13 | Every protected assertion in WRITE/REPAIR output is represented by a unique exact-substring `assertionAnchor`; metadata supplied by the writer is untrusted until validated. |
| CON-14 | Assertion kinds are exactly `FACT`, `COMMON_KNOWLEDGE`, `STANCE`, `HYPOTHETICAL`, and `PERSONA_EXPERIENCE`. A writer cannot create an additional exemption class. |
| CON-15 | A factual detector can never be disabled by “theo tôi,” “tôi tin,” “với tôi,” or another stance marker. A factual payload claimed as STANCE is evaluated as FACT or PERSONA_EXPERIENCE. |
| CON-16 | STANCE does not need a ResearchMap claim, but it must trace to an approved Persona Pack stance entry. PERSONA_EXPERIENCE must trace to an eligible experience archetype. An entry marked pending approval, rejected, or sharing a duplicate stable ID is ineligible. |
| CON-17 | Deterministic Claim Boundary rules are the minimum floor. An independent editor must also review empirical propositions that have no number or readily detected proper noun. |
| CON-18 | A semantic-only Claim Boundary failure cannot automatically become DONE after an unreviewed repair. Under the six-call ceiling it fails closed for human review. |
| CON-19 | The post-hook semantic call budget is five calls without REPAIR and six with REPAIR: three STUDY calls, WRITE, EDIT_REVIEW, and at most one REPAIR. No planning loop or second editor pass is added. |
| CON-20 | Every model dispatch that actually starts consumes the run budget, including a retry. Recovery must prefer a committed checkpoint, and automatic work stops before starting call seven. |
| CON-21 | Existing Topic Pack, General Pack, Formula, and hook hashes remain pinned. If an optional Persona Pack is loaded at WRITE, its hash is pinned through gate/review/repair. A checkpoint is reusable only when all inputs relevant to that checkpoint still match. |
| CON-22 | This delivery adds no live Google, Reddit, social, browser, external API, database, or search dependency. Future source types may enter through a separately validated Topic Pack contract. |
| CON-23 | DIVERGE, RESEARCH, and CONFRONT dispatch sequentially. They are not parallelized on the same Writer item/attempt because current lane write ownership and checkpoint ordering assume sequential stages. |

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
  why: "Current numeric, proper-noun, hypothetical, common-knowledge, ledger, beat-anchor, identity, and length checks to extend with Claim Boundary."

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
WRITE (General + Formula + optional Persona)
        |
        v
Deterministic Gate ---> independent EDIT_REVIEW + Claim Boundary
        |                                   |
        | safe/style repairable             | semantic boundary failure
        v                                   v
one REPAIR -> deterministic Gate        FAILED_GATE + precise repair notes
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
- `deterministic-gate.ts` remains pure and testable. It receives validated assertion metadata rather than reading run files.
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

This SDD supersedes only two Writer V2 details from the earlier MVP design: the single monolithic STUDY call and the absence of an explicit stance-versus-claim boundary. It preserves the existing Writer V2 lifecycle, hard-gate layers, artifact model, and downstream contracts; it does not overlap the Spy/source-acquisition designs.

## Building Block View

### Components

#### 1. Thin Writer Coordinator

`writer-run-v2.ts` retains lifecycle ownership. It selects the next internal STUDY sub-call, stages only allowed inputs, records call budget, commits validated results, derives the legacy `StudyArtifact`, and preserves the existing WRITE/GATE/EDIT_REVIEW/REPAIR transitions.

#### 2. Research Map

`research-map.ts` defines the RESEARCH prompt contract, strict allowlist parser, exact-quote/source-ID validation, independent-origin semantics, size limits, and conversion from selected evidence to the legacy `factsLedger`.

#### 3. Story Planning

`story-planning.ts` defines DIVERGE candidates, the four provocations, meaningful-distinctness checks, CONFRONT deltas, verdicts, hook verdict, evidence-to-beat mapping, and final `WriterVideoPlan` validation.

#### 4. Assertion Boundary

`assertion-boundary.ts` defines the five assertion kinds, exact anchor validation, persona registry references, classification priority, deterministic findings, compact editor input, and semantic-boundary finding schema.

#### 5. Independent Editor

The existing editor remains a different agent/session from the author. Its current reading-experience checklist gains a Claim Boundary section and a compact admissibility index. It still receives no raw Topic Pack, General Pack, Formula, or writer reasoning.

### Directory Map

```text
packages/daemon/src/writer/
├── writer-run-v2.ts          # MODIFY: thin coordinator, internal cursor, dispatch/settle/recovery
├── research-map.ts           # NEW: ResearchMap schema, validation, ledger derivation
├── story-planning.ts         # NEW: DIVERGE/CONFRONT schemas, prompts, validation
├── assertion-boundary.ts     # NEW: ADR-004 contract and deterministic boundary floor
├── deterministic-gate.ts     # MODIFY: consume assertion anchors and boundary findings
├── persona-pack.ts           # MODIFY: stable IDs and approval/eligibility index
└── run-store-v2.ts           # MODIFY only for additive legacy defaults if required

packages/daemon/test/writer/
├── writer-run-v2.test.ts         # MODIFY: three-call flow, blindness, recovery, budget
├── deterministic-gate.test.ts    # MODIFY: assertion fixtures and priority
├── research-map.test.ts          # NEW: strict schema and exact grounding
└── story-planning.test.ts        # NEW: candidate/confront validation
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

Validation rules:

- One `sourceAudit` entry per Topic Pack video ID and no unknown video ID.
- Every evidence quote is an exact substring of the pinned Topic Pack and its video association is valid.
- Every referenced claim/evidence ID resolves; rejected claims cannot enter the facts ledger.
- `MULTI_SOURCE_ATTESTED` requires positive (`SUPPORTS`/`QUALIFIES`) evidence from at least two distinct, nonempty `originGroup` values pinned by the coordinator. `CONTRADICTS` evidence is excluded from supporting-origin counts. The research agent may not declare source independence.
- Any claim containing both positive and `CONTRADICTS` evidence is ineligible for `ATTESTED` or `MULTI_SOURCE_ATTESTED`; it must be `DISPUTED` or `REJECTED`. `DISPUTED` requires both evidence directions plus a nonempty claim caveat or top-level conflict payload, so the agent cannot choose the stronger label for the same evidence set.
- Until a separately trusted provenance extension is wired, current pack paths conservatively pin every origin to `unknown`, so multi-source status cannot pass. This is a temporary safe fallback, not the final provenance design; neither model output nor repeated videos may upgrade it.
- The top-level and nested schemas use explicit allowlists. Keys or sections that encode hook, thesis, outline, beat order, intro, ending, narration, recommendation, or story spine are rejected.
- Serialized output is capped at 60 KiB. An oversize artifact fails with `RESEARCH_ARTIFACT_OVERSIZE`; the coordinator does not automatically repeat the raw-pack call merely to ask for compression.

#### CONFRONT artifact

```ts
type HypothesisVerdict = 'KEEP' | 'REBUILD' | 'REJECT';
type HookStatus = 'KEEP' | 'REWRITE' | 'REJECT';

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

interface ConfrontArtifact {
  schemaVersion: 'writer-study-confront-v1';
  assessments: [HypothesisAssessment, HypothesisAssessment, HypothesisAssessment];
  selectedHypothesisId?: string;
  hookVerdict: HookVerdict;
  finalPlan?: WriterVideoPlan;
  beatEvidence?: Array<{
    beatIndex: number;
    claimIds: string[];
    evidenceIds: string[];
  }>;
}
```

Validation rules:

- All three candidate IDs are assessed once. Every claim/evidence reference resolves to the validated ResearchMap.
- KEEP requires enough non-rejected support and no hit on a declared falsifier.
- REBUILD requires explicit before/after deltas and a rebuilt belief shift; it is not a synonym for minor wording edits.
- REJECT cannot be selected. At least one KEEP/REBUILD candidate is required to proceed.
- `hookVerdict.status=REWRITE` requires a valid replacement hook and evidence-linked reason. It may tighten grounding while preserving the human-selected promise; a materially different promise is `REJECT` and requires human choice. `REJECT` produces no final plan and fails STUDY with `HOOK_REVIEW_REQUIRED`; it does not trigger an automatic hook loop.
- Every factual beat in `finalPlan` maps to non-rejected claim and evidence IDs. The application, not the model, derives the legacy `factsLedger` from those selected evidence records.
- A DISPUTED claim may be selected only when the plan preserves its conflict/caveat; an uncaveated beat is rejected. Planning and Claim Boundary use one deliberately narrow caveat-marker registry and the same acceptance/rejection fixtures; vocabulary expansion is a contract change. Ledger derivation must retain at least the existing minimum of three grounded entries.
- Serialized DIVERGE and CONFRONT outputs are capped at 16 KiB and 32 KiB respectively.

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
```

Anchor rules:

- `quote` is copied verbatim from the final script and must identify exactly one occurrence. If a short phrase repeats, the writer expands the quote until it is unique.
- Anchors are minimal complete assertions, are ordered by script position, and may not partially overlap. Exact duplicates are rejected.
- The gate scans the entire script independently of the supplied anchors. Every detected protected assertion must be fully covered by one anchor; a missing anchor fails as `ASSERTION_UNANCHORED`. The independent reviewer performs the same completeness check for semantic empirical claims.
- FACT requires at least one non-rejected ResearchMap claim whose selected evidence produced the facts ledger. If the claim is DISPUTED, the anchored prose must preserve its conflict/caveat.
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
deriveStudyArtifact(research: ResearchMap, confront: ConfrontArtifact): StudyArtifact
nextStudyAction(run: WriterRunV2, artifacts: ArtifactReader): StudyAction
validateAssertionAnchors(input: AssertionBoundaryInput): AssertionBoundaryResult
buildClaimBoundaryReviewIndex(input: BoundaryIndexInput): BoundaryReviewIndex
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

`coverageMap` is derived from `ResearchMap.sourceAudit`; `gap` is derived from the selected/rebuilt central tension; `outline` comes from validated CONFRONT; and `factsLedger` is mechanically derived from selected evidence. `effectiveHook` equals the human selection on KEEP and the validated replacement on REWRITE; the original `run.selectedHook` remains available for audit. The optional `planning` field allows old persisted runs to remain readable.

WRITE and REPAIR draft artifacts add required `assertionAnchors`. Legacy completed drafts remain readable but are not silently re-certified under ADR-004.

#### Integration Points

- The settle listener accepts all three internal STUDY stage IDs and commits one checkpoint per valid artifact.
- WRITE starts with `freshContext=true` and receives the final StudyArtifact and `effectiveHook`, General Pack, Formula contract/content as currently applicable, and optional pinned Persona Pack. It does not receive raw ResearchMap topology or CONFRONT conversation memory.
- Gate receives the final script, assertion anchors, facts ledger, Persona eligibility index, and existing outline/identity/length inputs.
- EDIT_REVIEW receives the script, outline, effective hook, writer assertion anchors, deterministic findings, and a compact index of allowed claim/stance/experience IDs and texts. It receives no raw source files.
- REPAIR receives precise deterministic/style defects. A semantic-only boundary failure bypasses automatic repair and ends as `FAILED_GATE` with exact quote and required classification/source/persona repair.

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

The effective kind is FACT. Without a non-rejected `claimId`, the gate rejects it.

## Runtime View

### Primary Flow

```text
1. Human selects a hook and starts Writer V2.
2. Coordinator pins title/brief/audience/hook/pack/general/formula hashes,
   sets status RUNNING + phase STUDY, and checks call budget.
3. DIVERGE launches with freshContext=true and no source/craft/persona files.
4. Validator commits checkpoint D.
5. RESEARCH launches with freshContext=true, Topic Pack files, and no hook/hypotheses.
6. Validator grounds quotes/statuses, then commits checkpoint R.
7. CONFRONT launches with freshContext=true using D + R + selected hook, no raw pack.
8. Validator commits checkpoint C and derives the legacy StudyArtifact.
9. Public phase advances to WRITE; a fresh context receives final plan + craft/persona inputs.
10. WRITE emits script plus assertionAnchors.
11. Deterministic gate computes effective kinds and factual/persona provenance.
12. EDIT_REVIEW independently checks experience, story quality, arithmetic, and
    semantic Claim Boundary using the compact admissibility index.
13a. No defect: DONE if deterministic gate also passed.
13b. Deterministically repairable or style defect: one REPAIR, then deterministic gate.
13c. Semantic-only Claim Boundary defect: FAILED_GATE with exact repair notes; no
     unreviewed automatic repair is allowed to become DONE.
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
| Hypotheses differ only in wording | DIVERGE artifact rejected | Name normalized duplicate fields and required provocation change. |
| No hypothesis survives CONFRONT | Existing `FAILED` terminal handling | Return each verdict/falsifier and request a new human hook/brief decision. |
| Hook rejected by evidence | `HOOK_REVIEW_REQUIRED` | Give evidence-linked reason; do not silently preserve the hook. |
| Checkpoint tampering/hash mismatch | `STUDY_CHECKPOINT_INVALID` | Name stage, expected hash, and actual hash. |
| Call seven would start | `MODEL_CALL_BUDGET_EXHAUSTED` | Show calls consumed by stage/attempt; require human action. |
| STANCE contains protected factual payload | `FAILED_GATE` | Quote exact prose, effective kind FACT, and missing claim ID. |
| Persona experience lacks eligible ID | `FAILED_GATE` | Quote exact prose and require removal or an approved Persona Pack entry. |
| Independent reviewer finds semantic empirical assertion | `FAILED_GATE` | Quote exact prose and require grounding, qualification, hypothetical rewrite, or removal. |

### Complex Logic

#### Meaningful candidate distinctness

Normalization removes punctuation, stop phrases, and provocation labels, then compares the core thesis/belief transition tokens. Deterministic similarity is a floor, not semantic proof: the DIVERGE prompt must also explain why each candidate changes what the viewer believed before and after. Identical belief shifts with different examples fail.

#### Facts ledger derivation

The model never writes arbitrary ledger quotes after CONFRONT. For each selected beat evidence ID, code resolves the validated ResearchEvidence, ResearchClaim, and source video; rejected claims are excluded; duplicate evidence is collapsed by `(videoId, exact quote)` regardless of how many agent-authored claim IDs reuse it. Claim/evidence authorization remains separate from the legacy ledger and must not inflate evidence breadth by duplicating the same transcript substring. This closes the current path where an agent can invent several fact labels around one real quote and satisfy the ledger minimum.

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
2. Land ADR-004 types, parser, deterministic fixtures, and editor schema behind tests.
3. Land DIVERGE/RESEARCH/CONFRONT modules and checkpoint recovery.
4. Switch new Writer V2 runs to the internal three-call STUDY flow.
5. Preserve read/recovery behavior for existing single-STUDY runs.

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
- **Decision:** Use the five-kind assertion contract, exact-substring anchors, persona references, deterministic floor, and independent reviewer. Factual detection has priority over stance markers.
- **Reason:** Narrator voice needs room for values and interpretation, but “theo tôi” must not become a bypass for statistics, empirical comparisons, named cases, or invented biography.
- **Rejected alternatives:** Require every sentence to have a source claim; allow all first-person statements without ledger; rely only on the writer's declared kind; rely only on regex.

### ADR-005: Fold Claim Boundary into EDIT_REVIEW and fail semantic defects closed

- **Status:** Accepted
- **Decision:** The independent editor performs both reader-quality and semantic-boundary review in one call. Semantic-only boundary failures go to human `FAILED_GATE`, not an unreviewed automatic repair.
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
- **Decision:** General Pack, Formula, and Persona Pack remain WRITE-only inputs; Persona IDs also feed the later gate/editor eligibility index.
- **Reason:** Research should map reality and uncertainty, not search for evidence that fits a preferred formula or borrowed storytelling voice.
- **Rejected alternatives:** Show General/Formula to DIVERGE or RESEARCH; use source experiences as narrator biography.

## Quality Requirements

| ID | Quality | Measurable target |
|---|---|---|
| QR-1 | Epistemic isolation | Tests inspect every staged prompt, envelope, file, input hash, and `freshContext`; no forbidden input appears in DIVERGE or RESEARCH, and initial WRITE also starts fresh. |
| QR-2 | Factual grounding | 100% of ResearchEvidence quotes resolve exactly to the pinned pack/video; 100% of final FACT anchors resolve to non-rejected claim IDs. |
| QR-3 | Recovery | For crashes after D, R, or C, Continue dispatches at most the next missing call; a valid R is never called again. |
| QR-4 | Cost bound | At most six actual post-hook model launches per run. Planned path is five without repair and six with repair. |
| QR-5 | Artifact size | DIVERGE <= 16 KiB, RESEARCH <= 60 KiB, CONFRONT <= 32 KiB serialized JSON. |
| QR-6 | Compatibility | Existing completed/single-STUDY run JSON remains readable; public phase unions and UI routing do not change. |
| QR-7 | Hard-gate safety | All minimum Claim Boundary fixtures pass/fail as specified; a stance marker never suppresses a factual violation. |
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

Minimum automated assertion fixtures are acceptance criteria 11-16. Criteria 17-19 are additional regression fixtures required by the hard-gate boundary.

## Risks and Technical Debt

| Risk | Impact | Mitigation / accepted debt |
|---|---|---|
| Blindness is broken by persistent CLI memory | Confirmation bias survives despite clean envelopes | Require `freshContext=true` and assert it in orchestration tests. |
| Strict key allowlist cannot detect an outline hidden in prose | Research may still smuggle story topology | Prompt prohibition plus field/size validation; treat semantic leakage as reviewable telemetry and add fixtures when observed. |
| Trusted origin provenance is not yet wired for current packs | False impression of independent corroboration | Treat all current groups as the same/`unknown` temporary fallback; multi-source status requires a future coordinator-pinned provenance extension and never agent inference. |
| DIVERGE candidates are superficially distinct | Confrontation becomes three wording options | Distinct provocations, belief-shift fields, normalization floor, and rejection fixtures. |
| ResearchMap grows toward raw-pack size | Token increase exceeds estimate | Byte caps, exact selected quotes only, one raw-pack call, no repeated source text in CONFRONT. |
| Deterministic factual detector misses semantic empirical claims | Unsourced fact passes as opinion | Independent editor; semantic findings fail closed rather than trusting one unreviewed repair. |
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
| **Effective kind** | Classification computed by gate/reviewer after factual/persona priority; it may be stricter than the writer-declared kind. |
| **Origin group** | Best-known upstream provenance cluster used to avoid counting repeated material as independent support. |
| **Attested** | Present in the source pack; not a claim that the outside world has independently verified it. |
| **Checkpoint** | Hash-pinned, validated immutable sub-call artifact that allows forward resume without repeating completed work. |
