> **Agent:** codex
> **Status:** active — v3: YT-DLP-first Corpus Intelligence Loop selected for P0
> **Owns:** Intelligence contracts, factual hard gates, metric definitions, and acceptance criteria for Spy / Writer Spy MCP.
> **Does not own:** Auto-Loop topic/review-state ownership, scheduler, UI implementation, Writer generation, media production, or global crawling. Spy owns source/evidence contracts for the YT-DLP-first corpus loop and the approved local Gemini Flash analysis route.
> **Depends on:** [`../claude/spy-autoloop-design.md`](../claude/spy-autoloop-design.md) (v3, source of truth for discovery/review-state P0), `packages/spy/**`, `packages/daemon/src/spy-mcp.ts`.

# Spy Intelligence — roadmap tự chủ trên yt-dlp, corpus và Gemini Flash

**Reconciled:** 2026-08-23

**Supersedes:** roadmap dated 2026-08-19.
**Reason:** Auto-Loop P0 has established the topic/discovery contract and three user decisions are non-negotiable.

## 1. Non-negotiable boundaries

| Decision | Binding rule | Roadmap consequence |
| --- | --- | --- |
| C1 — source autonomy | Do not use vidIQ or any other external YouTube-intelligence data provider. The product must replace, not depend on, such a provider. | P0 raw observation comes from yt-dlp, user-confirmed C3/browser capture, and the local corpus. YouTube Data API is a deferred optional capability, never a hidden P0 fallback. |
| C2 — Gemini Flash analysis | A local agy may call Gemini Flash to analyze approved raw metadata, transcript and thumbnail/frame assets. | Persist model/version, prompt-policy, input/evidence references, observation time and status. Deterministic parsing of IDs/URLs/timestamps stays outside Gemini; all semantic analysis is review-only until an explicit user-approved action policy exists. |
| C3 — browser corpus + adjacent recommendations | Browser-assisted collection is allowed and important after the user confirms a corpus-import batch. It may capture direct YouTube suggestions around that confirmed corpus. | Every imported/captured item needs server-validated canonical URL/identity, capture time, batch/owner and provenance. Recommendations are depth 1 only, bounded per seed, draft before selective user confirmation; not anonymous/recursive background discovery and not a place to retain browser session secrets. |

For public, non-authorized channel/video data, raw data and every recomputable derivative have a **maximum rolling retention of 30 days**. Refresh within that window or delete it. A result must never outlive the public samples from which it was derived.

## 2. Decision and plan boundary

Spy is an evidence system for a bounded corpus, not a global YouTube index. It may observe, compare, and report signals from that corpus; it may not label an unobserved market-wide quantity as a measured fact.

Auto-Loop owns topic configuration/persistence, `candidate_channels`, `topic_channels`, review state and report scheduling. This roadmap defines the source/evidence contract beneath that ownership: corpus membership, yt-dlp observations, C3 batches, Gemini analysis and their hard gates. It must not introduce a second candidate table, channel index, review status, or discovery loop.

This roadmap owns what can be truthfully captured and computed **inside the managed corpus**: yt-dlp observation, C3 recommendation provenance, Gemini analysis, change reports, time-series definitions, similarity contracts, Writer evidence contracts and the hard gates that validate them.

### Evidence rules that apply to every milestone

- Every number has `source`, `method`, observation window, timezone, `sampleCount`, and freshness/availability status. Missing evidence is `unavailable` or `insufficient_sample`, never a substituted heuristic.
- Keep existing minimum-sample gates such as `MIN_VIDEOS_FOR_DISTRIBUTION` and `MIN_VIDEOS_FOR_CORRELATION`. Return `MetricValue{method}` (or the equivalent typed contract) rather than an unqualified number.
- `validateEvidenceRefs` remains mandatory: an LLM claim must link to an existing segment, frame, quote, metadata snapshot, or named raw observation.
- Spy produces evidence and bounded opportunities; Writer decides angle and script. There is no automated “copy competitor” route.

## 3. Current baseline

| Capability | State | Truth boundary |
| --- | --- | --- |
| yt-dlp search, inspect, transcript and thumbnail acquisition | Present, but API-first wiring remains | `YtDlpAdapter` exists; P0 still needs a source-mode switch so no Data API fallback is reachable. |
| Browser corpus import | Design draft | Batch/item/immutable provenance contract exists on paper; no P0 implementation is claimed. |
| C3 direct recommendations | Not implemented | Current yt-dlp adapter has no related/player-response capture API; introduce an explicit bounded capture port. |
| Gemini Flash semantic analysis | Not implemented | Existing LLM port is text-only; P0 needs a multimodal evidence-bearing Gemini port. |
| Auto-Loop topic discovery, review state, reports | Existing code, to be re-scoped | P0 loop becomes YT-DLP/C3/C2 first; Data API key is not a prerequisite. |
| Change intelligence on managed channels | M1 next | Reads Auto-Loop tables; does not discover or approve channels. |
| Public-video time-series and VPH | M2 specified, not implemented | Repeated yt-dlp view-count observations in the rolling 30-day corpus window; Data API polling is optional later. |
| First-party retention, traffic, revenue, audience | M4 later | OAuth only for an authorized owned channel. |
| Text/corpus similarity | Split M5a/M5b | Corpus-bounded; no claim of global similarity. |
| Corpus semantic/visual analysis | P0-E design | Local agy calls Gemini Flash against retained corpus assets; every result is evidence-bearing and review-only. |

