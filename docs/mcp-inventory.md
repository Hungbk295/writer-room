# Writer Room MCP Inventory

Inventory + audit của các MCP server trong Writer Room (đọc từ code, 2026-09-02).

Mục tiêu: một chỗ xem **MCP nào đang sống**, **tool nào expose**, **discovery/config**, và **chỗ schema/config đang lệch hoặc bị cứng**.

## Tóm tắt nhanh

| MCP server | Mount name (agent) | Status | Discovery | Tools exposed |
|---|---|---|---|---|
| Team MCP | `team` | **Live** | `GET /api/team/mcp` | 6 |
| Spy MCP | `writer_room` | **Live** (cần Spy feature on) | `GET /api/spy/mcp` | 23 / 53 catalog |
| General Pack MCP | `general_pack` | **Live** (cần Spy feature on) | `GET /api/general-pack/mcp` | 10 |
| External Writer Library MCP | `(planned)` | **Spec only** — chưa code | planned `/mcp/library` | 0 |
| Writer Run / Training MCP | — | **Không có** | Writer v2 qua HTTP/UI | — |

Feature gate: `WRITER_ROOM_SPY_ENABLED=0` tắt cả Spy MCP và General Pack MCP. Team MCP vẫn chạy theo harness.

---

## 1. Team MCP — `writer-room-team`

**Code:** `packages/daemon/src/team/mcp.ts`  
**Khởi tạo:** `packages/daemon/src/harness.ts` → `McpTeamServer`  
**Transport:** HTTP loopback, port ngẫu nhiên, path `/mcp`  
**Auth:** Bearer token random mỗi daemon run; thêm query `?token=` + SSE compatibility cho Agy  
**Audience:** agent trong Agent Harness (coordination)

### Tools (6)

| Tool | Required params | Notes |
|---|---|---|
| `team_send_message` | `channel`, `senderAgentId`, `body` | optional: `mentions[]`, `replyTo`, `idempotencyKey` |
| `team_read_messages` | `channel` | optional: `afterCursor`, `limit` |
| `team_ack_messages` | `channel`, `agentId`, `throughCursor` | |
| `team_get_assignment` | `agentId` | |
| `team_update_status` | `agentId`, `status` | `status` ∈ `idle\|running\|paused\|error` |
| `team_turn_complete` | `agentId`, `turnId`, `status` | `status` ∈ `done\|failed`; optional `summary` |

### Config / rigid notes

- Agent **tự khai báo** `agentId` / `senderAgentId` — server không bind identity từ bearer. Agent có thể spoof agent khác nếu biết token (token dùng chung cả team).
- Không có scope/capability split theo agent.
- Schema khá mỏng: thiếu `minLength`, `enum` mô tả channel hợp lệ, max body size.
- Có SSE; Spy/General Pack **không** có SSE → transport không đồng nhất giữa các MCP.

---

## 2. Spy MCP — `writer-room-spy`

**Code:** `packages/daemon/src/spy-mcp.ts` (allowlist + `inputSchemas`)  
**Tool implementations:** `packages/spy/src/mcp-tools.ts` (`spyTools()`)  
**Khởi tạo:** `packages/daemon/src/http.ts` → `McpSpyServer`  
**Mount vào agent:** `appMcpProvision` → key `writer_room`  
**Transport:** HTTP loopback POST-only + Bearer (không SSE, không query token)  
**Scopes cứng trên server:** `spy.start`, `spy.read`

### Tools đang expose (23)

#### Acquisition / wait / evidence

| Tool | Required | Optional / notes |
|---|---|---|
| `spy_channel_start` | `url` | `selection_mode`, `top_n` (1–20), `scan_limit` (1–500), `rank_by`, `depth` |
| `spy_video_start` | `url` | `depth` |
| `spy_get_status` | `operation_id` | handler cũng nhận alias `run_id` (không có trong schema) |
| `spy_wait` | `operation_id` | `max_wait_seconds` 1–600 (default handler 30) |
| `spy_run_manifest` | `spy_run_id` | catalogue video + snapshot id, không trả transcript body |
| `spy_find_videos` | `spy_run_id`, `titles` | `match`: `exact\|contains` |
| `spy_global_video_search` | `query` | `limit` 1–50 default 20; `language`/`region` default **`vi`/`VN`** |
| `spy_read_transcript` | `video_snapshot_ids` (1–5) | `cursors`, `limit_per_video` 1–50 |
| `spy_read_video_material` | `video_snapshot_ids`, `include_thumbnail` | giống transcript + optional image content |

