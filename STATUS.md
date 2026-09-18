# STATUS

Trạng thái theo mục 8 của SPEC.md. Cổng chặn vẫn là con số trong CLAUDE.md, chỉ đổi bằng tay.

| Bước | Nội dung | Trạng thái | Ngày |
|---|---|---|---|
| 1 | Schema, luật, UI port, nạp tay | Xong, dùng thật 2 ngày | 2026-09-14 |
| 2 | `detect-ats.js` + `ats.js` + `pull.js` + tự kéo sau 12 giờ + Kéo ngay | **Xong** | 2026-09-16 |
| 3 | `imap.js` + parser bằng Claude | **Xong**, đã kéo thật 11 mail LinkedIn | 2026-09-17 |
| 4 | `tmt.js` | Chưa | |
| 5 | `enrich.js` | Chưa | |
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
- **Ashby**: feed trả cả tin `isListed: false` (tin đã gỡ, kể cả "Unlisted TEST job"); parser bỏ chúng nên `closed_at` bắt được.
- **Luật mẫu thêm sau bước 1** (seed cho DB mới, migration cho DB đang dùng): `r_abroad` — location chứa `us, gb, uk, pl, de, se, dk, ca, india, norway` → loại (không dùng `in`, `no` vì trùng từ tiếng Anh); `r_openapp` — title chứa `open application, avoin hakemus, general application, spontaneous application` → Ngờ vực. Luật loại thắng luật Ngờ vực khi cả hai khớp.
- **`jobs.deadline`**: cột có, để trống tới bước 5. Mỗi thùng có nút xếp: mới thêm (mặc định) / cũ nhất / deadline gần nhất, trống xếp cuối. Hộp đến và Rà soát không có nút xếp.
- Cấu hình: `.env` (xem `.env.example`), nạp lúc server bật. `npm run check` 50 kịch bản. Schema v9.

## Còn mở

- Aiven: token Greenhouse giấu phía server; cần dò `for=` ở trang tin lẻ. Chưa có ô nhập token tay.
- Workday (RELEX, Nokia, Nordea, KONE, Kesko, Elisa, CGI): ngoài phạm vi, đi đường email.
- NOTES 2026-09-18 ghi "Supercell ×5 đã đóng". Theo feed Ashby: 1 đóng thật (Total Rewards Partner, `closed_at` 17/09), 1 unlisted (TEST job, `closed_at` 18/09), 3 còn lại (Investment Intern, Gameplay Capture & Video Artist, MarTech Engineer) vẫn đang mở trong feed. Trang Ashby là SPA nên không xác minh được từ HTML.
- Hàng "Ngôn ngữ khác trong title/JD" (german-speaking, spanish, serbian → Ngờ vực) trong NOTES 2026-09-18 chưa làm, chưa được yêu cầu.
- Trước khi có bộ lọc Remote mới, lần kéo 2026-09-17 đưa 43 tin Konecranes remote nước ngoài vào Hộp đến; `r_abroad` đã dọn 46 tin về Đã loại. Hai đơn mở đa quốc gia có Phần Lan (Eficode, IPRally) bị `r_abroad` loại, trả tay nếu muốn.
- Cảnh báo "0 giữ trên N tin" nêu cả hai khả năng (định dạng không khớp, hoặc không có việc ở Phần Lan) và chỉ chỗ xem: Swappie là trường hợp thứ hai (Tallinn), Gofore 3 tin 0 giữ chưa xem.
- Swappie: tin duy nhất ở "Tallinn, Estonia".
- Jobly chưa có dòng trong `sources`, thống kê nguồn chết không theo dõi nó.
- Laura / Saima chưa dò.
