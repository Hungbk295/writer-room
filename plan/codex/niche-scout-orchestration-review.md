# Niche-scout: coordination và quyết định thích ứng

Review ngày 2026-09-13. Đây là đề xuất thiết kế, chưa implement hay chạy research. Đã đối chiếu skill, mã nguồn Spy và danh sách tool của phiên Codex; chưa xác minh cấu hình MCP của từng Devin.

Khuyến nghị: Leader giữ quyền cấp việc và ngân sách; 5 Devin lấy các task nhỏ đã được duyệt từ shared filesystem. Mỗi tác vụ tốn tài nguyên phải có task ID, quyền sở hữu độc quyền và budget reservation trước khi gọi MCP. Phát hiện kênh chỉ tạo lead, không tự cấp quyền spy. Leader quyết định theo bằng chứng cần cho từng quyết định, không theo số Devin đã trả lời.

1. **Các hard gate phải sửa trước khi chạy**

- **Khả năng gọi tool chưa được xác minh.** `packages/spy/src/mcp-tools.ts:568` có `spy_quota_status`, discovery và candidates, nhưng `packages/daemon/test/spy-mcp.test.ts:85` kiểm tra allowlist chủ động loại các discovery mutations. Danh sách tool phiên Codex cũng thiếu chúng. Việc có implementation trong package không chứng minh Devin gọi được. Phase 0 phải kiểm tra tools/list và quyền của từng terminal; kiểm tra schema/dry-run, không dùng search thật để thử. Chọn endpoint/cấu hình đã được phép cung cấp các tool cần thiết; nếu thiếu thì báo capability gap, không âm thầm thay bằng tool khác có semantics/quota khác.
- **`max_queries` chưa phải hard cap.** `discovery.ts:85` dùng `Math.max(1, floor(maxQueries / markets.length))`: ví dụ 5 market, max_queries=2 vẫn lập ít nhất 5 query; `include_channel_search` có thể cộng thêm. Bắt buộc dry_run và kiểm `estimatedSearchCalls`, đóng băng niche config giữa preview và execute. Repair trong Spy: phân phối từ một ngân sách toàn cục và chặn tổng call trước thực thi. Trong khi chưa sửa, ưu tiên query tường minh qua discover_videos.
- **0 search không có nghĩa 0 tổng chi phí.** `expandGraph` gọi featured/subscriptions rồi enrich qua channels.list (`discovery.ts:213,284`). 1–2 general unit/seed chưa bao gồm enrich; discover_videos cũng có enrich. Dry-run graph hiện chỉ ước lượng phần seed. Phải ghi search/general riêng và không dùng ước lượng này như hard cap cho toàn operation.
- **Transcript có sẵn chưa có nghĩa công việc phân loại hoàn tất.** Sửa bước “skip video đã có transcript” thành “reuse transcript, chỉ skip phân loại khi đã có artifact hợp lệ cho cùng analysis version”. Kênh từng spy cũng chưa có nghĩa đủ date range, depth hoặc top_n của nhiệm vụ mới.

2. **Coordination tối thiểu: task queue + atomic claim + một người ghi quyết định**

Leader là người duy nhất ghi task definitions, thứ tự ưu tiên, scope version, quota grants và trạng thái accepted/rejected. Devin chỉ ghi claim qua helper và file tiến độ/kết quả của mình. Không có 5 agent cùng sửa claims.json hay cùng append một JSONL dùng chung.

Layout đề xuất:

```text
writer-room-data/research/_coord/<spy-instance>/
  claims/channel/<canonical-channel-id>/
  claims/query/<request-fingerprint>/
  claims/expand/<seed-and-options-fingerprint>/
  claims/analysis/<video-and-analysis-version>/

writer-room-data/research/<niche>/<run>/
  policy.json                       # Leader: scope, criteria, version, stop state
  tasks/<task-id>.json               # Leader: immutable task, inputs, budget grant
  workers/<dev>/status.json          # Devin: thay file bằng temp + rename
  events/<dev>/<event-id>.json        # Devin: immutable, sequence/attempt ID
  results/<task>/<attempt>/...
  accepted/<task>.json               # Leader: trỏ tới manifest đã kiểm tra
  budget.json                       # Leader: committed/reserved/unknown
  progress/...                      # Leader: evidence matrix + decisions
```

