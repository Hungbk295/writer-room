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
| yt-dlp P0 enrich (inspect, transcript, thumbnail) | Fixture vertical slice implemented | `CorpusIntelligenceService` calls only `YoutubePort`; fixture proves the injected Data API has zero calls. Real yt-dlp collection remains explicit user action. |
| Browser/user corpus import | Fixture vertical slice implemented | Draft-first batch/item, canonical URL, explicit confirm/reject, immutable P0 provenance and 30-day evidence receipt. The current daemon is single-local-user (`local-desktop`), not a multi-user auth system. |
| C3 direct recommendations | Contract/UI + fixture implemented; provider deferred | `RecommendationCapturePort` is depth 1 / max 20 / non-recursive with no Data API or yt-dlp fallback. Real persona browser capture is intentionally `not_configured` pending the deferred extension gate. |
| Gemini Flash semantic analysis | Contract/UI + fixture implemented; provider deferred | Evidence manifest, schema validation, expiry and review-only analysis run exist. The actual local agy/Gemini Flash transport must still be wired and hard-gated before use on data. |
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

### P0 — Corpus Intelligence Loop *(active; fixture vertical slice implemented, production providers gated)*

**Outcome:** a reviewable vertical slice: user-confirmed corpus → yt-dlp raw observation → C3 direct suggestions → yt-dlp transcript/thumbnail enrichment → local agy/Gemini Flash analysis → Inbox/report.

**P0-A — source mode:** inject a `YtDlpAcquisitionPort` for search, inspect, transcript and thumbnail. The P0 test fixture supplies a Data API port that throws if touched; no source path may silently fall back to it.

**P0-B — corpus import:** browser/user-upload batches are actor-authorized, draft-first and atomic on confirm. Item identity/evidence is server-derived; missing verified channel identity remains `needs_identity` with zero API lookup.

**P0-C — C3 recommendations:** a `RecommendationCapturePort` takes only a confirmed corpus seed; it records up to 20 direct suggestions at depth 1, as a draft batch. It does not recurse. Per-item user confirmation preserves seed→target provenance and never overloads generic source fields with a video ID.

#### Deferred P0-C extension — persona-assisted browser research capture

**Decision:** a one-off fetch of a seed video's sidebar is not a credible C3 source. YouTube recommendations are personalized by watch/search history and the current video surface; therefore, browser-assisted C3 is a **later, human-in-the-loop research workflow** whose value depends on a sufficiently reviewed corpus. It is not on the critical path for the fixture-backed P0-C contract or any current collection release.

**Source and compliance boundary:** do not use `ytsearch`, the legacy Data API, or yt-dlp's generic recommendation/feed facilities as a substitute for direct suggestions. Do not implement Playwright/server-side scraping, synthetic playback, scripted likes/subscriptions, bulk queries, or any mechanism that fabricates engagement. An external browser tool may be orchestrated only when its use is authorized for YouTube and it supports explicit human approval at each meaningful action. It must never disclose cookies, credentials, headers, visitor/session data, local storage, or a complete browser profile to Spy.

**Entry gate:** before a persona run, a user approves a versioned `PersonaSpec` built from the confirmed corpus. The initial release requires at least 30 confirmed videos across 8--12 channels, with each item classified as `core`, `bridge`, or `negative`, plus language/market, format and relevance rationale. The threshold is a readiness heuristic, not a claim that YouTube will return a representative market sample.

**PersonaSpec:** store an immutable spec digest with: topic boundary; allowed/excluded themes; language, market and format; approved seed set; query-bank version; relevance rubric; scenario version; and a non-sensitive browser-profile reference. Do not put account identifiers, cookies or history contents in the spec.

**Runbook:** a user-approved research profile follows a bounded scenario over multiple sessions: choose a small set of `core` seeds; genuinely review them; use a small, corpus-derived query bank; capture only visible `Watch Next`, Home or Search surfaces at explicit checkpoints; and use negative feedback only when it truthfully reflects irrelevance. The browser tool records a minimized receipt (surface, canonical seed/target URLs, visible position, observed time and scenario/spec digest). It must not force a watch duration, click feedback, or interact with likes, subscriptions, comments or sharing.

