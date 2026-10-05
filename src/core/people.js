import crypto from "node:crypto";
import { now, localDate } from "./db.js";
import { norm } from "./dedupe.js";

/* Người quen để nhắn xin giới thiệu (bước 5b). Không có hàm xóa: hết việc thì đổi status.
   File này chỉ ghi vào people. */

export const RELATIONS = ["colleague", "alumni", "community", "other"];
export const PEOPLE_STATUSES = ["todo", "sent", "replied", "referral"];
const STATUS_ORDER = Object.fromEntries(PEOPLE_STATUSES.map((s, i) => [s, i]));

const httpError = (status, message) => Object.assign(new Error(message), { status });
const clean = (v) => String(v ?? "").trim().replace(/\s+/g, " ") || null;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toPerson = (p, companies) => {
  const c = p.company ? companies.get(norm(p.company)) : null;
  return {
    id: p.id, name: p.name, company: p.company, relation: p.relation, channel: p.channel, status: p.status,
    contactedAt: p.contacted_at, note: p.note ?? "", createdAt: p.created_at,
    companyId: c?.id ?? null, companyTier: c?.tier ?? null,
  };
};

const companyMap = (db) => new Map(db.prepare("SELECT id, name, tier FROM companies").all().map((c) => [norm(c.name), c]));

/* Xếp theo trạng thái (todo trước) rồi ngày liên hệ / ngày thêm mới nhất. Nối company bằng norm(name), không FK. */
export function listPeople(db) {
  const companies = companyMap(db);
  return db.prepare("SELECT * FROM people").all().map((p) => toPerson(p, companies))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      || String(b.contactedAt ?? b.createdAt).localeCompare(String(a.contactedAt ?? a.createdAt))
      || b.createdAt.localeCompare(a.createdAt));
}

export function getPerson(db, id) {
  const p = db.prepare("SELECT * FROM people WHERE id = ?").get(id);
  return p ? toPerson(p, companyMap(db)) : null;
}

export const countTodo = (db) => db.prepare("SELECT COUNT(*) n FROM people WHERE status = 'todo'").get().n;

export function addPerson(db, { name, company = null, relation = "other", channel = null, note = null } = {}) {
  const n = clean(name);
  if (!n) throw httpError(400, "thiếu tên");
  if (!RELATIONS.includes(relation)) throw httpError(400, `quan hệ không hợp lệ: ${relation}`);
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO people (id, name, company, relation, channel, status, contacted_at, note, created_at) VALUES (?, ?, ?, ?, ?, 'todo', NULL, ?, ?)")
    .run(id, n, clean(company), relation, clean(channel), clean(note), now());
  return getPerson(db, id);
}

/* Sửa từng trường. Rời todo lần đầu mà chưa có ngày liên hệ → điền hôm nay (đây là con số "tin nhắn đã gửi" ở Nhật ký);
   ngày sửa tay được, kể cả xóa trống. */
export function patchPerson(db, id, patch = {}) {
  const cols = { name: "name", company: "company", relation: "relation", channel: "channel", status: "status", contactedAt: "contacted_at", note: "note" };
  const bad = Object.keys(patch).filter((k) => !(k in cols));
  if (bad.length) throw httpError(400, `không sửa được: ${bad.join(", ")}`);
  const p = db.prepare("SELECT * FROM people WHERE id = ?").get(id);
  if (!p) throw httpError(404, "không có người này");
  if ("name" in patch && !clean(patch.name)) throw httpError(400, "thiếu tên");
  if ("relation" in patch && !RELATIONS.includes(patch.relation)) throw httpError(400, `quan hệ không hợp lệ: ${patch.relation}`);
  if ("status" in patch && !PEOPLE_STATUSES.includes(patch.status)) throw httpError(400, `trạng thái không hợp lệ: ${patch.status}`);
  if ("contactedAt" in patch && clean(patch.contactedAt) && !DATE_RE.test(patch.contactedAt)) throw httpError(400, "ngày phải là YYYY-MM-DD");
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE people SET ${cols[k]} = ? WHERE id = ?`).run(k === "name" ? clean(v) : k === "relation" || k === "status" ? v : clean(v), id);
    if (patch.status && patch.status !== "todo" && p.status === "todo" && !p.contacted_at && !("contactedAt" in patch)) {
      db.prepare("UPDATE people SET contacted_at = ? WHERE id = ?").run(localDate(), id);
    }
  })();
  return getPerson(db, id);
}
