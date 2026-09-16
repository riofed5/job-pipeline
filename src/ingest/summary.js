/* Tóm tắt kết quả kéo cho toast và CLI. Thuần — UI import được, KHÔNG được import gì đụng DB. */

export function summarize(results) {
  const sum = (k) => results.reduce((n, r) => n + (r[k] || 0), 0);
  const errors = results.filter((r) => r.error).length;
  const parts = [`${sum("added")} tin mới`, `${sum("auto")} bị luật xử lý`, `${sum("dup")} trùng đã gộp nguồn`];
  if (sum("dropped")) parts.push(`${sum("dropped")} ngoài phạm vi địa điểm`);
  if (errors) parts.push(`${errors} nguồn lỗi`);
  return parts.join(" · ");
}
