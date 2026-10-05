/* Tuần ISO. Thuần — server và UI đều import, check.js kiểm. KHÔNG import gì.
   Mọi ngày ở đây là chuỗi YYYY-MM-DD theo giờ máy (localDate / ymd của app), tính bằng UTC để không lệch giờ. */

const DAY_MS = 24 * 60 * 60 * 1000;
const utc = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const pad = (n) => String(n).padStart(2, "0");
const toYmd = (ms) => new Date(ms).toISOString().slice(0, 10);

/* 'YYYY-Www' của một ngày YYYY-MM-DD. Thứ Năm của tuần quyết định năm ISO. */
export function isoWeek(ymd) {
  const t = utc(ymd);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // 0 = thứ Hai
  const thu = t + (3 - dow) * DAY_MS;
  const year = new Date(thu).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1Mon = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  return `${year}-W${pad(Math.round((thu - week1Mon) / DAY_MS / 7) + 1)}`;
}

/* Thứ Hai của tuần chứa ngày này. */
export function weekStart(ymd) {
  const t = utc(ymd);
  return toYmd(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS);
}

/* Danh sách tuần từ tuần chứa `from` tới tuần chứa `to`, MỚI NHẤT TRƯỚC: [{ week, start, end }], end = Chủ nhật. */
export function weeksBetween(from, to) {
  const out = [];
  let start = utc(weekStart(from));
  const last = utc(weekStart(to));
  while (start <= last) {
    out.push({ week: isoWeek(toYmd(start)), start: toYmd(start), end: toYmd(start + 6 * DAY_MS) });
    start += 7 * DAY_MS;
  }
  return out.reverse();
}
