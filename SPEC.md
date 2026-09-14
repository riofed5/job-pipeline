# Bàn phân loại — bản local

Spec để build bằng Claude Code. Bản artifact chạy trong trình duyệt đã có UI và luồng
quyết định đúng; bản này thêm phần mà trình duyệt không làm được: **tự nạp dữ liệu**.

Người dùng: SWE 3.5 năm ở Phần Lan, làm việc bằng tiếng Anh, đang tìm việc trong ~3 tháng.
Vấn đề cần giải: mệt vì đọc mô tả công việc từng cái một, và sợ bỏ sót.

---

## 1. Nguyên tắc thiết kế — không được vi phạm

Đây là phần quan trọng hơn cả code. Bốn nguyên tắc này là lý do app tồn tại.

1. **Không có gì bị xóa.** "Loại" nghĩa là ẩn khỏi view mặc định. Không có `DELETE` trên
   bảng `jobs`, chỉ đổi `status`.
2. **Tách việc rẻ khỏi việc đắt.** Nạp và phân loại là việc rẻ (giây). Đọc JD là việc đắt
   (phút). Không bao giờ trộn hai loại vào cùng một màn hình hay cùng một phiên làm việc.
3. **Luật hoàn tác được theo lô.** Mỗi quyết định tự động ghi lại luật nào gây ra nó.
   Tắt luật → mọi tin nó từng xử lý quay về hộp đến. Vì sai lầm revert được, luật có thể
   viết mạnh tay, mà luật mạnh tay là thứ giữ cho phân loại nhanh.
4. **Quyết định tay thắng luật.** Tin đã được người quyết định thì luật không đụng vào nữa
   (`decided_by = 'human'`).

---

## 2. Kiến trúc

```
  cron 07:00 ─┬─► ats.js      ─┐
              ├─► tmt.js       │
              ├─► imap.js      ├─► normalize ─► dedupe ─► rules ─► sqlite
              └─► websearch.js ┘
  cron 22:00 ───► enrich.js  (tải JD, gọi Claude tóm tắt)  ─► sqlite
  
  npm run ui  ───► express :5173 ───► React (port từ job-pipeline.jsx)
```

Stack đề xuất: Node 20 + better-sqlite3 + Express + React (Vite). Một repo, một ngôn ngữ.
Ingest là CLI chạy độc lập với UI — cron không cần UI mở.

```
/src
  /ingest    ats.js  tmt.js  imap.js  websearch.js  normalize.js
  /core      db.js  rules.js  dedupe.js  enrich.js
  /server    api.js
  /ui        (port từ job-pipeline.jsx)
/data        jobs.db
.env
```

---

## 3. Nguồn dữ liệu — xếp theo độ tin cậy

### Tầng 1 — ATS API. Đây là phần đáng làm nhất.

Phần lớn trang tuyển dụng của công ty chạy trên một nhúm nền tảng ATS, và mỗi nền tảng có
endpoint JSON công khai. Map được ~40 công ty mục tiêu sang ATS của nó thì mày có feed sạch
mọi vị trí đang mở, cập nhật hàng ngày, không scrape, không gãy.

```
Greenhouse     https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
Lever          https://api.lever.co/v0/postings/{company}?mode=json
Ashby          https://api.ashbyhq.com/posting-api/job-board/{name}
Recruitee      https://{company}.recruitee.com/api/offers/
SmartRecruiters https://api.smartrecruiters.com/v1/companies/{id}/postings
Workable       https://apply.workable.com/api/v1/widget/accounts/{id}?details=true
Personio       https://{company}.jobs.personio.de/xml
Teamtailor     trang career có feed JSON/RSS — dò từng công ty
```

**Cần viết script `detect-ats.js`:** nhận URL trang tuyển dụng, fetch HTML, dò dấu vết của
từng nền tảng (hostname trong `<script>`, `<iframe>`, link apply, thẻ meta), đoán ra
`{platform, token}`, rồi thử gọi endpoint để xác nhận. Lưu vào bảng `companies`.

