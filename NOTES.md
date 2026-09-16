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
