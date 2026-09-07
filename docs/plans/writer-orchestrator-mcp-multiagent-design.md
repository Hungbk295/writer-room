# Design — Writer Orchestrator MCP + Multiagent Writer/Editor

> Ngày: 2026-09-06  
> Căn cứ: lượt E2E thật `cf00d032-1e13-4efe-9645-2dac9d2bd14a` (Spy Anh Ba → Writer v2 → restyle Sói); pain PTY `spawnTurn` miss; fit analysis 1DevTool Pipeline/Team vs Writer Room domain.  
> Trạng thái: **DESIGN** — chưa triển khai.  
> Mục tiêu: MCP chạy đúng nhịp Writer vừa chứng minh, với Writer và Editor là agent multiagent thật (substrate headless ổn định), vẫn giữ Writer Room làm source of truth nghiệp vụ.

---

## 0. Tóm tắt một dòng

```text
Caller MCP
  → Writer Orchestrator (domain: pack/formula/hook/gate/settle/restyle)
  → Agent Substrate (1DevTool Pipeline/Team headless HOẶC Writer harness headless fallback)
  → Claude (writer) · Codex (editor)
```

**Luật:** Domain + artifact + gate thuộc Writer Room. Việc “mở CLI và chờ xong” thuộc substrate multiagent. UI/PTY là optional viewer, không phải điểm sống còn của pipeline.

---

## 1. Bài toán & outcome kinh doanh

### Current state
- Writer v2 đã có đủ stage: hook → STUDY → WRITE → gate → EDIT → REPAIR → DONE → restyle.
- Agent đã tách `agentId` (writer) / `editorAgentId` (editor) qua `LaneScheduler` + `TeamWorkflow`.
- Điểm yếu vận hành đã đo trên lượt thật:
  1. UI miss `spawnTurn` → stage treo dù assignment đã có.
  2. Hook suggest session kẹt → phải recover tay.
  3. Repair/restyle fail `DRAFT_LENGTH` / `AGENT_SANDBOX_VIOLATION` / `RESTYLE_LENGTH`.
  4. Không có MCP end-to-end cho cả nhịp; caller phải gọi HTTP lẻ + tự cứu PTY.

### Expected state
- Một MCP surface cho phép caller (Grok/Claude/Codex/UI) chạy **một lượt Writer đầy đủ** bằng tool calls.
- Writer và Editor là **hai agent riêng**, giao việc theo Pipeline; Editor chỉ chạy sau WRITE (+ gate).
- Substrate chạy agent **không phụ thuộc** Tauri SSE bridge đang mở.
- Mọi stage vẫn pin pack/formula/generalPack hashes; gate deterministic vẫn là hard gate.

### Gap
Thiếu lớp **Writer Orchestrator MCP** + **headless multiagent substrate** gắn vào settle machine hiện có.

### Impact nếu không làm
Mỗi lượt E2E vẫn cần người/agent điều phối thủ công; miss PTY lặp lại; chi phí recover cao; khó chuẩn hóa “một nút chạy xong”.

### Recommendation
Làm MCP orchestrator theo nhịp đã chứng minh; dùng pattern **1DevTool Pipeline + Team** cho substrate; **không** thay Writer Room domain bằng 1DevTool thuần.

---

## 2. Phạm vi

### In scope
1. Writer Orchestrator MCP (tools + state machine + wait/status).
2. Mapping 1:1 sang Writer v2 HTTP/daemon APIs hiện có (không viết pipeline thứ hai).
3. Agent substrate multiagent:
   - Writer stages: STUDY / WRITE / REPAIR / RESTYLE → agent writer.
   - Editor stage: EDIT_REVIEW → agent editor.
4. Headless-first execution + optional live terminal khi user bật.
5. Recovery contracts: retry schema, length band, sandbox violation, restyle length.
6. Acceptance E2E: một run tương đương `cf00d032…` (Spy title → DONE + restyle).

### Out of scope (v1)
- Viết lại formula/training lab.
- Thay deterministic gate bằng LLM judge.
- Swarm N writer song song trên cùng title.
- Mesh đàm phán style giữa nhiều kênh.
- MySQL migration / UI redesign lớn.
- Tự động publish YouTube.

