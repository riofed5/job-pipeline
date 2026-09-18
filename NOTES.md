# NOTES — hai ngày dùng thật (từ 2026-09-14)

Không sửa code trong hai ngày này. Thấy chỗ chướng mắt thì ghi vào đây.
Điều kiện mở bước 2: đã dùng thật hai ngày, và ba con số dưới đây chấp nhận được.

## Ba con số

Cả ba đều tự có trong bảng `events`, không cần bấm giờ. Chạy được cả khi server đang chạy.

```sh
# Giây cho một tin ở màn phân loại: khoảng cách giữa hai quyết định liên tiếp từ Hộp đến,
# bỏ các quãng nghỉ trên 5 phút.
sqlite3 -header data/jobs.db "WITH d AS (SELECT julianday(at)*86400 AS t FROM events WHERE by='human' AND from_status='new' AND undo_of IS NULL), g AS (SELECT t - LAG(t) OVER (ORDER BY t) AS gap FROM d) SELECT COUNT(*) AS so_tin, ROUND(AVG(gap),1) AS giay_moi_tin FROM g WHERE gap < 300;"

# Tỉ lệ tin luật đang giữ.
sqlite3 -header data/jobs.db "SELECT COUNT(*) AS tong, SUM(decided_by='rule') AS luat_giu, ROUND(100.0*SUM(decided_by='rule')/COUNT(*),1) AS pct FROM jobs;"

# Số lần hoàn tác theo ngày (ngày UTC).
sqlite3 -header data/jobs.db "SELECT substr(at,1,10) AS ngay, COUNT(*) AS hoan_tac FROM events WHERE undo_of IS NOT NULL GROUP BY ngay;"
```

|                   | Ngày 1 | Ngày 2 | Ngưỡng                                   |
|-------------------|--------|--------|------------------------------------------|
| Giây / tin        |    < 10 giây    |    < 10 giây    | trên 20 giây → sửa trước bước 2          |
| % tin luật giữ    |    8%    | 8%       | trên 60% → đang tự bịt mắt               |
| Số lần hoàn tác   |    0    |   0     |                                          |

## Điện thoại — kiểm ở 380px

2026-09-14. Chrome giả lập thiết bị với 16 tin giống thật, chưa phải máy thật.

**Chặn: điện thoại không vào được app.**
- Server chỉ nhận kết nối từ 127.0.0.1, tức là từ chính laptop.
- Trên tàu, điện thoại còn không cùng mạng với laptop, và laptop phải đang bật.
- Cần một đường nối như Tailscale, hoặc deploy. Deploy nằm ngoài bước 1.
- Mở server cho mọi địa chỉ (0.0.0.0) thì bất kỳ ai cùng wifi quán cà phê cũng đọc và ghi được, vì app không có đăng nhập.
- Chưa làm gì. Cần quyết.

**Nhịp phân loại**
- Rail (13 nút, lưới 2 cột) chiếm khoảng 510px đầu trang. Lúc mở app, thẻ tin bắt đầu ở y≈626 còn bốn phím ở 927–1135px, trên màn hình cao 800px. Không thấy phím nào, phải cuộn trước.
- Sau khi cuộn, vị trí phím nhảy theo độ dài chức danh (512→611px). 1/10 lần hàng phím dưới lọt ra ngoài màn hình, đúng ở tin có chức danh dài. Dữ liệu thật nhiều chức danh dài hơn thế.
- Điện thoại không có phím U. Muốn hoàn tác phải cuộn lên đầu trang, bấm nút, rồi cuộn xuống lại. Dòng "Phím U để hoàn tác" vô nghĩa trên điện thoại.
- Toast (4 giây, sát đáy màn hình) che phím 3 và 4 và nhận chạm thay cho chúng. Chỉ xảy ra sau hoàn tác, nạp tin, tắt luật; không xảy ra sau mỗi lần phân loại.

**Không vỡ**
- Không trang nào tràn ngang. `.chip` xuống dòng gọn trong `.rowMeta`, kể cả tin có 3 kênh.
- Rà soát hiện đủ hai tuổi. Ngờ vực hiện nhãn luật và nhãn tiếng Phần Lan.
- Toast "→ Hộp đến (luật cũ đã tắt)" hiện đúng.

**Lặt vặt (có từ reference)**
- Thẻ luật: dòng "Đang xử lý 2 tin. Tắt luật…" bị ngắt thành nhiều mảnh, vì `.ruleStat` là flex nên mỗi đoạn chữ thành một mục riêng.
- Bảng Nguồn: "chưa đủ mẫu" xuống dòng, cột "Đã nộp" bị ép hẹp.

## Ghi trong khi dùng

-

## Đếm 2026-09-16

Đếm thẳng từ `data/jobs.db`, không sửa code.