#### Intelligence (read-only allowlist)

| Tool | Required | Notes |
|---|---|---|
| `spy_channel_videos` | `channel_id` **or** `spy_run_id` | filter/sort/pagination |
| `spy_channel_outliers` | `channel_id` **or** `spy_run_id` | `min_score` |
| `spy_channel_profile` | `channel_id` **or** `spy_run_id` | |
| `spy_video_metrics` | `video_id` | optional `spy_run_id` |
| `spy_title_patterns` | `channel_id` **or** `spy_run_id` | |
| `spy_video_comments` | `video_id` **or** `channel_id` | `max_results`, `order`, `include_replies` |
| `spy_corpus_videos` | (none required) | nhiều filter; có thể trả rộng nếu agent không lọc |
| `spy_corpus_channels` | (none) | `min_videos`, `min_avg_views`, `limit` |
| `spy_channel_momentum` | `channel_id` | `window_days` 1–365 |
| `spy_competitors_list` | `owner_channel_id` **or** `channel_id` | |

#### Spy Loop (read-only)

| Tool | Required | Notes |
|---|---|---|
| `spy_topics_list` | — | |
| `spy_loop_status` | — | optional `topic_id` |
| `spy_loop_inbox` | `topic_id` | `status`, `limit`, `cursor` |
| `spy_loop_report` | — | optional `topic_id`, `date` (`YYYY-MM-DD`) |

### Catalog có nhưng **không** expose qua Spy MCP (30)

Cố ý theo comment trong `spy-mcp.ts` (mutations / discovery write / loop write / legacy readers):

- **Cancel / legacy read:** `spy_cancel`, `spy_get_result`, `spy_get_transcript`, `spy_channels_list`
- **Transcript ops:** `spy_transcript_fetch`, `spy_transcript_search`, `spy_transcript_normalize`, `spy_transcript_cohort`
- **Source pack export:** `spy_export_source_pack`
- **Deeper intelligence:** `spy_hook_taxonomy`, `spy_video_structure`, `spy_topic_clusters`, `spy_voice_profile`, `spy_compare`, `spy_channel_diff`
- **Bulk lookup / quota:** `spy_videos_by_ids`, `spy_channels_by_ids`, `spy_quota_status`
- **Niche / discovery / candidates (mutating or expensive):** `spy_niche_get`, `spy_niche_set`, `spy_niche_score_fit`, `spy_discover_channels`, `spy_discover_videos`, `spy_expand_graph`, `spy_candidates_list`, `spy_candidates_decide`, `spy_scan_candidates`, `spy_competitors_update`
- **Loop write:** `spy_loop_decide`, `spy_loop_tick` (cần `spy.loop.write`, không nằm trong `SCOPES`)

### Schema drift & rigid defaults (quan trọng)

1. **`inputSchema` tách khỏi handler**  
   Descriptions lấy từ `spyTools()`, nhưng `inputSchema` hardcode trong `spy-mcp.ts`. Dễ lệch khi thêm param ở catalog.

2. **`spy_channel_start` — schema thiếu param handler đã hỗ trợ**  
   Handler nhận thêm: `min_duration_sec`, `max_duration_sec`, `published_after`, `published_before`, `idempotency_key`.  
   Schema MCP **không list** các field này → agent/`tools/list` không biết dùng được.

3. **`spy_video_start` — schema thiếu `idempotency_key`** (handler có).

4. **Alias không document trong schema**  
   - `spy_get_status` / `spy_wait`: handler nhận `run_id` như alias `operation_id`.  
   Schema chỉ có `operation_id`.

5. **Default cứng trong handler (không config file)**  
   | Param | Default cứng |
   |---|---|
   | `top_n` | 5 |
   | `scan_limit` | 60 |
   | `selection_mode` | `popular` (mọi giá trị khác `latest`) |
   | `rank_by` | `velocity` (chỉ flip khi đúng `"views"`) |
   | `min_duration_sec` | 60 |
   | `depth` | `transcript` |
   | `spy_global_video_search.language/region` | `vi` / `VN` |
   | transcript page byte budget | ~48KB soft budget trong `readTranscriptBatch` |
   | `spy_wait` max | 600s; default 30s |
   | output truncate | per-tool `outputLimitBytes` trong catalog |