### Non-goals
- 1DevTool trở thành source of truth cho facts/gate.
- Editor chạy song song Writer.
- Một agent đóng cả writer lẫn editor trong một process.

---

## 3. Nguyên tắc thiết kế

| # | Nguyên tắc | Hệ quả |
|---|---|---|
| P1 | Writer Room = domain SoT | Pack, formula, ledger, gate, run JSON chỉ do daemon sở hữu |
| P2 | Substrate = execution only | 1DevTool/Team chỉ spawn CLI, trả artifact path / exit |
| P3 | Pipeline trước Team | Chuỗi stage cố định; Team chỉ để tách role writer/editor |
| P4 | Headless-first | Mặc định không cần UI; PTY chỉ khi `substrate=terminal` |
| P5 | Artifact-before-advance | Không stage kế nếu `out/result.json` chưa validate |
| P6 | Idempotent tools | `start` có idempotency key; `wait` an toàn gọi lại |
| P7 | Fail closed on facts | Gate đỏ → REPAIR hoặc FAILED_GATE; không “bỏ qua cho xong” |
| P8 | Restyle ngoài hard gate | Restyle không ghi đè `finalScript`; A/B style qua `styled/vN.md` |

---

## 4. Luồng nghiệp vụ mục tiêu (nhịp chuẩn)

Tham chiếu lượt thật `cf00d032-1e13-4efe-9645-2dac9d2bd14a`.

```text
[0] Spy (optional, riêng Spy MCP)
    spy_channel_start → spy_wait → spy_run_manifest
    chọn title (rank_by=views, nêu scanned count)

[1] Bootstrap
    đảm bảo channel profile + editorial notebook
    create post DRAFT
    PUT config: channelId, title, brief, audience,
                packId, generalPack, formulaId,
                agentId=claude, editorAgentId=codex, targetWords

[2] Hook pre-write
    hook/clarify → answers → hook/suggest → score → hook/selection
    Chưa chọn hook → không Run

[3] Run room
    POST .../run
    STUDY (writer) → WRITE (writer) → deterministic gate
      ├─ pass → DONE (hiếm khi sạch 100% lần đầu)
      └─ fail → EDIT_REVIEW (editor) → REPAIR (writer) → gate lại
           ├─ pass → DONE
           └─ fail → FAILED_GATE / FAILED (người quyết)

[4] Restyle (optional, ngoài pipeline cứng)
    POST .../restyle { styleId: soi-tai-chinh.md }
    ghi styled/vN.md + exports/.../styled-vN.md
    writer:regate (báo cáo, không chặn)
```

### Gap STUDY (ví dụ từ lượt thật)
> Không video nào đưa bộ lọc phân biệt hai loại “ít cạnh tranh”:  
> (A) rào cản khách trả tiền để vượt, vs (B) rào cản người làm phải trả bằng sức khỏe/vốn con người.

Orchestrator **không** tự bịa gap; gap thuộc artifact STUDY của writer agent.

---

## 5. Kiến trúc tổng thể

```text
┌─────────────────────────────────────────────────────────────┐
│ Caller (Grok / Claude / UI / script)                        │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP tools/call
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Writer Orchestrator MCP                                     │
│  packages/daemon/src/writer-orchestrator-mcp.ts (proposed)  │
│  - state machine per runId                                  │
│  - maps tools → existing writer-run-v2 / hook-board APIs    │
│  - chooses substrate per stage                              │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
                │ domain mutate               │ spawn stage work
                ▼                             ▼
┌──────────────────────────┐    ┌──────────────────────────────────┐
│ Writer Room Daemon       │    │ Agent Substrate Adapter          │
│ - run-store-v2           │    │  A) 1DevTool Pipeline/Team       │
│ - deterministic-gate     │    │     headless (preferred v1)      │
│ - LaneScheduler settle   │    │  B) Writer TeamWorkflow headless │
│ - Spy / packs / formulas │    │     fallback (no PTY required)   │
└──────────────────────────┘    └───────────────┬──────────────────┘
                                                │
                                ┌───────────────┴───────────────┐
                                ▼                               ▼
                         Claude (writer)                  Codex (editor)
                         STUDY/WRITE/                     EDIT_REVIEW
                         REPAIR/RESTYLE
```

