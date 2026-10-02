/* Tab trong Hàng đọc (bước 5). Thuần — UI import, check.js kiểm. KHÔNG import gì.
   Dead do hệ thống tính từ dữ kiện, không phải từ model: tin biến khỏi feed ATS (closedAt), deadline đã qua,
   hoặc link gốc trả 404/410 lúc lấy JD. */

export const FIT_TABS = [
  { id: "on", label: "On-profile" },
  { id: "off", label: "Off-profile" },
  { id: "dead", label: "Dead" },
  { id: "pending", label: "Chưa phân tích" },
];

export const REASON_LABEL = {
  domain: "khác lĩnh vực",
  stack: "khác stack",
  level_low: "cấp thấp hơn",
  level_high: "cấp cao hơn",
  language: "ngôn ngữ",
  location: "địa điểm",
  none: "",
};

export const DEAD_HTTP = [404, 410];

export const isDead = (j, today) =>
  Boolean(j.closedAt) || Boolean(j.deadline && today && j.deadline < today) || DEAD_HTTP.includes(j.jdHttpStatus);

/* Mỗi tin đúng một tab. Dead trước mọi thứ; chưa có fit hoặc fit làm với CV khác hiện tại → chờ phân tích.
   cvHash null (chưa có profile/cv.md) thì mọi fit đang có vẫn hiện, không bắt chờ. */
export function fitTab(j, { cvHash = null, today } = {}) {
  if (isDead(j, today)) return "dead";
  if (!j.fit) return "pending";
  if (cvHash && j.fitCvHash !== cvHash) return "pending";
  return j.fit.fit === "on" ? "on" : "off";
}

export function fitCounts(jobs, opts) {
  const m = Object.fromEntries(FIT_TABS.map((t) => [t.id, 0]));
  for (const j of jobs) m[fitTab(j, opts)]++;
  return m;
}

/* Tóm tắt một lượt phân tích cho toast. */
export function summarizeFit(results) {
  const n = (f) => results.filter(f).length;
  const parts = [`${n((r) => r.fit?.fit === "on")} on-profile`, `${n((r) => r.fit?.fit === "off")} off-profile`];
  const titleOnly = n((r) => r.jdSource === "title_only");
  if (titleOnly) parts.push(`${titleOnly} không lấy được JD`);
  const errors = n((r) => r.error);
  if (errors) parts.push(`${errors} lỗi`);
  return parts.join(" · ");
}