6. **Scopes cố định**  
   Mọi client cầm Spy bearer đều có `spy.start` + `spy.read`. Không có read-only token / per-agent scope.

7. **Không validate JSON Schema phía server trước khi call**  
   Schema chủ yếu cho client discovery; handler tự parse/`AppError`. Agent có thể gửi field “lạ” và bị ignore hoặc default-coerce.

---

## 3. General Pack MCP — `writer-room-general-pack`

**Code:** `packages/daemon/src/general-pack-mcp.ts`  
**Domain helpers:** `packages/daemon/src/writer/general-pack.ts`  
**Mount name:** `general_pack`  
**Discovery:** `GET /api/general-pack/mcp`  
**Scopes cứng:** `general_pack.read`, `general_pack.stage`, `general_pack.commit` (cùng một bearer — **chưa** tách commit-less instance)

### Tools (10)

| Tool | Scope | Required | Notes |
|---|---|---|---|
| `pack_list` | read | — | list mọi pack |
| `pack_get` | read | `channel` | file `channel.md` |
| `pack_list_candidate_videos` | read | `source` | `spy_run` hoặc `channel_url` |
| `pack_get_transcript` | read | `videoIds` (1–5) | `offset`, `limitChars` default 20k, max 200k |
| `pack_validate_taste_dna` | read | `sourceVideoIds`, `principles` | principles 5–8; quote phải substring transcript |
| `pack_validate_entry` | read | `videoId`, `hook`, `beats`, `examples`, `payoff`, `boundary` | beats 2–8; example tags cố định 11 giá trị |
| `pack_stage_taste_dna` | stage | `channel`, `sourceVideoIds`, `principles` | ghi staging, chưa commit |
| `pack_stage_entry` | stage | `channel` + entry fields | |
| `pack_commit` | commit | `channel`, `reviewerNote` | `includeTasteDna`, `videoIds`, `force` |
| `pack_health` | read | `channel` | quote-ratio; mô tả ngưỡng khỏe ~60% (informational) |

### Rigid / missing config

1. **`pack_list_candidate_videos(source=channel_url)` hardcode Spy input**  
   Luôn: `selectionMode: 'popular'`, `scanLimit: 60`, `rankBy: 'views'`, `minDurationSec: 60`, `depth: 'transcript'`.  
   Caller có thể truyền `rank_by` / `top_n` nhưng **không** ảnh hưởng lần Spy start — chỉ ảnh hưởng khi `source=spy_run`.

2. **Example tags cố định 11 giá trị** (`GENERAL_PACK_EXAMPLE_TAGS`) — đúng by design (grounding), nhưng không config được per-channel.

3. **Taste DNA `principles` cứng `minItems: 5`, `maxItems: 8`** — không config.

4. **Per-agent scope split chưa wired**  
   Comment trong code: batch-draft agent lẽ ra không nhận `.commit`; cần `appMcpProvision(agentId)` mount instance commit-less. Hiện mọi agent nhận full scopes.

5. **Batch tools chưa có**  
   `pack_generate_batch` / `pack_batch_status` cố ý chưa wire (cần pipeline lane riêng).

6. Transport giống Spy: POST + Bearer only (không SSE).

---

## 4. External Writer Library MCP — chưa implement

**Spec:** `docs/specs/003-external-writer-library-mcp/solution-design.md` (status: draft)  
**Planned path:** `/mcp/library` trên daemon port ổn định  
**Planned resources:** article releases + formula versions (read-only)  
**Planned config:** `config/library-mcp.sqlite`, token CLI `library-mcp:token …`

Hiện **không** có class server / route / package.json script tương ứng trong code runtime.

---

## 5. Những MCP / surface agent thường kỳ vọng nhưng chưa có

| Surface | Thực tế hiện tại |
|---|---|
| Writer Run v2 MCP (`create_run`, study/write status…) | HTTP/UI + pipeline harness — **không** MCP |
| Training / Formula MCP | Training listeners trong daemon — **không** MCP public |
| Source Pack export qua MCP | `spy_export_source_pack` có trong catalog nhưng **không** expose |
| Discovery/niche qua MCP | có trong catalog, **không** expose (HTTP/settings thay thế một phần) |

---

## 6. Cách agent nhận config MCP

