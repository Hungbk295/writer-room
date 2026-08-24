> **Owner:** codex
> **Status:** deferred capability runbook — do not execute for the YT-DLP-first Corpus Intelligence P0
> **Scope:** only applies if a future release explicitly enables the YouTube Data API backend. The active P0 gate is [`spy-corpus-intelligence-hardgate.md`](./spy-corpus-intelligence-hardgate.md).

# Deferred YouTube Data API quota hard gate

## Why this is deferred

On 2026-08-23 the user selected yt-dlp as the primary source plane for search, transcript and thumbnail acquisition; C3 captures bounded direct suggestions around confirmed corpus; C2/local agy Gemini Flash performs semantic analysis. The active P0 must prove it does **not** call a Data API port. This document preserves the stricter quota/ledger contract for a later, separately approved Data API capability; it is not a release blocker for the active loop.

## Entry condition

Run this gate only after the owner confirms all three in-flight repairs are complete:

1. remove legacy local face-detector paths and provide the Gemini Flash vision seam/contract for corpus assets;
2. remove `term_external_estimates` / all provider dependency paths; and
3. make the language post-filter use video `defaultAudioLanguage` (not `relevanceLanguage` or country alone).

Fail immediately if the completion preflight returns any result:

```sh
rg -n -i 'term_external_estimates|seed_external|vidiq' packages/spy/src packages/daemon/src packages/web/src
rg -n 'createFaceDetector|face-detector|NullFaceDetector|scoreFaceless\(' packages/spy/src packages/daemon/src
```

The second command may match only the declared Gemini Flash vision port/type and any explicitly retained text hint; all legacy local detector match locations are repair targets. Browser automation is no longer blanket-prohibited: browser corpus import must instead pass its provenance/audit gate. This preflight is intentionally source-scoped: historical planning documents may mention rejected approaches.

### C1 limitation — provenance cannot be proven from a source grep

This preflight proves only that the reviewed runtime source does not name or call an external provider. It **does not** prove that an agent or person did not call a provider outside this repository and paste its result through a valid manual entry such as `seedChannelIds`, `topic_keywords`, or a corpus import. A `manual` source is necessary for channels the user already knows and is therefore not technical proof of a clean origin.

Accordingly, a PASS/CONDITIONAL PASS certifies **no provider dependency in reviewed code and no detected forbidden runtime path**; it is not a certification of the historical origin of every manually entered datum. C1 also applies to an agent’s MCP/tool calls. When an agent lacks a permitted seed, it must ask the user, import existing corpus evidence, or expand the graph—not call a provider and relabel the result as manual.

The enforceable minimum is durable provenance for system-created rows and no unlabelled automatic source. The minimum distinct labels are `data_api_search`/`search_video`, `graph` (with its supported graph subtypes), `corpus_import`, `seed_config`, and `manual_user`. `manual_user` is an attestation, not proof, and may be emitted only by an authenticated user-entry route—not by topic import, corpus import, discovery, or an agent tool.

**Provenance verification command**

```sh
bun test packages/spy/test/topic.test.ts packages/spy/test/store-v5.test.ts packages/daemon/test/spy/loop-cold-start.test.ts --test-name-pattern 'provenance|seed|corpus|manual'
```

**Pass condition:** a topic-file seed persists `seed_config`; an existing local-corpus import persists `corpus_import`; dashboard/manual-user entry persists `manual_user`; API search/graph retain their own source labels. A test must assert the stored row, not only a returned DTO. It must also query the stored `candidate_channels.discovered_via` set and prove every value belongs to the closed allowed union. A generic automatic `manual` label, a system path that writes `manual_user`, an unknown stored source value, or an unlabelled automatic source is a **FAIL**.

This catches unknown/unlabelled source values, but it still cannot prove that a person truthfully labelled a provider-derived paste as `manual_user`; that is the attestation limit described above. Any stronger guarantee requires a separately authorized environment-level tool allowlist/audit log; it is outside this repository hard gate.

## Cross-cutting T1 — one canonical quota/report day

`quota_day`, `report_date`, last-search resume checks, scheduler catch-up, and digest lookup must use the same `quotaDay(date)` value (America/Los_Angeles). UTC calendar slicing is allowed for an instant/timestamp only; it is forbidden for a quota/report-day key or comparison.

**Static review command**

