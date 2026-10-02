# STATUS

Trạng thái theo mục 8 của SPEC.md. Cổng chặn vẫn là con số trong CLAUDE.md, chỉ đổi bằng tay.

| Bước | Nội dung | Trạng thái | Ngày |
|---|---|---|---|
| 1 | Schema, luật, UI port, nạp tay | Xong, dùng thật 2 ngày | 2026-09-14 |
| 2 | `detect-ats.js` + `ats.js` + `pull.js` + tự kéo sau 12 giờ + Kéo ngay | **Xong** | 2026-09-16 |
| 3 | `imap.js` + parser bằng Claude | **Xong**, đã kéo thật 11 mail LinkedIn | 2026-09-17 |
| 3b | Phản hồi: `jobs.outcome` + thùng sau khi nộp · `replies.js` · tab Phản hồi + aliases | **Xong**, chưa kéo thật qua Claude | 2026-10-01 |
| 4 | `tmt.js` | Chưa | |
| 5 | `enrich.js` + tab fit trong Hàng đọc | **Đang làm**: lõi + kiểm xong (1/2), API + UI còn lại | 2026-10-02 |
| 6 | Cron + bảng theo dõi | Chưa | |

## Bước 2 + 3 có gì

- **ATS**: Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters (phân trang), Workable, Personio, Teamtailor. ETag 304. Lọc địa điểm theo `settings.pull_locations`, mỗi lần kéo hiện feed / giữ / ngoài phạm vi theo công ty.
- **Dò ATS**: URL (EngRadar, link ATS) → HTML + trang con → đoán slug, luôn xác nhận bằng feed thật. Link máy đoán chỉ ghi `ats_candidate`, người bấm Xác nhận / Sai ở tab Công ty. Link người điền ghi thẳng `ats`.
- **IMAP**: chỉ đọc, cửa sổ 14 ngày, `mail_seen` theo Message-ID (hash from+date+subject khi thiếu). HTML ưu tiên, link giữ dạng "chức danh (url)". Claude chỉ trích `{title, company, location, url}`; request không có `effort`.
- **Kéo**: `POST /api/pull` chạy nền, UI hỏi mỗi 2 giây khi đang kéo. Mở app quá 12 giờ từ lần kéo trước thì tự kéo, cùng cơ chế sao lưu, không timer.
- **Nguồn chết**: nguồn bật alert hoặc công ty ATS 7 ngày không tin mới → cảnh báo ở tab Nguồn / Công ty.
- **Đóng tin**: tin `ats:*` biến khỏi feed 200 thật → `closed_at`, chỉ nhãn, không đổi status.
- **Luật**: thêm trường `location`.
- **Lọc địa điểm hai lớp**: mục 2 chữ là mã nước, khớp theo token (`Hyvinkää, fi` khớp, `Fifth Avenue` không); mục dài khớp chuỗi con. Mặc định phủ cả nước: `fi`, Finland, Suomi và 19 thành phố. **Remote** chỉ giữ khi chuỗi không có token nước ngoài Phần Lan (mã ISO đứng riêng một đoạn, hoặc tên nước; EU, Europe, Nordic không tính): `Remote`, `Remote, Finland`, `Remote (EU)` giữ; `Remote, US`, `Remote (Poland)` bỏ. Đổi danh sách thì phải bỏ `ats_etag` (304 không lọc lại); migration v5 làm việc đó một lần.
- **Từ khóa luật cập nhật 2026-09-18** (migration v9, chỉ khi chưa sửa tay): `r_notrole` thêm legal, analyst, mechanical, electrical, communications, coordinator, partner, artist, investment, account executive; `r_senior_hard` đổi `vp of` → `vp`. Chạy lại: 8 tin sang Đã loại.
- **IMAP**: Claude trả thêm `adLanguage` ("fi" nếu tiêu đề hoặc nội dung tin trong mail bằng tiếng Phần Lan), gộp với lưới đỡ ä/ö trong tiêu đề. Tin tiếng Phần Lan từ email giờ vào luật `r_lang`.
- **Mẫu link tin theo công ty** (`companies.job_url_template`, schema v11): công ty tắt trang hosted của ATS thì `jobUrl` của API chết. Supercell là ca thật: cả trang tin, trang nộp đơn và board trên jobs.ashbyhq.com đều "Page not found" dù API vẫn trả tin. Đặt mẫu ở tab Công ty, ví dụ `https://supercell.com/en/careers/{slug}/{id}/`; tin mới dựng link từ mẫu, tin cũ và sightings được nối lại ở lần kéo sau. Slug theo quy tắc trang công ty (bỏ hẳn dấu chấm và &), đo 41/41 khớp supercell.com. Hoxhunt, Reaktor hosted bình thường, không cần mẫu.
- **Ashby**: feed trả cả tin `isListed: false` (tin đã gỡ, kể cả "Unlisted TEST job"); parser bỏ chúng nên `closed_at` bắt được.
- **Luật mẫu thêm sau bước 1** (seed cho DB mới, migration cho DB đang dùng): `r_abroad` — location chứa `us, gb, uk, pl, de, se, dk, ca, india, norway` → loại (không dùng `in`, `no` vì trùng từ tiếng Anh); `r_openapp` — title chứa `open application, avoin hakemus, general application, spontaneous application` → Ngờ vực; `r_otherlang` — title chứa `german-speaking, swedish-speaking, spanish, serbian, ingeniero, *entwickler, *utvecklare` → Ngờ vực (dấu * vì tiếng Đức/Thụy Điển ghép từ). Luật loại thắng luật Ngờ vực khi cả hai khớp.
- **`jobs.deadline`**: cột có, để trống tới bước 5. Mỗi thùng có nút xếp: mới thêm (mặc định) / cũ nhất / deadline gần nhất, trống xếp cuối. Hộp đến và Rà soát không có nút xếp.
- Cấu hình: `.env` (xem `.env.example`), nạp lúc server bật. `npm run check` 80 kịch bản. Schema v14.