### MCP surface currently proved by test

`packages/daemon/test/spy-mcp.test.ts` asserts the exact sorted `tools/list` set of **22** tools: eight existing acquisition/evidence tools, ten M0 intelligence reads, and four Auto-Loop reads (`spy_topics_list`, `spy_loop_status`, `spy_loop_inbox`, `spy_loop_report`).

The ten M0 intelligence additions are `spy_channel_videos`, `spy_channel_outliers`, `spy_channel_profile`, `spy_video_metrics`, `spy_title_patterns`, `spy_video_comments`, `spy_corpus_videos`, `spy_corpus_channels`, `spy_channel_momentum`, and `spy_competitors_list`.

`spy_channel_start` and `spy_video_start` are pre-existing acquisition mutations and retain the `spy.start` scope. Thus a scope label is **not** a universal read-only guarantee. The server-side explicit allowlist is the gate that decides which tools can be reached at all; each admitted tool’s required scope is an additional constraint. In particular, `spy_loop_decide` and `spy_loop_tick` must remain absent from `tools/list` and a direct call must return “tool not found”.

## 4. Delivery slices

### P0 — Corpus Intelligence Loop *(selected; implementation not started)*

**Outcome:** a reviewable vertical slice: user-confirmed corpus → yt-dlp raw observation → C3 direct suggestions → yt-dlp transcript/thumbnail enrichment → local agy/Gemini Flash analysis → Inbox/report.

**P0-A — source mode:** inject a `YtDlpAcquisitionPort` for search, inspect, transcript and thumbnail. The P0 test fixture supplies a Data API port that throws if touched; no source path may silently fall back to it.

**P0-B — corpus import:** browser/user-upload batches are actor-authorized, draft-first and atomic on confirm. Item identity/evidence is server-derived; missing verified channel identity remains `needs_identity` with zero API lookup.

**P0-C — C3 recommendations:** a `RecommendationCapturePort` takes only a confirmed corpus seed; it records up to 20 direct suggestions at depth 1, as a draft batch. It does not recurse. Per-item user confirmation preserves seed→target provenance and never overloads generic source fields with a video ID.

**P0-D — enrichment:** selected target video/channel observations use yt-dlp to capture metadata, transcript and thumbnail/frame artifacts. Raw platform observations are immutable inputs, not Gemini claims.

**P0-E — C2 analysis:** a separate multimodal `GeminiFlashAnalysisPort` receives an input manifest and returns schema-validated labels/keyword candidates/evidence. Store analysis kind, model/version, policy version, immutable asset/transcript/snapshot refs, input-manifest digest, timestamp, raw-response digest when one exists, attempt/status and expiry in an analysis-run record; the existing `profiles` table alone lacks those audit fields. Expiry is the earliest expiry of supporting public evidence, not simply run creation plus 30 days. Normalized results must reference that run. A malformed response is not inserted as an `interpreted` profile. P0 writes only reviewable output.

**P0-F — release gates:** NoDataApi, bounded acquisition, C3 draft/confirm isolation, immutable multi-seed provenance, restart/idempotency, 30-day artifact tombstones, C2 evidence schema and mutation-denylist gates must pass before release.

### M0 — expose existing intelligence to Writer Spy MCP *(complete; reconciled 2026-08-22)*

**Purpose:** Agents and UI can read existing Spy intelligence without direct SQLite access.

**Scope completed:** The ten intelligence tools listed above, with provenance/sample gates and no credential exposure. The four P0 Auto-Loop reads are a separate read addition and are accounted for in the exact allowlist assertion.

**Completion proof:** `bun test packages/daemon/test/spy-mcp.test.ts` asserts the sorted allowlist, selected schemas, read routing, and mutation denylist; `bun run typecheck` passes.

**Decision:** M0 is closed. Future Auto-Loop read additions update the exact allowlist test and this inventory; they do not reopen M0.

### M1 — change intelligence on Auto-Loop’s managed corpus

**Purpose:** Make the approved/managed topic corpus useful for editorial decisions without creating another discovery or watchlist system.

**Scope:** Report what changed since the prior valid observation for a `topic_channels` channel/video: new upload, cadence change, views-per-day average (not VPH), outlier/cohort change, scan coverage, and evidence freshness. Read topic membership/status from Auto-Loop; do not write it except through its owner flow.