```sh
rg -n 'toISOString\(\)\.(slice|substring)\(0,\s*10\)' packages/spy/src packages/daemon/src
```

Read every match. A match that produces or compares a quota/report day is a **FAIL** until it is replaced with `quotaDay(at)`. Do not delete a useful comment merely to silence this command.

**Deterministic test command**

```sh
bun test packages/spy/test/auto-loop-hardgate.test.ts packages/daemon/test/spy/loop-scheduler.test.ts --test-name-pattern 'quota.day|Pacific|digest|restart idempotency'
```

**Required cases:**

- A restart in the UTC/Pacific crossover uses `quotaDay(last_searched_at)`, so a previously searched keyword is not searched twice.
- At 08:00 Asia/Ho_Chi_Minh (18:00 Pacific of the prior calendar day in DST), digest selects the `daily_reports.report_date` written by `quotaDay(now)`, not the UTC date.
- The quota-day boundary on both sides of Pacific midnight creates exactly the expected new/old tick/report key; no test may derive its expectation with `toISOString().slice(0, 10)`.

## Test-fixture contract

Before the first execution, add or extend the deterministic test suite at `packages/spy/test/auto-loop-hardgate.test.ts` and `packages/daemon/test/spy/loop-config.test.ts`. The gate is **FAIL** if either file/test case below is absent; an existing broad unit suite is not evidence for a hard-gate case it does not assert.

The Spy fixture must use a temporary SQLite/data directory and a `TraceDataApi` wrapped in `QuotaCountingDataApi(hasKey: () => true)`. `TraceDataApi` records each underlying endpoint request and can pause/throw at a named runner checkpoint. It must be passed through the same acquisition/discovery/loop paths used by production, rather than testing quota arithmetic in isolation.

The trace is an independent oracle, not a mirror of the decorator implementation:

- Expected endpoint/bucket/unit counts are literal fixtures in the test; do not derive them by importing `QUOTA_COST`, calling `QuotaLedger.consume()`, or inspecting the decorator’s private state.
- At least the `videosByIds`, `channelsByIds`, and `videoComments` cases must use the real `YouTubeDataApiAdapter` with a dummy key and mocked transport. Count outgoing endpoint requests at that transport boundary, including 51-ID batching; a fake port method called once with 51 IDs is not proof of two HTTP requests.
- For loop/discovery fixtures, `TraceDataApi` records a conceptual endpoint event for every batch/page it serves, including page tokens. It must observe the ledger **at the point the underlying request begins** and prove the corresponding `consume()` already happened.
- Include one transport failure after request entry. Its attempted call is recorded in the ledger exactly once; retry behavior, if any, is explicit in both trace and ledger rather than silently uncounted or double-counted.
- The transport suite must also fail a **multi-batch** `videos.list` or `channels.list` request (51 IDs): once on the first HTTP request and once on the second. In each case the trace count and ledger delta equal the requests that actually began (1 and 2 respectively). Charging `ceil(ids/50)` before an inner adapter starts its own batches is not evidence of correct accounting.
- Tick counters require attribution, not merely a difference between two global daily totals. A deterministic overlap fixture must start two different topic ticks (or one tick plus another charged acquisition) behind a request barrier. Each completed tick must report only its own trace events. The implementation may meet this by serializing all chargeable work globally for P0, or by recording a charge event with `tick_id`; a per-topic lock plus a global-delta calculation is not sufficient.
- The test name, fixture action, expected trace, and expected ledger table must live together in the test case. A broad suite or helper-only arithmetic test does not discharge a hard-gate assertion.
- A hard-gate test cannot be `skip`, `todo`, conditionally bypassed for a missing local dependency, or narrowed by `only`. The command must execute every named G1–G7 assertion in a clean temporary data root.

The test set must be runnable without a real API key:

```sh
bun test packages/spy/test/auto-loop-hardgate.test.ts packages/spy/test/loop.test.ts packages/spy/test/faceless.test.ts packages/daemon/test/spy/loop-config.test.ts packages/daemon/test/spy-mcp.test.ts
bun run typecheck
bun test packages/spy packages/daemon/test/spy packages/daemon/test/spy-mcp.test.ts
```

The final command is the P0 regression set. Do not use the known unrelated `packages/daemon/test/pipeline/parse-agent-json.test.ts` failure to downgrade, hide, or explain a failure in this gate.