Đừng giả định pattern ở trên đúng cho mọi công ty — **luôn xác nhận bằng một lần gọi thật**
rồi mới ghi vào DB. Công ty nào dò không ra thì đánh dấu `ats = 'manual'` và để email alert lo.

Ở Phần Lan còn có ATS nội địa: Laura (laura.fi) và Saima. Laura có RSS job feed cho khách
hàng của nó — đáng dò vì nhiều công ty Phần Lan dùng.

### Tầng 2 — Työmarkkinatori

Cổng việc làm quốc gia, có JSON search API riêng, không cần đăng nhập, không có chống bot.
Dò endpoint bằng cách mở devtools trên trang tìm kiếm của nó và xem request XHR nào trả JSON.
Trả về chức danh, nhà tuyển dụng (kèm Y-tunnus), phân loại nghề ESCO, địa điểm, loại hợp đồng,
và mô tả đầy đủ.

Lưu ý thực tế: tìm bằng từ khóa tiếng Phần Lan sẽ ra nhiều kết quả hơn hẳn tiếng Anh —
`ohjelmistokehittäjä`, `ohjelmistosuunnittelija`, `full stack`.

### Tầng 3 — IMAP. Đây là thứ giải quyết "không muốn mở tab".

Board nào không có API thì để **nó tự đi tìm rồi gửi mail cho mày**. Duunitori (Duunivahti),
LinkedIn, Oikotie, The Hub, Jobly đều có email alert.

```
Gmail → bật 2FA → tạo App Password (KHÔNG dùng mật khẩu thật)
Gmail → filter: from chứa các domain board → gắn label "jobalerts"
imap.js → đọc label jobalerts → đánh dấu đã xử lý → không bao giờ xóa mail
```

**Cách parse: đừng viết regex riêng cho từng board.** Format email của họ đổi liên tục và
parser sẽ gãy âm thầm. Thay vào đó lấy phần text/HTML của mail, đưa nguyên vào Claude, yêu
cầu trả JSON array `{title, company, location, url, source}`. Một parser cho mọi board,
tự chịu được thay đổi format. Chi phí không đáng kể ở quy mô này.

Biến môi trường: `IMAP_USER`, `IMAP_APP_PASSWORD`, `IMAP_LABEL=jobalerts`.

### Tầng 4 — Claude + web search

Giữ lại như bản artifact, nhưng hạ xuống vai trò lấp khe. Độ phủ kém hơn ba tầng trên.
Dùng để phát hiện công ty mày chưa có trong danh sách theo dõi, hơn là để tìm tin cụ thể.

### Về lịch sự khi lấy dữ liệu

Chỉ gọi endpoint công khai, rate limit 1 req/giây, `User-Agent` ghi rõ là công cụ tìm việc
cá nhân, cache theo ETag. Không đăng nhập hộ, không vượt tường chặn. Dùng cho một người tìm
việc thì hoàn toàn ổn; đừng biến nó thành crawler.

---

## 4. Schema

```sql
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL UNIQUE,   -- norm(company)|norm(title)
  title        TEXT NOT NULL,
  company      TEXT NOT NULL,
  location     TEXT,
  url          TEXT,
  ad_language  TEXT,                   -- 'fi' | 'en' | 'sv'
  description  TEXT,                   -- JD đầy đủ, có thì tốt
  posted_at    TEXT,
  found_at     TEXT NOT NULL,
  status       TEXT NOT NULL,          -- new|queue|maybe|doubt|applied|killed|archived
  decided_by   TEXT,                   -- 'rule' | 'human'
  killed_by    TEXT REFERENCES rules(id),
  summary      TEXT                    -- JSON từ enrich.js
);

-- Một tin có thể xuất hiện ở nhiều kênh. Đừng nhét vào một cột.
CREATE TABLE sightings (
  job_id     TEXT NOT NULL REFERENCES jobs(id),
  source     TEXT NOT NULL,   -- 'ats:greenhouse:wolt' | 'tmt' | 'imap:linkedin' | 'manual'
  channel    TEXT NOT NULL,   -- tên hiển thị: 'Trang công ty' | 'LinkedIn' | 'Duunitori'
  url        TEXT,            -- link riêng của kênh đó, thường khác nhau
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (job_id, source)
);

CREATE TABLE rules (
  id TEXT PRIMARY KEY, label TEXT, field TEXT, match TEXT,
  action TEXT,        -- 'kill' | 'doubt'
  enabled INTEGER, note TEXT, created_at TEXT
);

CREATE TABLE companies (
  id TEXT PRIMARY KEY, name TEXT, tier TEXT, careers_url TEXT,
  ats TEXT, ats_token TEXT, last_pull TEXT, note TEXT
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, url TEXT,
  alert_on INTEGER, last_pull TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT, at TEXT, from_status TEXT, to_status TEXT, by TEXT, rule_id TEXT
);
```