## Bước 3b có gì (1/3 — sau khi nộp)

- **`jobs.outcome`** (schema v12): `interview` / `rejected` / `offer` / NULL, chỉ sống khi `status = 'applied'`. CHECK của `status` không nới, không DROP TABLE, không tắt FK. Rời `applied` (Trả về Hàng đọc, Loại) → outcome tự về NULL.
- **Bốn thùng trên rail** từ một status: Đã nộp (outcome NULL), Phỏng vấn, Offer, Từ chối. Offer hiện luôn kể cả 0. `binOf()` trong App.jsx là chỗ duy nhất xếp tin vào thùng.
- **`jobs.applied_at`**: ghi lúc bước vào `applied`; đổi outcome không đụng. Bốn thùng sau khi nộp hiện "nộp N ngày trước". Tin nộp trước v12 được `jobs.backfillAppliedAt` điền từ events lúc server/CLI mở DB (db.js không được ghi vào jobs); 17/17 tin thật có ngày.
- **`events.from_outcome` / `to_outcome`**: đổi outcome cũng là một event, U hoàn tác được (ứng viên U so cả outcome). `POST /api/jobs/:id/status` nhận thêm `outcome`; outcome kèm status khác `applied` → 400.
- Bảng năng suất ở tab Nguồn thêm cột **Phỏng vấn** (= interview + offer). `archiveStale`, `rerunRules`, `toggleRule` không đụng tin đã nộp — có kịch bản kiểm.

## Bước 3b có gì (2/3 — replies.js)

- **Schema v13**: `reply_mails` (khóa `message_id + company_key`, một mail có thể khớp nhiều công ty; text đã cắt 4000 ký tự, không link), `replies` (đề xuất: `status` no_reply/ack/rejection/interview/assessment/other, `evidence_message_id`, `note`, `resolution` confirmed/wrong), `reply_runs` (hash đầu vào mỗi công ty), `companies.aliases` (cột có, ô nhập ở 3/3). Export kèm ba bảng.
- **`src/ingest/replies.js`**: với mỗi công ty có tin ở Đã nộp / Phỏng vấn (Từ chối, Offer không theo dõi nữa): IMAP SEARCH trên `[Gmail]/All Mail` (`IMAP_REPLIES_MAILBOX`; không có folder thì INBOX) `SINCE` ngày nộp sớm nhất, `TEXT` tên công ty `OR` tên khác. Không nhãn, không lọc người gửi, chỉ đọc. Đã thử thật: Reaktor 4 mail, Hoxhunt 3, Oura 0. Trần 60 mail mới nhất mỗi công ty, vượt thì ghi `note` (không phải lỗi).
- **Một lần gọi Claude mỗi công ty**, json_schema, không `effort`. Đầu vào: hồ sơ `{id, title, applied_at, stage}` + mail `{message_id, from, subject, date, text}`; không có mô tả công việc. Đầu ra lọc: `job_id` phải là hồ sơ đã gửi, `evidence_message_id` phải là mail đã gửi (không thì null), mỗi hồ sơ một kết quả. Hash (hồ sơ + message_id) giống lần trước → không gọi.
- **Đề xuất, không quyết định**: `replies.js` không import `jobs.js`, không có SQL ghi vào jobs; kịch bản kiểm so `jobs` + `events` trước và sau từng byte. Đề xuất y hệt một dòng đã có (kể cả đã bảo Sai) không ghi lại — đây là cách "Sai" không quay lại ở lần kéo sau.
- **`src/core/replies.js`**: đọc/ghi ba bảng trên; `listPending` = đề xuất mới nhất của mỗi tin, chưa xử lý, không phải no_reply, kèm mail bằng chứng; `resolveReply` chỉ ghi `resolution`. Chạy trong `createPuller` sau IMAP, cùng điều kiện cấu hình; CLI in `N công ty · N mail mới · N lần gọi Claude · N đề xuất`.