**Promotion and quality gate:** every captured target remains a `DRAFT` C3 observation and follows the normal depth-1 / <=20 / selective-confirm flow. Measure `precision@20`, novelty, channel/format diversity and off-topic contamination against the review rubric over 6--10 approved sessions. Do not expand browser collection or treat it as a trusted source until user review accepts those measurements. This metric measures usefulness for this research persona, not YouTube-wide demand or ranking.

**Required browser-port capabilities:** persistent but opaque research profile; navigation and visible-page/accessibility snapshots; user-approval checkpoints; selected-card/visible-surface capture; stable session/action receipts; and a policy-controlled data export that exposes only the allowed normalized fields. Raw artifacts keep the normal 30-day retention and digest/tombstone rule.

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
- [x] **ADR-SI-10 — persona-assisted C3 boundary:** Browser-personalized C3 is deferred behind a corpus-quality and human-approval gate. It may use an authorized external browser port only for user-approved research sessions; no automated YouTube scraping, synthetic engagement, cookie/session export, or recursive discovery. Fixture-backed depth-1 C3 remains the P0 contract proof before this extension.

## 7. Explicit non-goals

- A global YouTube index, demand/competition figure, CTR prediction, or “global trend” without its authorized source.
- Any external YouTube intelligence data-provider dependency, untracked/recursive browser collection, or uncalibrated Gemini auto-action.
- Unbounded yt-dlp/C3 collection, duplicate points/alerts, or retention beyond 30 days for public third-party data.
- Media generation, thumbnail creation, voice, script writing, or automatic application of recommendations in Spy.

## 8. Kế hoạch thực thi theo phase

Mỗi phase chỉ được bắt đầu khi exit gate của phase trước đã đạt. Không coi test đơn lẻ, schema tồn tại, hoặc adapter stub là bằng chứng rằng một workflow đã chạy end-to-end.