**Explicitly removed from M1:** Channel discovery, candidate intake, keyword expansion, a parallel watchlist, a parallel review status, and a separate channel index. Those are already Auto-Loop P0 responsibilities.

**Acceptance criteria:**

- Every delta identifies old and new raw observation/run, comparison window, method, and freshness.
- A missing prior observation produces `unavailable`; average views/day is never labelled VPH.
- Report/alert dedupe key is `topic + entity + rule + window`; retry cannot resend the same alert.
- All third-party source and derived rows used by the report remain inside the 30-day rolling retention window.

**Decision:** M1 remains open but is deliberately narrowed; its discovery portion is closed as already owned by Auto-Loop.

### M5a — observed search/recommendation co-occurrence *(P1; promoted)*

**Purpose:** Build the first self-owned “similar channels/videos” signal from repeated co-occurrence in yt-dlp search observations and C3 direct-suggestion observations already made for a topic.

**Scope:** Store/recompute a bounded co-occurrence view from yt-dlp search observations, C3 seed→target observations and `topic_channel_sources`; return query/seed, window and counts that support each match. It is a similarity signal inside observed topic results, not a ranking or claim about all YouTube.

**Acceptance criteria:**

- Each match includes contributing query IDs/terms, observed positions, timestamps, and a clear `method: serp_cooccurrence` label.
- Search-result position is never presented as “rank”.
- Every source observation declares its capture method (`ytdlp_search` or `corpus_suggestion`), canonical source URL/seed, timestamp and bounded capture limit.
- Co-occurrence material is refreshed/recomputed or deleted within 30 days.

**Decision:** This is the near-term, non-vision substitute for provider-supplied similar-channel signals and precedes generic similarity embedding work.

### M2 — public time-series, true VPH, and alert contract *(specified; build after M1/M5a data contract is stable)*

**Purpose:** Measure public-video velocity within the managed corpus from more than one observation.

**Scope:** Re-observe eligible corpus video IDs with yt-dlp and keep raw public points only in a rolling 30-day window. Compute VPH at read time from valid points; it is not a permanent global metric. A future YouTube Data API backend may implement the same observation contract, but is not a prerequisite.

**Core contract:**

- Raw point: `video_stat_points(source_video_id, sampled_at, view_count, like_count, comment_count, source='ytdlp')`, unique by video and sample instant/run id.
- The collection planner dedupes eligible corpus IDs and sets an explicit run ceiling/concurrency; it records every attempted/succeeded/failed observation without silently substituting stale values.
- VPH for a requested 1h/24h/7d window is `(end.view_count - start.view_count) / elapsed_hours`. Return it only with at least two valid raw points that bracket/cover the requested window according to a documented tolerance; otherwise return `unavailable` with the missing coverage reason.
- Response includes requested and effective window, both sample timestamps/counts, timezone, last sample, freshness, source, method, and retention expiry. Never substitute average views/day for VPH.
- Restart/idempotency keys prevent duplicate raw points, duplicate observation runs and duplicate threshold alerts. Backoff/retry must not manufacture a point.
- Delete/refresh expired third-party points and recompute cached derivatives from the remaining raw window. Do not preserve a derived VPH, trend, faceless/style score, or alert fact after its supporting public samples expire.

**Learn-value upgrade:** Replace only the existing coarse “recent upload views/day versus channel median” momentum component when valid M2 VPH coverage exists. Preserve the raw evidence/window on the score; if coverage is insufficient, retain the existing coarse method with an explicit method label rather than pretending it is VPH.

**Non-scope:** Global trends, public CTR/impressions, and Analytics-only data. `impressions` and `impressionsClickThroughRate` remain `unavailable` until an authorized Analytics/Reports implementation verifies their availability and provenance.

### M3 — Writer opportunity cards

**Purpose:** Turn bounded evidence into reviewable editorial input, never a competitor-copy instruction.

**Scope:** An opportunity statement, observed signal, 2–5 reopenable evidence refs, format/title pattern, novelty constraint, niche-fit reason, and a separate “fact to verify” field where needed.

**Dependencies:** M0 + M1. M2 may raise priority but is not required.

**Acceptance criteria:**

- Do not create a card without reopenable evidence references.
- Distinguish observation from hypothesis and label every numeric source/method.
- Import to Writer creates an immutable Source Pack/snapshot; drafting does not read mutable Spy state.

### M4 — first-party Analytics OAuth

**Purpose:** Read genuinely private/owner metrics—retention, traffic, audience, revenue, and best time to post—for only the channel that authorized access.

**Scope:** Consent, encrypted token storage, minimum scopes, reporting adapter, and a bounded UI/MCP read surface.

**Acceptance criteria:**