## Bước 3b có gì (3/3 — tab Phản hồi)

- **`jobs.confirmReply`**: đường duy nhất bảng replies đụng tới jobs, có lệnh quét canh (`resolveReply(..., "confirmed")` chỉ xuất hiện trong jobs.js). rejection → Từ chối; interview, assessment → Phỏng vấn; ack, other, no_reply → chỉ ghi nhận. Chỉ đổi tin còn ở `applied` và chưa có offer: tin người đã kéo về Hàng đọc thì không đụng. Event ghi `by = human`, U hoàn tác được. `jobs.rejectReply` chỉ ghi `resolution = wrong`. Đã xử lý rồi → 409.
- **API**: `GET /api/replies` (đề xuất chờ, kèm tin và mail bằng chứng), `POST /api/replies/:id/confirm`, `POST /api/replies/:id/wrong`. `PATCH /api/companies/:id` nhận `aliases`.
- **Tab Phản hồi** trong Công cụ, số đếm trên rail khi có đề xuất chờ. Mỗi dòng: tin, công ty, nhãn đề xuất, "nộp N ngày trước", thùng hiện tại, việc Xác nhận sẽ làm (hoặc "chỉ ghi nhận"), ghi chú của Claude, mail bằng chứng (subject, from, ngày, nút đọc mail). Không có mô tả công việc. Nút Xác nhận / Sai.
- **Công ty**: ô tên khác hiện cho công ty đã có tin. Kết quả kéo ở Tìm job có dòng `Phản hồi`: N công ty · N mail mới · N lần gọi Claude · N đề xuất, kèm ghi chú trần 60 mail.

## Bước 5 có gì (1/2 — lõi: `src/ingest/enrich.js`, `jobs.setJd` / `jobs.setFit`, `src/ui/fit.js`)