## G1 — quota ledger matches actual API calls

**Command**

```sh
bun test packages/spy/test/auto-loop-hardgate.test.ts --test-name-pattern 'G1 quota ledger'
```

**Required fixture actions and assertions**

| Production path exercised | Trace event | Required `api_quota_usage` delta |
| --- | --- | --- |
| Deep candidate scan/enrichment | `channels.list`, `playlistItems.list`, `videos.list` | `general.units` and `general.calls` each equal the trace count; 51 IDs/items prove two calls, not one. |
| Search plus a supplied next page | each `search.list` request/page | `search.units` and `search.calls` equal trace count; page two is another call. |
| Tool/manual-input paths | `videosByIds`, `channelsByIds`, `videoComments`, handle resolve | Each endpoint increments the same ledger before the underlying fake is called. |
| Graph paths | `channelSections.list`, `subscriptions.list` | Each underlying request has exactly one corresponding general-bucket entry. |
| Empty/missing-key path | any attempted request | No trace event and no quota row increment; error is `capability_missing`. |

**Pass condition:** the G1 matrix contains a non-empty trace case for **every** operation in `QUOTA_COST`: `search.list`, `videos.list`, `channels.list`, `playlistItems.list`, `channelSections.list`, `subscriptions.list`, and `commentThreads.list`. Its search case must actually issue a second request with a `pageToken` (a returned but unused next-page token is not a pagination test). Trace endpoint counts map one-for-one to ledger `calls`, and `units` equal their literal expected quota cost.

For a completed/resumed tick, `loop_ticks.search_calls_used`, `loop_ticks.general_units_used`, and the report’s tick quota fields must also equal the API calls **actually charged to that tick**, including an attempted transport failure and calls made before a resume. A success-only counter or a hand-estimated general-unit total is not a quota report. A call present in the trace but absent from the ledger/counter, a ledger entry without a trace, accounting after a request, a precharged-but-never-started batch, quota from another concurrent operation attributed to this tick, or a missing operation case is a **FAIL**.

## G2 — search budget is a hard ceiling

**Command**

```sh
bun test packages/spy/test/auto-loop-hardgate.test.ts --test-name-pattern 'G2 search budget'
```

**Fixture:** active topic with `dailySearchBudget: 2`, at least three pending keywords, and a fake search response that offers a next page. Run one non-dry tick.

**Pass condition:**

- Trace contains at most two `search.list` calls, including every page request.
- `loop_ticks.search_calls_used`, search-ledger `calls`, and trace count are equal and no greater than `dailySearchBudget`.
- A prefilled search ledger leaving one call available causes at most one request; a zero balance creates `skipped_quota` and zero trace events.

Any pagination request that bypasses this ceiling is a **FAIL**.

## G3 — interruption/restart has no duplicate tick or search

**Command**

```sh
bun test packages/spy/test/auto-loop-hardgate.test.ts --test-name-pattern 'G3 restart idempotency'
```

**Fixture:** use at least three searchable keywords and budget at least three calls. Pause/throw the fake **after keyword A has returned successfully, its search quota entry and `last_searched_at` have been persisted, and before keyword B begins**. Then construct a fresh runner against the same temporary database and invoke the same topic/day.

**Pass condition:**

- `SELECT count(*) FROM loop_ticks WHERE topic_id=? AND quota_day=?` is exactly `1`.
- Keyword A has one trace search call across both runner instances; B/C are searched at most once each after restart. The combined trace has exactly the three distinct planned terms, never A twice and never a shortcut checkpoint immediately before reporting.
- The resumed row reaches one terminal status and has the original tick identity/checkpoint, or a documented explicit resume identity—not a phantom second row.
- Final report/alert dedupe key is emitted at most once.
- A tick is not marked `done` until its idempotent daily report is persisted. A failure after entering the report step remains failed/resumable and a restart yields exactly one persisted report.

Killing/restarting is represented by the fixture exception and a new runner process-equivalent; do not accept an in-memory lock test as proof of persistence.

## G4 — saving loop settings cannot erase `youtubeDataApiKey`

**Command**

```sh
bun test packages/daemon/test/spy/loop-config.test.ts --test-name-pattern 'G4 preserves spy key'
```

**Fixture:** write a valid temporary `config/spy.json` containing `youtubeDataApiKey: "sentinel-key"` and non-default sampling settings. Call `handlePutSpyLoopConfig()` with loop settings, then read both JSON files from disk and initialize a fresh `SpyService` from that data root.