`events` thay cho undo stack trong bộ nhớ ở bản artifact. Có lịch sử đầy đủ thì hoàn tác
được bất kỳ lúc nào, và cuối chiến dịch mày xem lại được mình đã quyết định gì.

**Dedupe:** `fingerprint` unique. Gặp lại tin đã có thì **thêm một dòng vào `sightings`**,
không tạo job mới, không đụng tới `status`. Cùng một job xuất hiện trên ATS + Duunitori +
LinkedIn vẫn chỉ là một dòng trong `jobs`, và mày chỉ quyết định về nó một lần duy nhất —
trong 3 tháng đây là chỗ tiết kiệm nhiều nhất.

### Dữ liệu kênh dùng để làm gì

Ba thứ, không chỉ để hiển thị:

1. **Tín hiệu đi sớm.** Tin chỉ có ở `ats:*` mà chưa xuất hiện trên board nào = chưa lên
   board = ít ứng viên hơn. Đánh dấu nổi bật và ưu tiên trong hàng đọc. Ngược lại, tin có
   mặt ở 4 kênh nghĩa là công ty đang rải rộng và mày đang xếp hàng dài.
2. **Bảng năng suất kênh.** Với mỗi kênh: tổng tin, số giữ lại (`queue` + `applied`), tỉ lệ.
   Kênh nào đổ 200 tin mà giữ lại 4 thì tắt alert của nó. Đừng kết luận dưới 20 tin.
3. **Phát hiện nguồn chết.** Nếu `sources.last_pull` quá 7 ngày mà không có tin mới nào,
   nhiều khả năng parser đã gãy chứ không phải thị trường im. Cảnh báo trong báo cáo tuần.
   Đây là kiểu hỏng nguy hiểm nhất: hệ thống trông vẫn chạy trong khi đã mù một mắt.

Chuẩn hóa `channel` bằng một bảng alias khi nạp — `duunivahti`, `Duunitori.fi`, `duunitori`
phải quy về một tên, nếu không thống kê sẽ vô nghĩa sau vài tuần.

---

## 5. Hai thứ local làm được mà artifact không làm được

### 5.1 Luật chạy trên toàn văn JD

Artifact chỉ có chức danh. Local có `description`, nên luật mạnh hơn hẳn:

- `description` khớp `/sujuva suomen kiel|suomen kielen taito|fluent Finnish/i` → **kill**
  (yêu cầu tiếng Phần Lan thật, khác hẳn việc tin đăng tình cờ bằng tiếng Phần Lan)
- trích số năm yêu cầu bằng `/(\d+)\+?\s*(years|vuoden|vuotta)/i` → nếu `> 7` thì **kill**
- `/security clearance|turvallisuusselvitys/i` → **doubt** (thường cần quốc tịch)

Giữ nguyên cơ chế: mọi luật ghi `killed_by`, tắt luật thì hồi sinh theo lô.

### 5.2 Tóm tắt trước khi đọc — đây là thứ giải quyết đúng nỗi đau

Chạy `enrich.js` lúc 22:00 mỗi ngày. Với mọi tin ở `status = 'queue'` mà `summary IS NULL`:
tải JD, gửi cho Claude, nhận về JSON:

