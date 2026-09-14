/* Thuần — server và UI đều import. */

const FOLD = { "ø": "o", "æ": "ae", "ß": "ss", "đ": "d", "ł": "l" };

/* Bỏ dấu trước khi lọc: Wärtsilä và Wartsila phải ra cùng một chuỗi. */
export function norm(s) {
  const raw = String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const out = raw.replace(/[øæßđł]/g, (c) => FOLD[c]).replace(/[^a-z0-9]/g, "");
  // Chữ ngoài Latin bị lọc sạch thì giữ nguyên chuỗi, để hai chức danh khác nhau không đè lên nhau.
  return out || raw.trim().replace(/\s+/g, " ");
}

export const fingerprint = (company, title) => `${norm(company)}|${norm(title)}`;