**Pass condition:**

- `config/spy.json` byte content is unchanged by the loop-settings write, and parsed `youtubeDataApiKey` remains `sentinel-key`.
- Only `config/spy-loop.json` changes; it contains the requested loop values and no API key.
- Fresh service public config reports `hasApiKey: true` and the expected masked suffix.

This test is mandatory because `spyConfigSchema` is `.strict()` and `loadConfig()` treats parse failure as optional/default configuration. A key disappearing, becoming empty, or moving into `spy-loop.json` is a **FAIL**.

## G5 — public output is truthful about unavailable metrics and hints

**Command**

```sh
bun test packages/spy/test/auto-loop-hardgate.test.ts --test-name-pattern 'G5 truthful output'
```

**Fixture:** create a P0 report/inbox with no M2 samples, no Analytics OAuth, a text-only faceless signal, and a search observation with a known response position.

**Pass condition:**

- Serialized loop report, `spy_loop_inbox`, and `spy_loop_report` return no `VPH`, `search volume`, `CTR`, `trend toàn cầu`, or `rank` claim in this fixture.
- The faceless value is named `faceless_hint`, carries a text-only/insufficient-sample method and reasons, and is described as a hint rather than a verdict. It cannot cause auto-reject.
- Any API-result position is labelled `observed_position`/equivalent, never `rank`.
- When no source exists, the explicit response is `unavailable` or `insufficient_sample`, not a fabricated number.

Do not use a grep over all source code for this gate: historic snapshot fields may be named `rank`; this gate concerns what P0 publishes.

## G6 — Writer Spy MCP cannot reach loop mutation tools

**Command**

```sh
bun test packages/daemon/test/spy-mcp.test.ts --test-name-pattern 'MCP.*mutation|mutation.*MCP|allowlist'
```

**Required assertions:**

- `tools/list` excludes `spy_loop_decide` and `spy_loop_tick`.
- Authenticated direct JSON-RPC `tools/call` for each name returns the MCP “tool not found” error (`-32602`); it is not merely absent from the list.
- Before/after row counts for `topic_channels` and `loop_ticks` are identical after those rejected calls.

The effective control is `EXPOSED_TOOL_NAMES` in `packages/daemon/src/spy-mcp.ts`. `SCOPES` includes `spy.start`, so scope metadata must not be accepted as the sole proof that mutation is unreachable.

## G7 — language post-filter rejects mismatched channels visibly

**Command**

```sh
bun test packages/spy/test/auto-loop-hardgate.test.ts --test-name-pattern 'G7 language post-filter'
```

**Fixture:** a Vietnamese topic receives a candidate returned despite `relevanceLanguage: vi`; its sampled uploads have a decisive English `defaultAudioLanguage` majority. Include an undecidable/missing-audio-language fixture separately.

**Pass condition:**

- English-majority candidate is `rejected` with `decided_by: loop_auto`, `lang_detected: en` (or the defined normalized code), and a persisted/displayed `lang_mismatch` reason identifying `defaultAudioLanguage` evidence.
- The rejection is visible in the report/inbox query and is not silently dropped.
- The declared-language winner must be a **strict** majority of declared values. A tie never auto-rejects and remains reviewable.
- The coverage denominator is all returned slots from the selected up-to-12 upload sample, including IDs for which `videos.list` returned no row. Missing/insufficient language evidence is not auto-rejected merely because of `snippet.country`, `relevanceLanguage`, or a response map that happened to contain one declared video; it remains reviewable/unknown under the documented fallback.

## Result format and decision

Record, for every command, its exit code and the named tests run. Report one of:

| Result | Required facts |
| --- | --- |
| **PASS** | Completion preflight is clean; G1–G7 and the P0 regression/typecheck commands exit 0. A real API-key run also confirms the ledger trace, if a key is available. |
| **CONDITIONAL PASS** | All deterministic gates pass, but no user API key exists for the live call/ledger confirmation. State that exact limitation; it is the only permitted condition. |
| **FAIL** | Any preflight/G1–G7/regression command fails or required test is missing. Give a repair note as `file:line` plus failed assertion and observed/expected values. |

Never call a gate PASS by relying on dry-run alone: dry-run plans calls but deliberately emits no API trace.
