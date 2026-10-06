# CLAUDE.md

Đọc file này trước mọi phiên làm việc. Chi tiết kỹ thuật ở `SPEC.md`.
UI tham chiếu ở `reference/job-pipeline.jsx` — port từ đó, đừng thiết kế lại.

---

## BƯỚC HIỆN TẠI: 5c — phát hiện trùng

**Chỉ được làm:** cột jobs.dup_candidate_of, hàm so mô tả, bước so
trong enrich, dòng "Có thể trùng" ở Hàng đọc, phím 5 / nút Gộp.

Những thứ **KHÔNG được đụng vào** ở bước này:

- `websearch.js`, `tmt.js`
- cron, scheduler, background job có timer
- Docker, CI, deploy
- CHECK của jobs.status — không nới, không DROP TABLE, không tắt FK
- Không tự gộp tin dưới bất kỳ ngưỡng nào. Gộp là quyết định của người.

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
   mọi tin nó từng xử lý quay về `new` (tin đã lưu trữ về `maybe`), trừ tin đã có `decided_by = 'human'`.

4. **Quyết định tay thắng luật.** Luật không bao giờ ghi đè lên tin người đã quyết định.

---

## Cách làm việc

- **Lập kế hoạch trước, chờ tao duyệt, rồi mới viết code.** Với mọi việc lớn hơn một file.
- **Một bước một phiên.** Xong bước thì dừng, đừng chạy tiếp sang bước sau.
- Xong mỗi phần chạy được thì **commit** kèm mô tả ngắn. Mô tả bằng tiếng Anh (bắt buộc).
- **STATUS.md cập nhật trong CÙNG commit với thay đổi**, không để sau.
- Không thêm dependency nếu chưa hỏi.
- Không refactor phần đang chạy tốt trừ khi tao yêu cầu.
- Khi tao chỉ ra lỗi, sửa đúng chỗ đó. Đừng nhân tiện dọn dẹp chỗ khác.
- Commit nào đụng src/ui/ hoặc thêm dependency: mở app thật trong trình duyệt trước khi commit, console không có lỗi.
- Mọi kiểm thử, kể cả kiểm UI bằng trình duyệt, chạy trên server riêng với DATA_DIR trỏ tới bản sao. Không bao giờ bấm vào server đang phục vụ data/jobs.db.

## Cấm

- **Không có chức năng tự động nộp đơn.** Sẽ có lúc trông hợp lý. Không.
- **Không để LLM tự đổi trạng thái tin.** Nó tóm tắt, nó gợi ý. Quyết định là của người.
- Không crawl LinkedIn, không dùng tài khoản LinkedIn. Fetch một trang tin
  công khai linkedin.com/jobs/view/ thì được.

## Bối cảnh

Người dùng là SWE 3.5 năm ở Phần Lan, làm việc bằng tiếng Anh, tìm việc trong ~3 tháng.
Công cụ này phải dùng được từ ngày đầu và chịu được 3 tháng. Nó là công cụ, không phải
side project — ưu tiên chạy được hơn là hoàn hảo.