### Quan hệ với harness hiện có
- **Giữ:** `writer-run-v2.ts`, `hook-board.ts`, `deterministic-gate.ts`, `run-store-v2.ts`, Spy MCP.
- **Thêm:** MCP facade + substrate adapter + recovery policies.
- **Không làm:** pipeline song song thứ hai với schema khác.

---

## 6. State machine

### 6.1 Run-level states (expose qua MCP)

| State | Ý nghĩa | Ai được gọi tiếp |
|---|---|---|
| `BOOTSTRAP` | Đang tạo/cấu hình post | `writer_configure` |
| `HOOK_CLARIFY` | Đang hỏi làm rõ title | `writer_hook_answer` / wait |
| `HOOK_SUGGEST` | Đang gợi ý hook | wait → `writer_hook_select` |
| `HOOK_READY` | Đã chọn hook | `writer_run_start` |
| `RUNNING_STUDY` | Writer STUDY | wait |
| `RUNNING_WRITE` | Writer WRITE | wait |
| `GATE` | Deterministic gate | automatic |
| `RUNNING_EDIT` | Editor EDIT_REVIEW | wait |
| `RUNNING_REPAIR` | Writer REPAIR | wait |
| `DONE` | `finalScript` chốt | `writer_restyle` optional |
| `FAILED` / `FAILED_GATE` | Dừng có lý do | `writer_continue` / human |
| `RESTYLING` | Restyle in-flight | wait |
| `STYLED` | Có ≥1 `styled/vN` | xong |

Mapping nội bộ sang `WriterRunV2.status/phase` hiện có; MCP state là projection ổn định cho caller.

### 6.2 Stage advance rules

```text
advance(stage) iff:
  1. out/result.json exists
  2. schema validator for stage passes
  3. (WRITE/REPAIR) word band OK
  4. (WRITE/REPAIR) beatAnchors exact substrings
  5. (after WRITE/REPAIR) gate runs
       - pass → DONE (or next editorial policy)
       - fail → EDIT then REPAIR (one repair round default)
  6. no AGENT_SANDBOX_VIOLATION on settled files
```

### 6.3 Recovery matrix (từ pain thật)

| Lỗi | Policy v1 |
|---|---|
| `spawnTurn` miss / no process | Substrate headless tự spawn; không chờ UI |
| Hook suggest stall > N min | Interrupt turn → optional rewrite candidates → `turn/complete` nếu artifact hợp lệ |
| `DRAFT_LENGTH` | Retry cùng stage, prompt ép band; max 2 retries |
| `AGENT_SANDBOX_VIOLATION` | Reject artifact ngoài `itemRunDir`; retry freshContext |
| `RESTYLE_LENGTH` | Retry restyle; không đụng `finalScript` |
| Gate fail sau 1 REPAIR | `FAILED_GATE` + trả violations; không tự vòng vô hạn |
| Daemon restart mid-stage | Dùng `recoverInterrupted*` hiện có + MCP `writer_run_recover` |

---

## 7. MCP tool surface (proposed)

Endpoint discovery (giống Spy):

```http
GET /api/writer/mcp  →  { url, token }
```

Server name đề xuất: `writer-room-writer` (song song `writer-room-spy`).

### 7.1 Catalog

| Tool | Role | Input chính | Output |
|---|---|---|---|
| `writer_health` | readiness | — | daemon/spy/agents/substrate |
| `writer_bootstrap` | tạo channel+post nếu thiếu | channelId?, displayName?, defaults | postId |
| `writer_configure` | PUT post | postId, title, brief, packId, formulaId, … | post projection |
| `writer_hook_clarify` | start clarify | postId | generatingHook |
| `writer_hook_answer` | answers → suggest | postId, answers[] | generatingHook |
| `writer_hook_candidates` | đọc candidates + scores | postId | scored list |
| `writer_hook_select` | chọn hook | postId, selectedId \| strategy=`highest_score` | selectedHook |
| `writer_run_start` | POST run | postId | run projection |
| `writer_wait` | chờ state/terminal | postId/runId, until, timeoutSec | status snapshot |
| `writer_status` | đọc tiến độ | postId/runId | full projection + progress% |
| `writer_continue` | continue FAILED WRITE/… | runId | run |
| `writer_restyle` | restyle | runId, styleId | styled meta |
| `writer_get_script` | lấy final/styled | runId, version? | markdown |
| `writer_run_e2e` | **convenience** một shot | title, packId, formulaId, styleId?, hookStrategy | runId + final paths |

