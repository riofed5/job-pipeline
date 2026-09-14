# CLAUDE.md

Đọc file này trước mọi phiên làm việc. Chi tiết kỹ thuật ở `SPEC.md`.
UI tham chiếu ở `reference/job-pipeline.jsx` — port từ đó, đừng thiết kế lại.

---

## BƯỚC HIỆN TẠI: 1

**Chỉ được làm bước 1 trong mục 8 của SPEC.md:** schema, rules engine, UI port, nạp bằng tay.

Những thứ **KHÔNG được đụng vào** ở bước này:

- `ats.js`, `detect-ats.js`, `tmt.js`, `imap.js`, `websearch.js`, `enrich.js`
- cron, scheduler, background job
- gọi Anthropic API
- Docker, CI, deploy
- test framework (trừ khi tao yêu cầu)

Nếu thấy một trong số đó cần thiết, **nói ra và dừng lại**. Đừng tự làm.

Con số ở dòng tiêu đề trên là cổng chặn duy nhất. Nó chỉ đổi khi tao sửa file này bằng tay.

---

## Bốn nguyên tắc — không được vi phạm

1. **Không có gì bị xóa.** "Loại" = đổi `status`, không phải `DELETE`. Không có endpoint
   nào xóa job. Đây là phản xạ dễ sai nhất khi viết CRUD — kiểm lại mỗi lần đụng vào DB.

2. **Tách việc rẻ khỏi việc đắt.** Nạp và phân loại tính bằng giây. Đọc mô tả công việc
   tính bằng phút. Không bao giờ để hai loại này trên cùng một màn hình. Cụ thể: màn hình
   phân loại **không được hiện mô tả công việc**, chỉ chức danh, công ty, nguồn, link.
   Đây là ràng buộc thiết kế, không phải thiếu sót.

3. **Luật hoàn tác được theo lô.** Mọi quyết định tự động ghi `killed_by`. Tắt một luật →
   mọi tin nó từng xử lý quay về `new`, trừ tin đã có `decided_by = 'human'`.

4. **Quyết định tay thắng luật.** Luật không bao giờ ghi đè lên tin người đã quyết định.

---

## Cách làm việc

- **Lập kế hoạch trước, chờ tao duyệt, rồi mới viết code.** Với mọi việc lớn hơn một file.
- **Một bước một phiên.** Xong bước thì dừng, đừng chạy tiếp sang bước sau.
- Xong mỗi phần chạy được thì **commit** kèm mô tả ngắn.
- Không thêm dependency nếu chưa hỏi.
- Không refactor phần đang chạy tốt trừ khi tao yêu cầu.
- Khi tao chỉ ra lỗi, sửa đúng chỗ đó. Đừng nhân tiện dọn dẹp chỗ khác.

## Cấm

- **Không có chức năng tự động nộp đơn.** Sẽ có lúc trông hợp lý. Không.
- **Không để LLM tự đổi trạng thái tin.** Nó tóm tắt, nó gợi ý. Quyết định là của người.
- Không scrape LinkedIn. Nó chặn gắt và có thể làm khóa tài khoản. LinkedIn đi qua
  email alert ở bước 3.

## Bối cảnh

Người dùng là SWE 3.5 năm ở Phần Lan, làm việc bằng tiếng Anh, tìm việc trong ~3 tháng.
Công cụ này phải dùng được từ ngày đầu và chịu được 3 tháng. Nó là công cụ, không phải
side project — ưu tiên chạy được hơn là hoàn hảo.