Claims đặt cùng namespace Spy instance để hai run dùng chung backend không cùng acquire một kênh. Hoàn thành task thuộc từng run; không giữ một cờ “done channel” vĩnh viễn để chặn refresh hợp lệ sau này. Query receipt cần thời hạn freshness; khóa request phải chứa effective arguments và phiên bản niche config. Dùng YouTube ID đúng hoa/thường, không lowercase ID và không khóa theo display name/URL alias.

Helper ngắn, chạy khi cần, không phải daemon:

```python
try:
    os.mkdir(claim_path)  # trực tiếp, không exists() rồi mới mkdir
except FileExistsError:
    return BUSY
# Chỉ người tạo thành công được ghi owner và gọi MCP.
```

Không dùng mkdir -p cho bước acquire: nó không phân biệt người thắng với người đến sau. POSIX quy định mkdir thất bại EEXIST khi path đã tồn tại: [Open Group mkdir](https://pubs.opengroup.org/onlinepubs/9799919799/functions/mkdir.html). Đọc/ghi shared FS mới là tiền đề; vẫn cần test cạnh tranh trên đúng filesystem mount, đặc biệt nếu là thư mục đồng bộ qua cloud.

Vòng đời: READY → CLAIMED → RUNNING → RESULT_READY → ACCEPTED; nhánh lỗi BLOCKED/UNKNOWN/CANCELLED. Publication dùng file tạm rồi rename cùng filesystem; RESULT_READY chỉ xuất hiện sau manifest hoàn chỉnh. Leader dedup event theo event_id và kết quả theo task_id + attempt. Task duplicate qua link không được chạy lại nếu claim/receipt cho attempt đã có.

Đơn vị ownership mặc định là **kênh**: một Devin thu metadata/transcript và phân loại các video của kênh đó, kể cả kênh thuộc nhiều keyword clusters. Không spy lại chỉ vì phát hiện qua query khác; merge provenance riêng. Khi thực sự cần chia một kênh lớn, Leader tách danh sách video rõ ràng và khóa analysis theo video/version; không đồng thời mở một task channel_start tổng quát và task fetch video con có thể chồng nhau.

Claims cho query/expand độc lập với claim spy kênh: claim query chỉ cho phép tìm kiếm, không cho phép spy mọi channel được trả về. Một task expand luôn có channel_ids tường minh, options, giới hạn seed và chỉ một hop; không dùng defaultSeeds toàn cục. Lead ngoài task → ghi leads kèm source query/seed, depth, lý do phù hợp → Leader duyệt thành task mới. Lead ngoài ranh giới research đã thống nhất → giữ lại, chỉ mở rộng sau khi có quyền đổi scope.

3. **Timeout, crash và giới hạn bảo đảm**

Không tự xóa claim khi heartbeat hết hạn. Agent có thể đang chờ tool, tạm ngừng hoặc mất message nhưng server vẫn spy. TTL chỉ đổi quan sát thành SUSPECT, không cấp quyền cho Devin khác.

Trước call ghi intent: task/attempt, tool, effective args hash, budget grant. Ngay khi tool trả operation ID thì lưu ID; sau mất kết nối ưu tiên get_status/manifest để reconcile hoặc resume. Nếu server đã nhận call nhưng client chưa ghi được ID, đánh dấu UNKNOWN, giữ reservation và không tự retry tác vụ tốn tài nguyên. Leader chỉ chuyển ownership sau khi chủ cũ xác nhận dừng và operation kết thúc/hủy, hoặc có bằng chứng tương đương. Lock tồn tại nhưng thiếu owner do crash giữa mkdir và ghi file cũng phải quarantine, không coi là free.

Generation token giúp từ chối kết quả cũ, nhưng **không ngăn lời gọi Spy từ agent cũ nếu backend không kiểm token**. Vì vậy file-only v1 ưu tiên tránh trùng và chấp nhận task bị chặn khi chưa rõ trạng thái. Không hứa exactly-once hoặc automatic failover an toàn. Nếu muốn cả hai, cần idempotency key/fencing được Spy thực thi, hoặc một gateway duy nhất thực sự kiểm mọi lần dispatch. Xem nguyên tắc request identifier khi retry: [AWS Builders’ Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

Tương tự, budget grant/claim chỉ là hard gate nếu helper bắt buộc đi qua hoặc tool gateway enforce; ghi câu “phải claim” trong prompt vẫn là cooperative protocol, không phải bảo đảm trước agent bypass.

4. **Leader turn-based: dùng message để kích hoạt, file để khôi phục**

Không cần event loop thường trực. Mỗi lần được đánh thức, Leader đọc tất cả event chưa xử lý, kiểm manifest, cập nhật evidence matrix/quota, cấp thêm task rồi kết thúc turn. File là nguồn trạng thái; link chỉ báo “có event mới tại path này”. Delivery acceptance của link không chứng minh Leader đã ingest kết quả.

Devin checkpoint sau mỗi đơn vị có ích: query hoàn tất, một kênh hoàn tất hoặc một lô video được phân loại. Ghi observed_at, task/attempt, operation_id nếu có, kết quả và nhu cầu cấp việc; sau đó gửi notification ngắn. Trong tool wait dài, dùng wait có giới hạn rồi checkpoint khi lấy lại quyền điều khiển. Không hứa heartbeat mỗi 60 giây khi agent đang bị chặn trong một call 15 phút.

Leader duyệt trước một backlog nhỏ gồm task READY, unique resource và budget đã giữ; Devin xong việc claim task kế tiếp theo priority/eligibility, không cần chờ câu trả lời mới. Chỉ nạp trước lượng công việc đủ che độ trễ Leader; khởi điểm một task tiếp theo mỗi worker là tham số vận hành, điều chỉnh bằng thời gian task và độ trễ phản hồi. Không giao 20 search dự phòng rồi mới phân tích.

Policy version và stop flag được kiểm tra trước mỗi task/call mới; không làm mất kết quả operation đã chạy. Sửa kế hoạch bằng policy version mới và supersede task chưa bắt đầu, không sửa ngầm task input đang chạy. Quyền ngân sách đã cấp chỉ thu hồi/tái cấp sau khi biết worker chưa dùng hoặc đã trả lại.

Nếu hết việc đã duyệt, Devin gửi NEED_WORK rồi idle. Idle hợp lý hơn đốt quota để giữ 5 terminal bận. Nếu mọi agent ngừng gửi message, Leader không thể tự tỉnh dậy chỉ nhờ một deadline trong JSON: timer wake-up cần scheduler bên ngoài. Với ràng buộc hiện tại, kiểm deadline tại lần checkpoint/message kế tiếp và ghi rõ giới hạn phát hiện trễ; không thiết kế như đang có scheduler.

5. **Bỏ ngưỡng 3/5: readiness thuộc từng quyết định**

Một Devin có thể đem về dữ liệu của 8 kênh; 5 Devin có thể chỉ lặp một cụm kênh. Số worker hoàn tất không đo được độ phủ hay mức độc lập của nguồn.

Mỗi cluster/cell ngôn ngữ × chủ đề × date range đã chốt cần ledger:

- số video unique đạt criteria, số channel unique, phân bố video giữa các channel;
- transcript có sẵn/thiếu, số artifact phân loại đã kiểm, provenance/quote/locator;
- nguồn tiếp cận: corpus, graph, direct search; query families/seed đã thử;
- evidence accepted, evidence pending và thiếu hụt đối với target;
- tỷ lệ kết quả mới đạt chuẩn, duplicate, loại ngoài scope, lỗi kỹ thuật và chi phí/thời gian theo action.

Readiness là đáp ứng điều kiện của quyết định cụ thể, không lấy một coverage % trung bình che cluster trống. Target về số kênh/video là tiêu chí đủ dùng cho báo cáo, không phải chứng minh thống kê toàn niche.

**React ngay:** merge bằng chứng hợp lệ; reuse transcript; cấp một kênh đã duyệt chưa xử lý; sửa record sai; thử một query nhỏ nhằm lấp cell trống khi budget sẵn. Không cần đợi dữ liệu từ cluster không liên quan.

**Phân tích sâu phần đã đủ:** đối chiếu các kênh hiện có, nêu rõ “quan sát trong N video/M kênh”, chưa suy rộng thành phổ biến toàn niche. Có thể làm từ kết quả đầu tiên nếu chính kết quả đó đủ đa kênh. Một nghi vấn/chất lượng nguồn hoặc cơ hội thay đổi task tiếp theo cũng có thể kích hoạt phân tích ngay.

**Chờ để cam kết lớn:** khi kết quả pending có khả năng đổi quyết định đổi scope, tiêu phần lớn search còn lại, loại cluster hoặc chốt COMPLETE. Trong lúc chờ, chạy các task hữu ích trong mọi kịch bản hợp lý. Không chờ cả 5 nếu chỉ task của dev-4 liên quan tới quyết định đó.

Ví dụ: dev-1 xong 30 video cùng một kênh → chưa đủ nhận xét cross-channel; vẫn có thể cấp kênh thứ hai. Dev-2 mang về 10 video từ 4 kênh của cluster B → có thể phân tích B ngay dù ba Devin khác chưa xong. Chưa được đóng cluster A nếu dev-4 đang xử lý nguồn có thể làm thay đổi keyword map A.

Ưu tiên task theo thứ tự dễ audit: lấp cell bắt buộc còn trống → thêm kênh/nguồn tiếp cận còn thiếu → xử lý nghi vấn bằng chứng → mở rộng theo yield quan sát. Yield dùng **unique qualified evidence mới phục vụ gap**, không dùng raw hits hay số transcript đã tải. Ghi denominator và độ thiếu chắc chắn khi sample ít; đừng dùng điểm số trông chính xác nhưng weights tùy hứng. Dành một phần budget được chốt trước cho query families chưa thử để tránh chỉ đào nhánh đang có yield tốt.

6. **Phân vai bốn search tools**

| Tool | Ai quyết định / ai thực hiện | Khi dùng và giới hạn |
|---|---|---|
| corpus_videos | Leader chỉ định cell/channel, mọi Devin đọc được | Bước đầu và trước fetch. Paginate, kiểm freshness/sampling. Có transcript → đọc và phân loại; thiếu transcript → fetch task có owner. Corpus hit không tự thành coverage accepted. |
| expand_graph | Leader chọn seed/options; Devin bất kỳ nhận task | Khi có seed phù hợp và cần kênh bổ sung. Một hop, explicit IDs, claim seed/options/freshness; chỉ đưa lead về queue. Dừng nhánh khi yield thấp; không coi graph rỗng/ẩn subscriptions là niche hết nguồn. |
| discover_videos | Leader chọn query/effective filters/order và grant; Devin nhận task | Mặc định để gieo seed cho cluster trống, kiểm nhánh mới, hoặc vượt khỏi cụm graph hiện tại. Một query mỗi task để kiểm soát ngân sách và thích ứng. Search language chỉ là tín hiệu tìm kiếm; kết quả vẫn phải kiểm criteria thực tế. |
| discover_channels | Leader quản niche matrix; một Devin được chỉ định thực hiện batch | Bootstrap rộng khi corpus/seed thiếu, hoặc quét matrix có mục đích rõ. Dry-run bắt buộc; pin config; mở rộng plan thành từng request fingerprint trong ledger để tránh trùng với discover_videos. Không cho 5 Devin cùng gọi cùng matrix. |

Không cố định một Devin chỉ làm discovery suốt run; vai trò theo task, giữ cả 5 có thể thu/đọc/phân loại. Leader không cần trực tiếp có Spy mutations nếu một Devin được giao dry-run/status/execution. Chỉ Leader quyết định sửa niche.json vì nó ảnh hưởng input ngầm của discovery.

Thứ tự thông thường corpus → graph từ seed tốt → direct search cho gap, nhưng **không bắt buộc vét hết graph trước khi search**. Graph gần một cụm kênh có thể nghèo đa dạng; cluster trống có thể cần search ngay. Chỉ dùng discover_channels khi lợi ích batch lớn hơn khả năng kiểm soát của query tường minh. Fingerprint request bao gồm type, query, region/language, order, date, duration, maxResults và config version; không dedup chỉ theo chuỗi keyword. Giữ provenance của các query khác nhau dù chúng trả cùng một channel.

7. **Quota: reservation trung tâm, trạng thái backend để đối chiếu**

`spy_quota_status` đã có trong source; yêu cầu endpoint expose cho Leader hoặc một Devin lấy snapshot kèm timestamp/reset. Nó không cần được hỏi riêng từ cả 5 agent. Search results cũng trả quota snapshot. Availability của tool vẫn phải qua gate ở mục 1.

Giữ trần run theo yêu cầu 100 search/ngày và 10.000 general unit/ngày; đọc số thực sự còn lại, không cấp lại toàn bộ mức trần lúc bắt đầu run. Mỗi task có search_reserved, general_reserved/estimate, actual nếu truy được, quota_day và grant_id. Không double allocate giữa run; budget ledger ở cấp Spy instance/day khi nhiều run chung quota.

Trong ledger run: committed + outstanding reservations + unknown exposure phải nằm trong budget run được cấp. Trước cấp thêm dùng backend remaining mới nhất và trừ exposure chưa reconcile; conservative double-count tạm thời chấp nhận được, cộng trùng quota để tăng availability thì không. Không lấy hiệu số hai global snapshots làm “chi phí dev-2” nếu xen giữa có call từ worker/tick khác. `quota-coordinator.ts` cũng ghi rõ rủi ro delta accounting này; lease trong process không phải lock ownership xuyên Devin.

Search token được dành trước dispatch. Timeout sau gửi call → token UNKNOWN/giữ lại, không hoàn tiền chỉ vì client thấy lỗi. discover_channels reserve theo plan dry-run thực tế, không theo max_queries. General budget cần headroom cho enrich; nếu phải enforce cap nhỏ hơn cap backend một cách tuyệt đối thì Spy/gateway phải kiểm từng charge, bởi orchestrator không thể chặn giữa nội bộ một opaque MCP call.

Task chưa chạy qua quota reset phải xin grant phù hợp ngày mới; không tự biến grant ngày cũ thành credit mới. Dùng quota_day/reset do backend cung cấp. Những tác nhân ngoài protocol vẫn có thể tiêu quota: quota_status là snapshot, không phải reservation; nếu chúng cùng chạy thì bảo đảm run budget chỉ áp dụng cho tác nhân có tuân thủ, backend vẫn là nơi chặn giới hạn chung.

8. **Điều kiện dừng và repair notes cho skill**

COMPLETE chỉ khi tất cả cell bắt buộc đạt tiêu chí bằng accepted evidence, kiểm nguồn qua gate và mọi operation còn liên quan đã được settle hoặc hoãn với tác động được giải quyết. Pending result có thể đổi kết luận thì chưa chốt báo cáo cuối.

PARTIAL khi hết budget/deadline, chưa đạt target, thiếu capability hoặc frontier đã thử không còn yield. Nêu rõ phạm vi đã thử, giới hạn top_n/phân trang, cell thiếu và kết quả pending. Không dùng “đã khám phá toàn bộ niche” hoặc “hết video đạt chuẩn” chỉ từ vài query/graph và 5 EXHAUSTED. EXHAUSTED chỉ đúng cho bounded task; lỗi/thiếu quota/thiếu transcript là trạng thái riêng. Dừng bão hòa phải dựa trên các nguồn độc lập trong phạm vi đã duyệt và ngưỡng yield được ghi trước, không chứng minh hết toàn YouTube.

Sửa cụ thể trong SKILL.md:

- Dedup: thay “Query Spy DB là đủ” bằng phân biệt data reuse, work claim và analysis receipt.
- Assignment: thêm task/attempt, channel ownership, allowed tools/args, policy version, budget grant, checkpoint, điều kiện dừng; bỏ quyền tự đuổi lead ngoài assignment.
- Result: tách execution_status, frontier_status, stop_reason; thêm operation/request receipts, lead provenance, manifest và coverage counts.
- Leader: thay round barrier bằng READY queue + evidence matrix + decision-specific readiness; round chỉ còn là snapshot báo cáo.
- Prerequisites: schema/capability check, quota status, atomic filesystem contention test; cập nhật đúng tool inventory endpoint thực tế.
- Termination: dùng COMPLETE/PARTIAL theo bằng chứng hữu hạn; settle UNKNOWN trước retry và không giải phóng claim theo TTL.

Acceptance scenarios cho implementation: 5 processes tranh cùng claim chỉ 1 thắng; crash sau acquire nhưng trước owner không mở khóa tự động; mất response sau Spy accept không tạo call thứ hai; duplicate/out-of-order event không double-count; 2 query trả cùng kênh chỉ 1 spy task; transcript có sẵn vẫn được phân loại; 5 market/max_queries=2 bị gate khi plan vượt grant; worker trả chậm vẫn tiếp tục READY backlog hữu ích; quota reset/unknown consumption không tạo credit giả; tool missing và nguồn lỗi không thành EXHAUSTED.