### 7.2 `writer_run_e2e` (nhịp “một lệnh”)

Defaults khớp lượt thật:

```jsonc
{
  "title": "…",
  "channelId": "soi-tai-chinh",
  "packId": "<source-pack-uuid>",
  "generalPack": "hieu-tv.md",
  "formulaId": "<anh-ba-formula-uuid>",
  "agentId": "claude",
  "editorAgentId": "codex",
  "targetWords": 1200,
  "hookStrategy": "highest_score",   // crisis-by-hour weighted for nghề
  "hookAnswers": "auto",             // trả lời clarify theo brief/audience
  "styleId": "soi-tai-chinh.md",     // optional; null = skip restyle
  "substrate": "headless",           // headless | terminal
  "idempotencyKey": "…"
}
```

Hành vi:
1. Bootstrap/configure nếu cần.
2. Clarify → auto answers → suggest → select theo `hookStrategy`.
3. Run đến `DONE` hoặc `FAILED*`.
4. Nếu `styleId` và DONE → restyle → trả path export.
5. Mọi bước ghi audit + `progressPercent`.

### 7.3 Scoring hook (chuẩn hóa từ lượt thật)

Input: candidates từ `hook-suggest-v1`.  
Weights mặc định cho topic **Nghề nghiệp** (thư viện Anh Ba K1):

| type | weight |
|---|---|
| `crisis-by-hour` | 5.0 |
| `street-paradox` | 4.0 |
| `stat-open` | 3.5 |
| `forked-paths` | 3.0 |
| `direct-question` | 2.0 |
| `personal-recall` | 1.5 |

Cộng điểm: sensory tokens, có số, độ dài 40–280 ký tự, person anchor; trừ greeting.  
`hookStrategy=highest_score` chọn argmax; vẫn cho phép `selectedId` tay.

---

## 8. Multiagent substrate design

### 8.1 Mapping pattern 1DevTool → Writer

| Writer need | 1DevTool pattern | Cách dùng |
|---|---|---|
| Chuỗi stage cố định | **Pipeline** | STUDY→WRITE→EDIT→REPAIR→(RESTYLE) |
| Writer ≠ Editor | **Team** (2 members) | role `writer` / `editor`, prompt khác nhau |
| Fan-out giả thuyết | Swarm | **Không** dùng ở v1 core loop |
| Đàm phán style | Mesh | Optional sau v1 (A/B style) |

### 8.2 Stage → agent binding

| Stage | Agent role | Template id | Session group |
|---|---|---|---|
| hook-clarify / hook-suggest | writer | `claude` | `writer-v2-hook` |
| study-v2 | writer | `claude` | `writer-v2` |
| write-v2 | writer | `claude` | `writer-v2` |
| edit-review-v2 | editor | `codex` | `writer-v2-edit` |
| repair-v2 | writer | `claude` | `writer-v2` |
| restyle-v1 | writer (or style agent) | `claude` | `writer-v2-restyle` |

Editor **không** được gọi ở STUDY/WRITE. Writer **không** tự chấm EDIT_REVIEW.

### 8.3 Substrate adapter interface

```ts
interface StageSpawnRequest {
  runId: string;
  stage: string;
  attempt: number;
  agentTemplateId: 'claude' | 'codex' | string;
  itemRunDir: string;          // absolute cwd with prompt.md + input/
  assignmentText: string;      // exact inject/task line
  wordBand?: { min: number; max: number };
  timeoutSec: number;
  substrate: 'headless' | 'terminal';
  freshContext: boolean;
}

interface StageSpawnResult {
  substrateRunId: string;      // 1devtool runId or team turnId
  ok: boolean;
  exitCode?: number;
  artifactPath?: string;       // .../out/result.json
  errorCode?: string;
}
```

**Preferred implementation v1:** wrap `1devtool-agent` Pipeline/Team headless:
- Writer pipeline steps call `--to=claude` (or configured writer).
- Edit step calls `--to=codex`.
- `cwd` = `itemRunDir`.
- Prompt stdin = assignment + “write only out/result.json then exit”.