- Token and analytics data cannot cross workspace/channel authorization boundaries.
- Revenue appears only when authorization and monetization permit it.
- Reports declare date range/dimensions; rate limits and API failures are recoverable.
- If a metric is unavailable for the authorized scope, return `unavailable`; do not estimate it from public data.

### M5b — corpus text/metadata embeddings + Gemini Flash analysis

**Purpose:** Find semantically similar videos in the local corpus after manual relevance evaluation proves it helps.

**Scope:** Embeddings of title, transcript and permitted metadata plus Gemini Flash analysis over thumbnails/frames already admitted to the corpus. Each match exposes matched signals and the corpus boundary.

**Analysis contract:** A local agy invokes Gemini Flash, then stores model/version, prompt-policy version, source asset/transcript references, input-manifest digest, observation timestamp, labels/keyword candidates, cited evidence and run status. It does not manufacture a YouTube-wide style or market fact. Raw public inputs and the derivative analysis expire with their 30-day evidence window; only an audit tombstone/digest may remain. The first release is review-only; promotion to any automatic action needs an explicit calibration dataset, error thresholds and user approval.

**Entry gate and acceptance criteria:**

- Corpus is sufficiently diverse and manually evaluated for relevance before publishing matches.
- Each result says it is corpus-bounded and exposes source snapshots/evidence.
- No match is called similar “on YouTube”; visual classification remains corpus-bounded and cannot enter auto-triage before the calibration gate passes.

## 5. Delivery order

1. **P0-A/B** — yt-dlp-only source mode and actor-authorized corpus import are the foundations.
2. **P0-C/D** — bounded C3 suggestions, then yt-dlp enrichment of selected items.
3. **P0-E/F** — Gemini Flash review output plus deterministic gates. Data API quota work is explicitly deferred.
4. **M1** — change intelligence on the one managed corpus.
5. **M5a** — observed search/recommendation co-occurrence, the first self-owned similar signal.
6. **M2** — repeated yt-dlp observations, valid VPH and retention-safe alerts.
7. **M3**, **M4**, then **M5b** — evidence-first Writer cards, owned-channel OAuth, then broader corpus matching.

## 6. ADR decisions

- [x] **ADR-SI-1 — MCP surface:** The explicit daemon allowlist is the reachability gate. Required scopes constrain admitted tools but do not prove a global read-only surface (`spy.start` is currently present). Keep loop mutations off the Writer Spy MCP allowlist; test list exclusion and direct-call rejection.
- [x] **ADR-SI-2 — public time-series boundary:** Poll only Auto-Loop managed corpus items; public raw samples and recomputable derivatives have a rolling 30-day retention window. No global crawler/index.
- [x] **ADR-SI-3 — Writer boundary:** Spy creates evidence/opportunity cards; Writer owns editorial angle and script. No automated competitor copying.
- [x] **ADR-SI-4 — keyword/demand boundary:** No provider-based demand, volume, competition, or global-trend estimate. First-party authorized Analytics is the only valid demand-like source; corpus-derived signals have an explicit `derived_corpus` method label.
- [x] **ADR-SI-5 — Analytics boundary:** First-party analytics exists only via OAuth for the authorized owned channel and is separated from public competitor data.
- [x] **ADR-SI-6 — source autonomy (C1):** No vidIQ or other external data provider is a dependency, including cold start or similarity. P0 uses yt-dlp, user-confirmed browser capture and existing corpus evidence; Data API is an optional later backend, never a hidden fallback.
- [x] **ADR-SI-7 — Gemini Flash analysis (C2):** A local agy may call Gemini Flash only on captured metadata/transcript/thumbnail/frame evidence. Save source refs, input-manifest digest, model/prompt-policy version, timestamp and evidence. Until a user-approved action policy, outputs are review-only and cannot auto-reject or mutate corpus state.
- [x] **ADR-SI-8 — browser corpus import and C3 suggestions:** Browser-assisted import is permitted after user confirmation of the corpus batch. C3 may capture direct recommendations around a confirmed seed, at depth 1 and a fixed per-seed ceiling. Save URL, capture time, batch/owner and immutable provenance; do not admit through a generic automatic/manual source label.
- [x] **ADR-SI-9 — P0 source-plane choice:** Suspend the Data API quota coordinator as a P0 blocker. Preserve it as deferred code/ADR; P0 acceptance instead proves a throwing Data API port is never invoked.

## 7. Explicit non-goals

- A global YouTube index, demand/competition figure, CTR prediction, or “global trend” without its authorized source.
- Any external YouTube intelligence data-provider dependency, untracked/recursive browser collection, or uncalibrated Gemini auto-action.
- Unbounded yt-dlp/C3 collection, duplicate points/alerts, or retention beyond 30 days for public third-party data.
- Media generation, thumbnail creation, voice, script writing, or automatic application of recommendations in Spy.
