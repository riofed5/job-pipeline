import crypto from "node:crypto";
import { now } from "./db.js";
import { norm } from "./dedupe.js";

/* Bảng replies, reply_mails, reply_runs — đề xuất của Claude về phản hồi của công ty.
   File này KHÔNG ghi vào jobs, sightings, events. Đường duy nhất một đề xuất đụng tới tin là
   jobs.confirmReply, sau khi người bấm Xác nhận. */

export const REPLY_STATUSES = ["no_reply", "ack", "rejection", "interview", "assessment", "other"];
export const companyKey = (name) => norm(name);

/* Hồ sơ đang theo dõi phản hồi: đã nộp, chưa bị từ chối, chưa có offer. Gom theo công ty. */
export function trackedApplications(db) {
  const rows = db.prepare(`SELECT id, title, company, applied_at, outcome FROM jobs
    WHERE status = 'applied' AND (outcome IS NULL OR outcome = 'interview') ORDER BY applied_at, rowid`).all();
  const groups = new Map();
  for (const r of rows) {
    const key = companyKey(r.company);
    if (!groups.has(key)) groups.set(key, { key, name: r.company, since: r.applied_at, applications: [] });
    const g = groups.get(key);
    if (r.applied_at && (!g.since || r.applied_at < g.since)) g.since = r.applied_at;
    g.applications.push({ id: r.id, title: r.title, appliedAt: r.applied_at, outcome: r.outcome });
  }
  return [...groups.values()];
}

/* Tên khác của công ty, từ companies.aliases, khớp theo norm(tên). */
export function aliasesFor(db, name) {
  const key = companyKey(name);
  const rows = db.prepare("SELECT name, aliases FROM companies").all();
  const c = rows.find((r) => companyKey(r.name) === key);
  if (!c) return [];
  return [...new Set(String(c.aliases ?? "").split(",").map((a) => a.trim()).filter(Boolean))];
}

/* ---------------------------- mail ---------------------------- */

export const mailStored = (db, messageId, key) =>
  Boolean(db.prepare("SELECT 1 FROM reply_mails WHERE message_id = ? AND company_key = ?").get(messageId, key));

export function storeMail(db, key, { messageId, from, subject, date, text }) {
  db.prepare(`INSERT INTO reply_mails (message_id, company_key, from_addr, subject, date, text, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (message_id, company_key) DO NOTHING`)
    .run(messageId, key, from ?? "", subject ?? "", date ? new Date(date).toISOString() : null, text ?? "", now());
}

const toMail = (m) => ({ messageId: m.message_id, from: m.from_addr, subject: m.subject, date: m.date, text: m.text });

export const listMails = (db, key) =>
  db.prepare("SELECT * FROM reply_mails WHERE company_key = ? ORDER BY date, rowid").all(key).map(toMail);

/* ---------------------------- lần chạy ---------------------------- */

/* Hash đầu vào của một lần gọi Claude: hồ sơ (id, ngày nộp, outcome) + mail (message_id). Giống lần trước → không gọi. */
export function inputHash(applications, mails) {
  const a = applications.map((x) => `${x.id}|${x.appliedAt}|${x.outcome ?? ""}`).sort();
  const m = mails.map((x) => x.messageId).sort();
  return crypto.createHash("sha1").update(JSON.stringify([a, m])).digest("hex");
}

export const lastRun = (db, key) => db.prepare("SELECT * FROM reply_runs WHERE company_key = ?").get(key) ?? null;

export function markRun(db, key, { hash, mails, proposals }) {
  db.prepare(`INSERT INTO reply_runs (company_key, input_hash, ran_at, mails, proposals) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (company_key) DO UPDATE SET input_hash = excluded.input_hash, ran_at = excluded.ran_at,
      mails = excluded.mails, proposals = excluded.proposals`).run(key, hash, now(), mails, proposals);
}

/* ---------------------------- đề xuất ---------------------------- */

/* Đã có đề xuất y hệt (tin, trạng thái, mail bằng chứng) — dù người đã bảo Sai, đã Xác nhận, hay còn chờ —
   thì không ghi lại. Đây là lý do một đề xuất bị bảo Sai không quay lại ở lần kéo sau. */
export const hasProposal = (db, jobId, status, evidence) =>
  Boolean(db.prepare("SELECT 1 FROM replies WHERE job_id = ? AND status = ? AND evidence_message_id IS ?").get(jobId, status, evidence));

export function addProposal(db, key, { jobId, status, evidence = null, note = "" }) {
  if (!REPLY_STATUSES.includes(status)) throw new Error(`trạng thái phản hồi lạ: ${status}`);
  return db.prepare(`INSERT INTO replies (job_id, company_key, status, evidence_message_id, note, proposed_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(jobId, key, status, evidence, note, now()).lastInsertRowid;
}

const toReply = (r) => ({
  id: r.id,
  jobId: r.job_id,
  companyKey: r.company_key,
  status: r.status,
  evidenceMessageId: r.evidence_message_id,
  note: r.note ?? "",
  proposedAt: r.proposed_at,
  resolution: r.resolution,
  resolvedAt: r.resolved_at,
});

export function getReply(db, id) {
  const r = db.prepare("SELECT * FROM replies WHERE id = ?").get(id);
  return r ? toReply(r) : null;
}

/* Đề xuất chờ người xem: chưa xử lý, không phải no_reply, chỉ đề xuất MỚI NHẤT của mỗi tin. Kèm mail bằng chứng.
   Không có description của tin — màn hình này cũng là bàn phân loại. */
export function listPending(db) {
  const rows = db.prepare(`SELECT r.*, j.title, j.company, j.applied_at, j.outcome AS job_outcome, j.status AS job_status,
      m.from_addr, m.subject, m.date AS mail_date, m.text AS mail_text
    FROM replies r
    JOIN jobs j ON j.id = r.job_id
    LEFT JOIN reply_mails m ON m.message_id = r.evidence_message_id AND m.company_key = r.company_key
    WHERE r.resolution IS NULL AND r.status != 'no_reply'
      AND r.id = (SELECT MAX(id) FROM replies x WHERE x.job_id = r.job_id)
    ORDER BY r.id DESC`).all();
  return rows.map((r) => ({
    ...toReply(r),
    job: { id: r.job_id, title: r.title, company: r.company, appliedAt: r.applied_at, outcome: r.job_outcome, status: r.job_status },
    evidence: r.evidence_message_id ? { messageId: r.evidence_message_id, from: r.from_addr, subject: r.subject, date: r.mail_date, text: r.mail_text } : null,
  }));
}

/* Người xử lý. Ghi resolution; KHÔNG đụng jobs — phần đó là jobs.confirmReply. */
export function resolveReply(db, id, resolution) {
  if (!["confirmed", "wrong"].includes(resolution)) throw new Error("resolution phải là confirmed hoặc wrong");
  const r = db.prepare("UPDATE replies SET resolution = ?, resolved_at = ? WHERE id = ? AND resolution IS NULL").run(resolution, now(), id);
  return r.changes > 0;
}