| | |
|---|---|
| Tổng tin | 25 |
| Luật loại (`decided_by='rule'`, `status='killed'`) | 1 |
| Luật ngờ vực (`decided_by='rule'`, `status='doubt'`) | 1 |
| Hoàn tác (`events.undo_of IS NOT NULL`) | 0 |

Luật giữ 2/25 = 8%. Cách tính này khác ô "% tin luật giữ" ở bảng trên: bảng trên gộp cả hai trạng thái, đây tách riêng.

## Bước 2 + 3 — 2026-09-16

Bốn commit: detect-ats + ats, pull + UI, imap, cảnh báo nguồn chết. `npm run check` xanh (41 kịch bản).

**Chưa xong, cần quyết hoặc điền tay**
- Aiven giấu token Greenhouse phía server (trang chỉ có `gh_jid`), dò không ra. Chưa có ô nhập token tay trong UI; muốn kéo Aiven thì cần thêm ô đó hoặc điền `ats`/`ats_token` bằng sqlite.
- RELEX chạy Workday — chưa hỗ trợ. Oura trả 403 cho công cụ. Cả hai đánh `manual`.
- IMAP mới kiểm bằng client giả; máy chưa có `.env` nên chưa nối Gmail thật lần nào. Việc đầu tiên: chép `.env.example` → `.env`, tạo App Password, tạo filter Gmail gắn label `jobalerts`, rồi bấm Kéo ngay.
- Laura / Saima (ATS Phần Lan) chưa dò.
- Jobly không có dòng trong bảng `sources`, nên thống kê nguồn chết không theo dõi nó dù kênh vẫn ghi vào sightings.
- Parser mail dùng `claude-opus-5` (giá 5 $/25 $ mỗi triệu token). Một mail alert ~5–10k token → dưới 0,1 $ mỗi mail. Đổi bằng `CLAUDE_MODEL` trong `.env` nếu muốn rẻ hơn (`claude-sonnet-5`: 2 $/10 $).

**Đã thấy khi kéo thật (Wolt, Greenhouse)**: feed 242 tin, giữ 26 sau lọc địa điểm, 19 bị luật xử lý. "Remote" trong danh sách lọc cho lọt "Krakow, Poland; Remote" — đúng như đã chốt, luật địa điểm lo.

## Dò ATS lần đầu — 2026-09-16, sau khi duyệt bảng

- Link do máy đoán từ tên **không được ghi thẳng `ats`** nữa: kết quả vào `ats_candidate`, tab Công ty có Xác nhận / Sai. Ba lần sai của run đầu: Knowit → udacity.com (redirect), OP → oceanpacific.com, KONE → trang 404. Nokia, Nordea, KONE, Kesko, Elisa, CGI: không dò lại — tập đoàn lớn dùng Workday hoặc SAP, ngoài phạm vi, đi đường email.
- **Aiven**: trang tin lẻ nhúng Greenhouse. Cách dò tiếp: mở một trang `aiven.io/careers/job/...?gh_jid=...`, tìm script `boards.greenhouse.io/embed/job_app?for=<token>` hoặc `job_board/js?for=<token>`. Chưa làm.
- **SmartRecruiters** trả tối đa `limit=100`; Konecranes đúng 100 tin nên feed thật có thể nhiều hơn. Cần phân trang bằng `offset` trong `ats.js`. TietoEVRY ra `smartrecruiters:my-applications` với 0 tin — token rác lấy từ link HTML, ứng viên đó là Sai.
- Script dò cần **log giờ bắt đầu và thời gian từng công ty**; run đầu chỉ có tổng (46 công ty ≈ 30 phút, ~40 giây/công ty).

## 2026-09-18 — 30 tin lọt qua luật, xem xét hàng đọc

Không ghi từng tin. Ghi theo mẫu:

| Mẫu | Số tin | Ví dụ | Sửa |
|---|---|---|---|
| Vai trò ngoài ngành, r_notrole không có từ | 10 | Legal Counsel, Electrical Engineer, Investment Intern | thêm: legal, analyst, mechanical, electrical, communications, coordinator, partner, artist, investment, account executive |
| Tiếng Phần Lan từ email, adLanguage không set | 6 | Harjoitteluun Bravida, Korkeakouluharjoittelu DNA | imap.js: Claude trả thêm adLanguage |
| Senior title lọt | 1 | VP, Consumer & Commercial | vp nguyên từ thay vp of |
| Ngôn ngữ khác trong title/JD | 3 | Ingeniero de Seguridad, DACH German-speaking, Serbian | luật title: german-speaking, spanish, serbian → doubt |
| Tin đã đóng (ATS) | 5 | Supercell ×5 | closed_at tự bắt lần kéo sau, xác minh |
| Tin hết hạn (email) | 3 | Kalmar, NoA, LähiTapiola | chờ bước 5 |

Bài học: 30 tin này đều loại được bằng tiêu đề. Đã mở 30 link — sai quy trình.