**Fallback:** extend Writer `TeamWorkflow` with forced headless path (no `interactiveRequired`), reuse adapters `buildHeadlessTurn`.

### 8.4 Vì sao không để 1DevTool làm SoT

1DevTool không có:
- `factsLedger` verbatim checks  
- deterministic numeric/proper-noun gate  
- pack/formula hash pins  
- `FAILED_GATE` vs craft defects  

→ 1DevTool chỉ được phép trả lời “process xong / fail”; daemon quyết advance.

---

## 9. Contracts artifact theo stage

Giữ schema hiện có; MCP không invent schema mới.

| Stage | Artifact | Validator |
|---|---|---|
| hook-clarify | `{ questions: string[1..4] }` | `validateClarifyOutput` |
| hook-suggest | `{ candidates: HookCandidate[3..5] }` | `validateSuggestOutput` |
| study-v2 | coverageMap + gap + outline + factsLedger | `validateStudyArtifact` |
| write-v2 / repair-v2 | title, script, outlineChanges, beatAnchors, coinedLabels | `validateWriterV2Draft` + gate |
| edit-review-v2 | `{ defects: [{quote,severity,note}] }` | quote ⊆ script |
| restyle-v1 | `{ title, script }` | `validateRestyleOutput` |

Band mặc định từ `targetWords` (±20%), ví dụ 1200 → 960–1440.

---

## 10. Sequence (E2E happy path)

```text
Caller                Writer MCP                 Daemon                  Substrate
  │                      │                         │                        │
  │ writer_run_e2e       │                         │                        │
  │─────────────────────►│ bootstrap/configure     │                        │
  │                      │────────────────────────►│                        │
  │                      │ hook clarify            │                        │
  │                      │────────────────────────►│ spawn writer            │
  │                      │                         │───────────────────────►│
  │                      │◄──────── result.json ───│◄────── done ───────────│
  │                      │ hook suggest/select     │                        │
  │                      │ run_start               │                        │
  │                      │ STUDY                   │ spawn writer            │
  │                      │                         │───────────────────────►│
  │                      │ WRITE                   │ spawn writer            │
  │                      │                         │───────────────────────►│
  │                      │ gate                    │ (local, no LLM)        │
  │                      │ EDIT (if fail)          │ spawn editor            │
  │                      │                         │───────────────────────►│
  │                      │ REPAIR                  │ spawn writer            │
  │                      │                         │───────────────────────►│
  │                      │ gate → DONE             │                        │
  │                      │ restyle                 │ spawn writer            │
  │                      │                         │───────────────────────►│
  │◄──── runId, paths ───│                         │                        │
```

---

## 11. API / file layout đề xuất

```text
packages/daemon/src/
  writer-orchestrator-mcp.ts          # MCP server (như spy-mcp.ts)
  writer/
    orchestrator-projection.ts        # map WriterRunV2 → MCP state
    hook-score.ts                     # highest_score strategy
    substrate/
      types.ts
      adapter.ts                      # interface
      onedevtool-adapter.ts           # Pipeline/Team headless
      harness-headless-adapter.ts     # fallback TeamWorkflow headless
packages/daemon/test/writer/
  orchestrator-mcp.test.ts
  hook-score.test.ts
  substrate-onedevtool.test.ts        # mock CLI
docs/plans/
  writer-orchestrator-mcp-multiagent-design.md   # file này
```

HTTP:

```text
GET  /api/writer/mcp
# MCP tools/call trên ephemeral loopback + bearer (giống Spy)
```

---

## 12. Phases triển khai

| Phase | Deliverable | Acceptance |
|---|---|---|
| **A — MCP facade** | `writer_status/configure/hook_*/run_start/wait/restyle` gọi HTTP nội bộ | Test MCP không cần agent thật (stub settle) |
| **B — Headless harness fallback** | Stage spawn không cần UI `spawnTurn` | STUDY+WRITE pass trên máy không mở Tauri window |
| **C — 1DevTool substrate** | Adapter Pipeline/Team headless | Cùng E2E dùng `--to=claude/codex` |
| **D — `writer_run_e2e`** | One-shot + hookStrategy + optional restyle | Lặp được nhịp `cf00d032…` với Spy title mới |
| **E — Hardening** | Recovery matrix + metrics + docs operator | Failures có errorCode ổn định; continue/recover documented |