```json
{
  "bullets": ["...", "...", "..."],
  "years_required": 3,
  "finnish_required": false,
  "stack": ["Python", "AWS", "Kubernetes"],
  "comp": "€4500–5500/kk" | null,
  "red_flags": ["on-call không nói rõ bù"],
  "fit_note": "12 từ về mức độ khớp"
}
```

Sáng hôm sau, block đọc của mày không còn là 10 tab JD dài — mà là 10 thẻ tóm tắt. Từ
~5 phút/tin xuống ~1 phút/tin. Mày vẫn mở JD gốc trước khi nộp, nhưng chỉ với những tin đã
qua sàng.

**Quan trọng:** tóm tắt là công cụ hỗ trợ đọc, không phải người thay mày quyết định. Không
để Claude tự chuyển trạng thái tin. Bốn phím vẫn là của mày.

---

## 6. Lịch cron

```
0 7 * * 1-5   npm run pull      # ats + tmt + imap
0 22 * * *    npm run enrich    # tóm tắt hàng đọc
0 9 * * 5     npm run report    # thống kê tuần + nhắc rà soát
```

Sáng thứ Hai mở app là hộp đến đã đầy, luật đã chạy, tóm tắt đã có. Mày chỉ phân loại và đọc.

---

## 7. UI

Port từ `job-pipeline.jsx`, giữ nguyên bố cục và bảng màu. Đổi lớp lưu trữ từ
`window.storage` sang gọi REST, còn lại giữ y nguyên:

- rail trái với số đếm từng thùng (đây là thuốc trị FOMO, không phải trang trí)
- phân loại bằng phím `1/2/3/4`, `U` hoàn tác
- thùng Ngờ vực tách riêng khỏi Đã loại
- tab Luật hiện rule nào đang xử lý bao nhiêu tin + nút hồi sinh
- rà soát có lịch, đếm ngày từ lần gần nhất
- tự lưu trữ sau 21 ngày

Thêm mới ở bản local:
- **Màn hình đọc**: hiện tóm tắt, giới hạn cứng 10 tin/phiên, có nút "tạm dừng phiên"
- **Trang công ty**: hiện trạng thái ATS, lần pull cuối, số tin đã lấy được
- **Bảng theo dõi**: tin/tuần theo nguồn, tỉ lệ phân loại, tỉ lệ nộp → phỏng vấn

---

## 8. Thứ tự làm

Đừng build hết một lượt. Mỗi bước phải chạy được rồi mới sang bước sau.

1. Schema + rules engine + UI port, nạp bằng tay. **Dùng thật 2 ngày.**
2. `detect-ats.js` + `ats.js` cho 10 công ty tier A. Đây là bước sinh lãi cao nhất.
3. `imap.js` + parser bằng Claude. Sau bước này mày ngừng mở board.
4. `tmt.js`.
5. `enrich.js`.
6. Cron + bảng theo dõi.

Bước 1 và 2 đã đủ dùng cho cả chiến dịch. Ba bước sau là tối ưu.

---

## 9. Bẫy cần tránh

- **Đừng cho LLM quyết định thay.** Nó tóm tắt và phân loại thô. Quyết định giữ hay loại là
  của người. Giao quyền quyết định cho nó thì hộp đến sẽ sạch mà mày không biết mình bỏ lỡ gì.
- **Đừng thêm ô "tự động nộp".** Sẽ có lúc thấy hấp dẫn. Nó phá nốt phần duy nhất của quy
  trình còn giá trị.
- **Đừng để luật lặng lẽ giết quá nửa số tin.** Cảnh báo khi một luật vượt 50%.
- **Sao lưu DB.** `data/jobs.db` vào git, hoặc `cp` theo ngày trong cron. Ba tháng là dài.
- **Đừng để dự án này thành nơi trốn việc tìm job.** Nó là công cụ, không phải side project.
  Hết bước 2 mà thấy đang tinh chỉnh CSS thì dừng lại và đi nộp hồ sơ.