- **Schema v14**: `jobs.fit_json`, `fit_cv_hash`, `fit_at`, `jd_source` (ats | fetched | title_only), `jd_http_status`. JD fetch được ghi vào `jobs.description` có sẵn. CHECK của status không nới. Danh sách tin trả thêm `fit`, `fitCvHash`, `fitAt`, `jdSource`, `jdHttpStatus`; vẫn không trả description.
- **CV**: `profile/cv.md` (gitignore; mẫu `profile/cv.example.md`), đọc nguyên file, hash sha1. Mỗi tin ghi hash lúc phân tích; lệch hash hiện tại = "CV đã đổi" → tin về Chưa phân tích. Thiếu file → lượt chạy báo lỗi, không ghi gì. `CV_PATH` trong `.env` đổi được chỗ đọc.
- **Lấy JD**: tin có `description` (ATS) dùng luôn. Tin khác fetch link gốc, timeout 20 giây, cách nhau 1 giây, kể cả `linkedin.com/jobs/view` không đăng nhập (đã thử thật: 200, lấy được mô tả đầy đủ). Thứ tự lấy chữ: JSON-LD `JobPosting` (có `validThrough` → `jobs.deadline`) → khối mô tả theo class (`show-more-less-html__markup`, `description__text` — LinkedIn không có JSON-LD và `<main>` mở đầu bằng modal đăng nhập) → `<main>`/`<article>` → cả trang. Cắt 8.000 ký tự. Không 200, redirect sang trang login, dưới 200 ký tự, hoặc lỗi mạng → `title_only`, giữ description cũ nếu có; HTTP 404/410 ghi vào `jd_http_status`.
- **Claude**: `claude-fable-5-1` (đổi bằng `ENRICH_MODEL`), `output_config.effort = high`, json_schema, không gửi tham số `thinking` (Fable luôn bật). CV trong `system` kèm `cache_control`. Vào: CV + title/company/location + JD (null nếu không có). Ra: `fit` on|off, `reason` domain|stack|level_low|level_high|language|location|none, `confidence` high|low, `gaps` ≤3, `strengths` ≤2, `years_required`, `finnish_required`, `deadline`. **Code thắng model**: không có JD → confidence ép low; on → reason none; deadline model chỉ điền chỗ trống (JSON-LD thắng). refusal / max_tokens / HTTP lỗi → dòng lỗi, tin vẫn chờ, tin sau vẫn chạy.
- **Lượt chạy** `createEnricher(db)`: như `createPuller` — `start()` trả về ngay, `status()` cho UI hỏi, không timer. Mỗi lượt lấy tin `status = 'queue'` chưa có fit hoặc hash lệch, mới thêm trước, **trần 20**. `status()` trả `cvHash`, `cvError`, `pending`.
- **Dead do hệ thống** (`src/ui/fit.js`, thuần): `closedAt`, hoặc `deadline < hôm nay`, hoặc `jdHttpStatus` 404/410. `fitTab()`: Dead > Chưa phân tích > Off-profile > On-profile, mỗi tin đúng một tab; chưa có CV thì fit cũ vẫn hiện.
- **Không đổi trạng thái**: `enrich.js` chỉ gọi `jobs.pendingFit / countPendingFit / setJd / setFit` (có lệnh quét canh); kịch bản kiểm so `jobs.status/outcome/decided_by` + `events` trước và sau từng byte qua ba lượt chạy và một lần đổi CV. 12 kịch bản mới.
- Chưa nối: API, nút Phân tích lại, kích hoạt khi bấm 1, tab trong Hàng đọc, nút Xuất JD — commit 2.

## Còn mở

- Bước 3b chưa kéo thật qua Claude. Lần `Kéo ngay` tới sẽ gọi khoảng 16 lần (một lần mỗi công ty có hồ sơ ở Đã nộp / Phỏng vấn); các lần sau chỉ gọi khi có mail mới hoặc hồ sơ mới. Xem chất lượng đề xuất ở tab Phản hồi trước khi tin.
- Mail nhắc tên công ty (alert LinkedIn, newsletter) đi hết vào đầu vào của Claude vì không lọc người gửi. Công ty tên phổ thông (Oura, Nokia) có thể vượt trần 60 mail; `note` ở kết quả kéo sẽ báo.

- Aiven: token Greenhouse giấu phía server; cần dò `for=` ở trang tin lẻ. Chưa có ô nhập token tay.
- Workday (RELEX, Nokia, Nordea, KONE, Kesko, Elisa, CGI): ngoài phạm vi, đi đường email.
- NOTES 2026-09-18 ghi "Supercell ×5 đã đóng". Theo feed Ashby: 1 đóng thật (Total Rewards Partner, `closed_at` 17/09), 1 unlisted (TEST job, `closed_at` 18/09), 3 còn lại (Investment Intern, Gameplay Capture & Video Artist, MarTech Engineer) vẫn đang mở trong feed. Trang Ashby là SPA nên không xác minh được từ HTML.
- Trước khi có bộ lọc Remote mới, lần kéo 2026-09-17 đưa 43 tin Konecranes remote nước ngoài vào Hộp đến; `r_abroad` đã dọn 46 tin về Đã loại. Hai đơn mở đa quốc gia có Phần Lan (Eficode, IPRally) bị `r_abroad` loại, trả tay nếu muốn.
- Cảnh báo "0 giữ trên N tin" nêu cả hai khả năng (định dạng không khớp, hoặc không có việc ở Phần Lan) và chỉ chỗ xem: Swappie là trường hợp thứ hai (Tallinn), Gofore 3 tin 0 giữ chưa xem.
- Swappie: tin duy nhất ở "Tallinn, Estonia".
- Jobly chưa có dòng trong `sources`, thống kê nguồn chết không theo dõi nó.
- Laura / Saima chưa dò.