Thứ tự bắt buộc: **A → B → D** tối thiểu shippable; C song song hoặc ngay sau B nếu 1DevTool là substrate chính.

---

## 13. Acceptance criteria (đo được)

### Functional
1. `writer_run_e2e` với title Spy + pack + formula Anh Ba → `DONE` trong một session caller.  
2. Hook chọn `highest_score` khớp ranking type weights đã chốt.  
3. STUDY artifact có đủ coverageMap cho mọi `videoId` pack + gap non-empty + ledger ≥ 3.  
4. WRITE/REPAIR trong word band; `beatAnchors` exact substring.  
5. Editor stage tạo defects với quote verbatim; writer repair chỉ sửa defects/gate.  
6. Gate pass trước DONE; `finalScript` không bị restyle ghi đè.  
7. Restyle tạo `styled/v1.md` + export path; `writer:regate` chạy được.

### Operational
8. Tắt UI Tauri vẫn chạy xong (headless).  
9. Kill agent giữa WRITE → `writer_continue` hoặc recover không mất STUDY.  
10. Mọi response MCP nêu `runId`, `state`, `stage`, `errorCode` (nếu có), không claim DONE khi chưa DONE.

### Non-functional
11. Idempotency key tránh double-run.  
12. Timeout từng stage cấu hình được; mặc định đủ cho opus/codex thật (STUDY/WRITE ~15–45 phút).

---

## 14. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| 1DevTool CLI đổi flag/manifest | High | Adapter isolate; contract test với `--json` |
| Headless thiếu MCP team tools | High | Embed absolute paths in assignment (đã chứng minh trên lượt thật) |
| Forbidden host names tokenize quá vụn | Medium | Giữ validator hiện có; không siết thêm ở MCP |
| Auto hook answers kém | Medium | Cho `hookAnswers` explicit; `auto` chỉ default |
| Chi phí model (opus+codex) | Medium | Cho phép đổi model qua agent config; không hardcode trong MCP |
| Caller tưởng Swarm nhanh hơn | Low | Docs: Swarm = out of scope core loop |

---

## 15. Quyết định cần chốt trước code

1. **Substrate mặc định v1:** `onedevtool-headless` hay `harness-headless`?  
   - Đề xuất: **harness-headless trước (Phase B)** để ít dependency; thêm 1DevTool ở Phase C.  
2. **Restyle agent:** cùng writer template hay agent riêng `style`?  
   - Đề xuất: cùng writer template + style file (như hiện tại).  
3. **`writer_run_e2e` có gọi Spy không?**  
   - Đề xuất: **không** — Spy giữ Spy MCP; e2e nhận `title` đã chọn (tránh trộn quota YouTube).  
4. **Max repair rounds:** 1 (hiện tại) hay 2?  
   - Đề xuất: giữ **1** để không đốt budget; FAILED_GATE cho người.

---

## 16. Appendix — Map sang lượt thật `cf00d032…`

| Bước design | Việc đã làm trên lượt thật |
|---|---|
| Spy | `spy_channel_start` Anh Ba, run `9a1067aa…`, 60 videos by views |
| Title | 10 Nghề LÃI CAO ít Cạnh Tranh… |
| Pack / formula | `5be39d78…` / `e2ce1143…` Anh Ba |
| Hook | clarify → suggest recover → select `h1` crisis-by-hour (74) |
| STUDY/WRITE/EDIT/REPAIR | Claude writer + Codex editor; nhiều lần headless recover vì miss PTY |
| DONE | gate pass, 1438 words |
| Restyle Sói | `soi-tai-chinh.md` → styled v1 1435 words + export |

Design này **đóng gói đúng nhịp đó** thành MCP + multiagent ổn định, thay vì điều phối tay.

---

## 17. Status

| Hạng mục | Status |
|---|---|
| Fit 1DevTool Pipeline/Team | **PASS** (substrate) |
| Thay Writer domain bằng 1DevTool | **FAIL** (non-goal) |
| Design MCP orchestrator | **READY TO IMPLEMENT** sau khi chốt §15 |
| Implementation | **NOT STARTED** |

**Overall: CONDITIONAL PASS** — đủ để triển khai Phase A/B ngay khi chốt 4 quyết định §15.