Harness (`packages/daemon/src/agents/index.ts`) ghi file theo adapter:

| Adapter | Config path | Format |
|---|---|---|
| Claude / Codex (generic) | `writer-room-data/agents/mcp-{agentId}.json` | `{ mcpServers: { name: { type, url, headers } } }` |
| Agy | `<cwd>/.agents/mcp_config.json` | `{ serverUrl, headers }` |
| Grok | `<cwd>/.grok/config.toml` | `[mcp_servers.<name>]` + headers |
| Gemini | `<cwd>/.gemini/settings.json` | `httpUrl` + headers |

`appMcpProvision` hiện mount **cùng** Spy + General Pack info cho mọi agent (không phân quyền theo `agentId`).

External / Hermes proxy: `hermes-workspace/src/writer-room-proxy.ts` discover qua `GET /api/spy/mcp` rồi forward `tools/list` + `tools/call` (chỉ Spy, không proxy Team/General Pack trừ khi cấu hình riêng).

---

## 7. Audit findings — ưu tiên

### P0 — schema/config lệch làm agent dùng sai hoặc bỏ sót capability

| ID | Finding | Impact | Gợi ý |
|---|---|---|---|
| P0-1 | `spy_channel_start` schema thiếu `min_duration_sec`, `max_duration_sec`, `published_*`, `idempotency_key` | Agent không thấy filter đã hỗ trợ | Sync schema từ handler (single source of truth) |
| P0-2 | Dual source: allowlist + `inputSchemas` map vs `spyTools()` | Drift khi thêm tool/param | Generate schema cạnh tool def, hoặc export schema từ catalog |
| P0-3 | `pack_list_candidate_videos(channel_url)` ignore `rank_by` / không expose Spy knobs | Agent tưởng đã rank theo param | Pass-through params hoặc bỏ param khỏi schema khi không dùng |

### P1 — thiết kế cứng / thiếu config vận hành

| ID | Finding | Impact | Gợi ý |
|---|---|---|---|
| P1-1 | Locale default `vi`/`VN` hardcode trong search | Khó dùng multi-market nếu không biết override | Document rõ + optional project default trong `spy.json` |
| P1-2 | Team/Spy/General Pack scopes không per-agent | Draft agent có thể `pack_commit` | Wire commit-less provision như comment trong code |
| P1-3 | Team `agentId` self-asserted | Spoof trong cùng token | Bind agentId từ launch context / per-agent token |
| P1-4 | Transport không đồng nhất (Team SSE vs Spy POST-only) | Agy/client lệch hành vi | Quyết định 1 transport matrix và document |
| P1-5 | 30 spy tools catalog nhưng ẩn | Agent/docs dễ tưởng “thiếu tool” trong khi cố ý | Doc allowlist rationale (file này) + comment gần EXPOSED set |

### P2 — chưa ship / ngoài scope hiện tại

| ID | Finding |
|---|---|
| P2-1 | Library MCP chỉ có SDD |
| P2-2 | Không có Writer Run MCP |
| P2-3 | General Pack batch lane chưa có |
| P2-4 | Không validate `inputSchema` server-side trước handler |

---

## 8. Nguồn code chính

```text
packages/daemon/src/team/mcp.ts          # Team MCP
packages/daemon/src/spy-mcp.ts           # Spy MCP allowlist + schemas
packages/spy/src/mcp-tools.ts            # Full Spy tool catalog + handlers
packages/daemon/src/general-pack-mcp.ts  # General Pack MCP
packages/daemon/src/http.ts              # compose + /api/*/mcp discovery
packages/daemon/src/agents/index.ts      # per-adapter MCP config writers
docs/specs/003-external-writer-library-mcp/solution-design.md  # planned Library MCP
```

## 9. Cách tự kiểm tra nhanh khi daemon đang chạy

```bash
# health (không trả token)
curl -s http://127.0.0.1:4187/api/health | jq '{spyMcp, generalPackMcp, teamMcp}'

# lấy endpoint + token (local only)
curl -s http://127.0.0.1:4187/api/spy/mcp
curl -s http://127.0.0.1:4187/api/general-pack/mcp
curl -s http://127.0.0.1:4187/api/team/mcp

# tools/list (thay URL/TOKEN)
curl -s -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

*Generated from codebase review. Khi đổi allowlist/schema, cập nhật file này cùng PR.*