| Phase | Mục tiêu có thể dùng được | Công việc chính | Exit gate |
| --- | --- | --- | --- |
| 0 — Baseline & contract freeze | Có một baseline đáng tin để xây tiếp | Đối chiếu code, migration, API/MCP, test và dữ liệu thật với tài liệu; xác nhận owner của `topics`, corpus membership, review state, scheduler và report; chốt nhãn provenance đóng, retention 30 ngày, các collection limit và trạng thái `unavailable`/`needs_identity`. | Một status matrix “đã có / stub / chưa có” được cập nhật; không còn mâu thuẫn “P0 đang chạy” với “P0 chưa bắt đầu”; fixture `NoDataApi` được tạo trước bất kỳ collector P0 nào. |
| 1 — Source foundation (P0-A) | P0 có thể lấy raw observation bằng yt-dlp mà không chạm Data API | Tách `YtDlpAcquisitionPort` cho search, inspect, transcript, thumbnail/frame; thêm source-mode injection vào đường P0; chuẩn hoá raw observation, lỗi và freshness; đặt query, timeout, concurrency và retention bounds. | Fixture truyền Data API luôn throw nhưng search/inspect vẫn chạy qua fake yt-dlp; không có fallback Data API; raw observation có source, thời điểm, URL/ID canonical và expiry. |
| 2 — Confirmed corpus intake (P0-B) | User có thể đưa một corpus vào hệ thống một cách audit được | Thiết kế và migrate import batch/item; browser capture hoặc upload vào draft; server canonical hoá URL/identity; confirm batch theo actor; corpus membership và provenance immutable; xử lý `needs_identity` không tự lookup. | Draft không xuất hiện trong corpus/candidate/recommendation reads; confirm atomic và idempotent; mọi item confirmed truy được batch, actor, evidence, captured time và retention expiry. |
| 3 — Direct suggestions (P0-C) | Từ corpus đã duyệt có inbox suggestion giới hạn, không thành crawler | 3.1a tạo `RecommendationCapturePort` fixture; chỉ nhận confirmed seed; capture depth 1, tối đa 20 target/seed; lưu seed→target immutable; tạo draft batch và selective confirm/reject. Persona-assisted browser capture là extension deferred, chỉ sau corpus-quality/user-approval gate. | Không thể gọi capture với seed chưa confirm; không có target nào thành seed tự động; retry/restart không nhân bản target hay làm mất multi-seed provenance. |
| 4 — Selected-item enrichment (P0-D) | Item user chọn có evidence thô đủ cho review/analyse | Với các item đã confirm/select: yt-dlp inspect channel/video, transcript và thumbnail/frame; persist artifact manifest, availability/failure và tombstone khi quá hạn; tuyệt đối tách raw data khỏi semantic result. | Thiếu transcript/asset trả `unavailable` có lý do; không có Gemini output nào được dùng thay raw observation; artifact và derivative hết hạn theo cửa sổ 30 ngày. |
| 5 — Gemini review plane (P0-E) | User nhận phân tích Gemini có bằng chứng, chỉ để review | Tạo `GeminiFlashAnalysisPort` multimodal; input manifest chỉ gồm raw evidence đã được cho phép; schema-validate output; lưu analysis run (model, policy, input digest, refs, attempt/status/expiry, response digest); đưa kết quả vào Inbox/report. | Output malformed không ghi thành profile/interpreted result; mọi claim link về evidence thực; analysis không mutate corpus/review state và không auto-approve/reject. |
| 6 — Orchestrated loop & product surface | Có một vertical slice vận hành được từ corpus tới Inbox | Nối các port vào LoopRunner/checkpoint/resume theo owner Auto-Loop; thêm dry-run, kill switch, bounded schedule/catch-up, dashboard capture preview/selective confirm, Inbox và report idempotent; Writer Spy MCP chỉ expose read surface được allowlist. | Tick crash/restart không chạy lặp collection hay gửi report trùng; user thực hiện được import → confirm → capture → enrich → analyse → review bằng UI; mutation loop bị chặn trên Writer Spy MCP. |
| 7 — Release hard-gate (P0-F) | Có bằng chứng đủ để bật P0 cho dữ liệu thật | Chạy bộ fixture độc lập: NoDataApi, limit/throttle, draft-confirm isolation, immutable provenance/multi-seed, expiry/tombstone, unavailable states, Gemini evidence schema, restart/idempotency và MCP mutation denylist. | Tất cả test hard gate pass trên SQLite tạm, không cần API key; typecheck và Spy/daemon suites pass; chỉ khi đó mới bật topic đầu tiên ở chế độ production. |

### Definition of done cho từng phase

1. Có migration + typed contract + API/UI wiring đúng owner; không chỉ có bảng hoặc mock.
2. Có test thành công, failure-path và restart/idempotency nếu phase có persistence/async work.
3. Có provenance, expiry và trạng thái unavailable trong output; không suy đoán để lấp dữ liệu thiếu.
4. Review bằng dữ liệu fixture trước; chỉ Phase 7 pass mới được bật collection thật.

### Thứ tự sau P0

Sau khi Phase 7 đạt gate: **M1** change intelligence trên corpus → **M5a** co-occurrence từ observation đã có → **M2** time-series/VPH thật → **M3** opportunity card cho Writer → **M4** OAuth analytics kênh sở hữu → **M5b** embeddings/Gemini corpus-bounded. Không kéo M1–M5 vào P0.

## 9. Quy ước triển khai và review UI

**Quy ước do user chốt:** chỉ có **một micro-phase đang làm**. Kết thúc micro-phase phải dừng để user review trên UI; chỉ nhận phase kế tiếp sau khi user xác nhận kết quả test. Không gộp migration, collector, analysis và UI vào cùng một lần bàn giao.

Mỗi micro-phase phải được ghi theo mẫu sau trước khi code:

| Mục | Nội dung bắt buộc |
| --- | --- |
| Mục tiêu | Một hành vi duy nhất người dùng có thể quan sát. |
| UI review contract | Route, thao tác click/nhập, dữ liệu fixture hoặc dữ liệu thật được phép dùng, và trạng thái UI mong đợi. |
| Boundary | API/port/schema nào được thay đổi; những đường không được phép chạm. |
| Test gate | Lệnh tự động tối thiểu và checklist test tay trên UI. |
| Stop condition | Điều gì khiến phase dừng, rollback hoặc trả `unavailable` thay vì tự suy diễn. |

### Micro-phase queue cho P0

| ID | Scope cực nhỏ | UI review trước khi qua bước tiếp |
| --- | --- | --- |
| 0.1 | Audit trạng thái thực và hiển thị source/capability state trên màn hình Loop ở chế độ read-only. Không đổi collector. | Mở `#/spy/loop`; thấy rõ từng capability là available / unavailable / not configured, cùng lý do; không có nút nào gây collection. |
| 0.2 | Khóa config topic đầu tiên và dry-run plan. Không gọi mạng. | Tạo/chọn topic, bấm **Xem kế hoạch chạy**; thấy seed, giới hạn query/item, source mode và cảnh báo thiếu cấu hình. |
| 1.1 | Chỉ 1 query yt-dlp trong chế độ dry-run/fixture, Data API bị throw. | Bấm **Kiểm tra nguồn yt-dlp**; UI trả số raw observations hoặc trạng thái lỗi có lý do, đồng thời hiện “Data API: không dùng”. |
| 1.2 | Persist một raw observation yt-dlp có expiry 30 ngày. | Mở chi tiết observation; thấy URL/ID canonical, captured time, source, expiry và raw evidence; chưa có Gemini. |
| 2.1 | Nhập **một** corpus item vào draft. | Dán URL; UI chỉ hiện Preview/Draft, không xuất hiện ở inbox/corpus đã duyệt. |
| 2.2 | Confirm/reject một import batch. | Bấm Confirm; item xuất hiện ở corpus cùng provenance. Bấm Reject ở fixture khác; item không được promote. |
| 3.1 | Capture suggestion cho **một** confirmed seed với fixture. | Bấm **Lấy gợi ý**; thấy tối đa 20 draft, badge “depth 1”, seed source rõ ràng. |
| 3.2 | Selective confirm/reject suggestion. | Confirm một target; UI giữ seed→target links. Target chưa confirm không thể dùng làm seed. |
| 4.1 | Enrich một confirmed video: metadata + availability state. | Mở item đã confirm; bấm Enrich, thấy trạng thái success/unavailable cụ thể. |
| 4.2 | Persist transcript/thumbnail manifest cho item có dữ liệu. | UI preview artifact và expiry; item thiếu transcript hiển thị unavailable, không placeholder giả. |
| 5.1 | Render input manifest review cho Gemini, chưa gọi model. | User xem danh sách transcript/assets sẽ gửi; không có cookie/private state. |
| 5.2 | Chạy một Gemini analysis fixture/schema-validated. | UI hiện labels/claim và link evidence; malformed fixture hiển thị failed, không có profile kết quả. |
| 6.1 | Nối một tick manual qua các phần đã được duyệt. | Bấm Run one tick; progress checkpoint và resume status hiển thị trên UI. |
| 6.2 | Inbox/report idempotent từ tick fixture. | Reload/retry không tạo item/report trùng; user review được từng kết quả. |
| 7.1 | Chạy hard-gate suite và render release checklist read-only. | UI checklist chỉ “Ready” khi toàn bộ gate pass; nếu fail phải chỉ rõ gate/failure, không cho bật production. |

### Current implementation checkpoint — 2026-08-26

The local P0 slice now persists separate corpus/import/C3/evidence/analysis/tick/report rows, keeps draft data out of legacy candidate/topic/Inbox tables, exposes a review-safe HTTP/UI projection, applies manual-loop kill-switch + checkpoint/report idempotency, and expires public evidence with tombstones. It is **not** production-ready: the daemon intentionally exposes typed `not_configured` failures for C3 persona capture and agy/Gemini Flash until their approved adapters exist; the full independent hard-gate suite (including restart and MCP denylist cases) remains a release blocker.
