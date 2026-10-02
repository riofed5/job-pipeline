import crypto from "node:crypto";
import { now } from "./db.js";
import { fingerprint } from "./dedupe.js";
import { compileRules, evaluate } from "./rules.js";
import { listRules } from "./config.js";
import { normalizeItem } from "../ingest/normalize.js";
import * as replies from "./replies.js";

/* Nơi DUY NHẤT ghi vào jobs, sightings, events. Mọi lần đổi status ghi một event
   trong cùng transaction. Bốn nguyên tắc trong CLAUDE.md được canh ở đây và
   trong scripts/check.js:
   1. Không xóa — "loại" là đổi status.
   2. Danh sách tin không bao giờ trả description.
   3. Tắt luật → mọi tin nó từng xử lý được hồi sinh theo lô.
   4. decided_by = 'human' thì luật không đụng vào. */

export const STATUSES = ["new", "queue", "maybe", "doubt", "applied", "killed", "archived"];
/* Giai đoạn sau khi nộp. Chỉ có nghĩa khi status = 'applied'; rời applied thì về NULL. */
export const OUTCOMES = ["interview", "rejected", "offer"];

const DAY_MS = 24 * 60 * 60 * 1000;
const httpError = (status, message) => Object.assign(new Error(message), { status });

const cache = new WeakMap();
function stmt(db, sql) {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

/* ---------------------------- đọc ---------------------------- */

// Không có description: không màn hình nào ở bàn phân loại được hiện nó.
const JOB_COLUMNS = "id, title, company, location, url, ad_language, note, posted_at, found_at, status, status_at, decided_by, killed_by, closed_at, deadline, outcome, applied_at, fit_json, fit_cv_hash, fit_at, jd_source, jd_http_status";

const parseFit = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

const toJob = (r, channels) => ({
  id: r.id,
  title: r.title,
  company: r.company,
  location: r.location,
  url: r.url,
  adLanguage: r.ad_language,
  note: r.note,
  postedAt: r.posted_at,
  foundAt: r.found_at,
  status: r.status,
  statusAt: r.status_at,
  outcome: r.outcome,
  appliedAt: r.applied_at,
  decidedBy: r.decided_by,
  killedBy: r.killed_by,
  closedAt: r.closed_at,
  deadline: r.deadline,
  fit: parseFit(r.fit_json),
  fitCvHash: r.fit_cv_hash,
  fitAt: r.fit_at,
  jdSource: r.jd_source,
  jdHttpStatus: r.jd_http_status,
  channels,
});

export function listJobs(db) {
  const rows = stmt(db, `SELECT ${JOB_COLUMNS} FROM jobs ORDER BY found_at DESC, rowid ASC`).all();
  const channels = new Map();
  const sightings = stmt(db, `SELECT job_id, channel FROM sightings
    GROUP BY job_id, channel ORDER BY MIN(seen_at), MIN(rowid)`).all();
  for (const s of sightings) {
    if (!channels.has(s.job_id)) channels.set(s.job_id, []);
    channels.get(s.job_id).push(s.channel);
  }
  return rows.map((r) => toJob(r, channels.get(r.id) ?? []));
}

export function getJob(db, id) {
  const r = stmt(db, `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id);
  if (!r) return null;
  const channels = stmt(db, `SELECT channel FROM sightings WHERE job_id = ?
    GROUP BY channel ORDER BY MIN(seen_at), MIN(rowid)`).all(id).map((s) => s.channel);
  return toJob(r, channels);
}

const row = (db, id) => stmt(db, "SELECT * FROM jobs WHERE id = ?").get(id);
const asItem = (r) => ({ title: r.title, company: r.company, location: r.location, note: r.note, adLanguage: r.ad_language });
const verdict = (hit) => (hit ? (hit.action === "kill" ? "killed" : "doubt") : "new");

/* Tin luật từng xử lý quay về đâu khi luật bị tắt:
   đã lưu trữ → Có thể (làn rà soát tuần, không làm ngập Hộp đến), còn lại → Hộp đến. */
const reviveTarget = (status) => (status === "archived" ? "maybe" : "new");

/* ---------------------------- ghi ---------------------------- */

/* Mọi lần đổi status hoặc outcome của một tin đã có đi qua hàm này. status_at chỉ đổi khi status đổi,
   hoặc khi resetClock (hoàn tác: tin vừa thật sự quay lại thùng đó). outcome chỉ sống ở applied;
   applied_at ghi lúc BƯỚC VÀO applied (đổi outcome bên trong applied không đụng nó). */
function writeStatus(db, job, { status, outcome = null, decidedBy, killedBy, by, ruleId = null, undoOf = null, at, resetClock = false }) {
  const statusAt = resetClock || status !== job.status ? at : job.status_at;
  const out = status === "applied" ? outcome : null;
  const appliedAt = status === "applied" && job.status !== "applied" ? at : job.applied_at;
  stmt(db, "UPDATE jobs SET status = ?, status_at = ?, decided_by = ?, killed_by = ?, outcome = ?, applied_at = ? WHERE id = ?")
    .run(status, statusAt, decidedBy, killedBy, out, appliedAt, job.id);
  stmt(db, `INSERT INTO events (job_id, at, from_status, to_status, by, rule_id, prev_decided_by, prev_killed_by, undo_of, from_outcome, to_outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(job.id, at, job.status, status, by, ruleId, job.decided_by, job.killed_by, undoOf, job.outcome, out);
}

export function ingest(db, items, { source, channel }) {
  if (!Array.isArray(items)) throw httpError(400, "items phải là mảng");
  if (!source || !channel) throw httpError(400, "thiếu nguồn");
  const at = now();
  const compiled = compileRules(listRules(db));
  // ON CONFLICT chỉ bỏ qua trùng khóa. INSERT OR IGNORE sẽ nuốt cả lỗi NOT NULL/FK trong im lặng.
  const sighting = stmt(db, `INSERT INTO sightings (job_id, source, channel, url, seen_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (job_id, source) DO NOTHING`);
  const counts = { added: 0, auto: 0, dup: 0, skipped: 0 };

  db.transaction(() => {
    for (const raw of items) {
      const item = normalizeItem(raw ?? {});
      if (!item.title || !item.company) {
        counts.skipped++;
        continue;
      }
      const fp = fingerprint(item.company, item.title);
      const existing = stmt(db, "SELECT id FROM jobs WHERE fingerprint = ?").get(fp);
      if (existing) {
        // Gặp lại tin đã có: chỉ ghi thêm kênh. Không tạo job, không đụng status.
        sighting.run(existing.id, source, channel, item.url, at);
        counts.dup++;
        continue;
      }
      const hit = evaluate(item, compiled);
      const status = verdict(hit);
      const id = crypto.randomUUID();
      stmt(db, `INSERT INTO jobs (id, fingerprint, title, company, location, url, ad_language, description, note,
        posted_at, found_at, status, status_at, decided_by, killed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, fp, item.title, item.company, item.location, item.url, item.adLanguage, item.description, item.note,
          item.postedAt, at, status, at, hit ? "rule" : null, hit?.id ?? null);
      sighting.run(id, source, channel, item.url, at);
      stmt(db, "INSERT INTO events (job_id, at, from_status, to_status, by, rule_id) VALUES (?, ?, NULL, ?, ?, ?)")
        .run(id, at, status, hit ? "rule" : "system", hit?.id ?? null);
      counts.added++;
      if (hit) counts.auto++;
    }
  })();
  return counts;
}

/* Quyết định tay. killed_by giữ nguyên để còn hiện "luật: …"; decided_by = human là đủ để luật không đụng vào.
   outcome chỉ đi kèm status = 'applied'; "Trả về Hàng đọc" là decide(id, 'queue') và outcome tự về NULL. */
export function decide(db, id, status, outcome = null) {
  if (!STATUSES.includes(status)) throw httpError(400, `status không hợp lệ: ${status}`);
  if (outcome != null && !OUTCOMES.includes(outcome)) throw httpError(400, `outcome không hợp lệ: ${outcome}`);
  if (outcome != null && status !== "applied") throw httpError(400, "outcome chỉ đi kèm status 'applied'");
  return db.transaction(() => {
    const job = row(db, id);
    if (!job) throw httpError(404, "không có tin này");
    writeStatus(db, job, { status, outcome, decidedBy: "human", killedBy: job.killed_by, by: "human", at: now() });
    return getJob(db, id);
  })();
}

/* applied_at cho tin đã nộp trước v12: lần cuối bước vào applied theo events. Idempotent, chỉ điền chỗ trống.
   Gọi lúc mở DB (server, CLI) — db.js không được ghi vào jobs. */
export function backfillAppliedAt(db) {
  return stmt(db, `UPDATE jobs SET applied_at = (
      SELECT MAX(e.at) FROM events e WHERE e.job_id = jobs.id AND e.to_status = 'applied' AND e.from_status IS NOT 'applied')
    WHERE status = 'applied' AND applied_at IS NULL`).run().changes;
}

const UNDO_CANDIDATE = `
  SELECT e.* FROM events e JOIN jobs j ON j.id = e.job_id
  WHERE e.by = 'human'
    AND e.undo_of IS NULL
    AND NOT EXISTS (SELECT 1 FROM events u WHERE u.undo_of = e.id)
    AND j.status = e.to_status
    AND j.outcome IS e.to_outcome
  ORDER BY e.id DESC
  LIMIT 1`;
// undo_of IS NULL: bản thân lần hoàn tác không phải ứng viên, nên U không lặp giữa hai trạng thái.
// NOT EXISTS chứ không NOT IN: subquery chứa NULL làm NOT IN ra NULL cho mọi dòng, và U chết câm.
// j.status = e.to_status (và outcome): tin đã bị đổi sau quyết định đó (vd. tự lưu trữ) thì bỏ qua.

export const canUndo = (db) => Boolean(stmt(db, UNDO_CANDIDATE).get());

export function undo(db) {
  return db.transaction(() => {
    const e = stmt(db, UNDO_CANDIDATE).get();
    if (!e) return { nothing: true };
    const job = row(db, e.job_id);
    let status = e.from_status;
    let outcome = e.from_outcome;
    let decidedBy = e.prev_decided_by;
    let killedBy = e.prev_killed_by;
    // Trả tin về quyết định của một luật đã tắt sẽ phá nguyên tắc 3 — xử lý như lúc tắt luật.
    // U lúc này không còn là phép nghịch đảo, nên báo ruleOff để UI nói lý do.
    const ruleOff = decidedBy === "rule" && !stmt(db, "SELECT 1 FROM rules WHERE id = ? AND enabled = 1").get(killedBy);
    if (ruleOff) {
      status = reviveTarget(status);
      outcome = null;
      decidedBy = null;
      killedBy = null;
    }
    writeStatus(db, job, { status, outcome, decidedBy, killedBy, by: "human", undoOf: e.id, at: now(), resetClock: true });
    return { job: getJob(db, job.id), ruleOff };
  })();
}

export function toggleRule(db, ruleId) {
  return db.transaction(() => {
    const rule = stmt(db, "SELECT * FROM rules WHERE id = ?").get(ruleId);
    if (!rule) throw httpError(404, "không có luật này");
    const revived = { new: 0, maybe: 0 };
    if (!rule.enabled) {
      // Bật không tự chạy trên tin cũ — chỉ đánh dấu để UI nhắc.
      stmt(db, "UPDATE rules SET enabled = 1, needs_rerun = 1 WHERE id = ?").run(ruleId);
      return { enabled: true, revived };
    }
    stmt(db, "UPDATE rules SET enabled = 0, needs_rerun = 0 WHERE id = ?").run(ruleId);
    const at = now();
    // Cùng điều kiện với số "đang xử lý n tin" trên thẻ luật. = 'rule' loại cả NULL lẫn 'human' — đúng ý.
    for (const job of stmt(db, "SELECT * FROM jobs WHERE killed_by = ? AND decided_by = 'rule'").all(ruleId)) {
      const status = reviveTarget(job.status);
      writeStatus(db, job, { status, decidedBy: null, killedBy: null, by: "system", ruleId, at });
      revived[status]++;
    }
    return { enabled: false, revived };
  })();
}

export function rerunRules(db) {
  const compiled = compileRules(listRules(db));
  return db.transaction(() => {
    const at = now();
    let touched = 0;
    // IS NOT là so sánh an toàn với NULL. decided_by != 'human' sẽ bỏ sót mọi tin chưa ai quyết.
    const rows = stmt(db, "SELECT * FROM jobs WHERE status IN ('new','killed','doubt') AND decided_by IS NOT 'human'").all();
    for (const job of rows) {
      const hit = evaluate(asItem(job), compiled);
      const status = verdict(hit);
      const killedBy = hit?.id ?? null;
      if (status === job.status && killedBy === job.killed_by) continue;
      writeStatus(db, job, { status, decidedBy: hit ? "rule" : null, killedBy, by: hit ? "rule" : "system", ruleId: killedBy, at });
      touched++;
    }
    stmt(db, "UPDATE rules SET needs_rerun = 0").run();
    return { touched };
  })();
}

/* Nguồn ghi nhầm công ty (feed của công ty khác đội tên): loại mọi tin từng thấy ở nguồn đó, quyết định
   ghi là của người, kèm note. Không xóa gì. Tin đã killed thì chỉ cập nhật note. */
export function killBySource(db, source, note) {
  return db.transaction(() => {
    const at = now();
    let killed = 0;
    const rows = stmt(db, "SELECT j.* FROM jobs j JOIN sightings s ON s.job_id = j.id WHERE s.source = ?").all(source);
    for (const job of rows) {
      stmt(db, "UPDATE jobs SET note = ? WHERE id = ?").run(note, job.id);
      if (job.status === "killed" && job.decided_by === "human") continue;
      writeStatus(db, job, { status: "killed", decidedBy: "human", killedBy: job.killed_by, by: "human", at });
      killed++;
    }
    return { killed, total: rows.length };
  })();
}

/* Link tin đổi (công ty đặt mẫu link vì trang hosted của ATS chết): cập nhật jobs.url và sightings.url của nguồn đó.
   Không đụng status, không ghi event. */
export function relinkSource(db, source, links) {
  return db.transaction(() => {
    let changed = 0;
    for (const { fingerprint: fp, url } of links) {
      if (!url) continue;
      const j = stmt(db, "SELECT id, url FROM jobs WHERE fingerprint = ?").get(fp);
      if (!j) continue;
      const s = stmt(db, "SELECT url FROM sightings WHERE job_id = ? AND source = ?").get(j.id, source);
      if (s && s.url !== url) stmt(db, "UPDATE sightings SET url = ? WHERE job_id = ? AND source = ?").run(url, j.id, source);
      if (j.url !== url && (j.url === (s?.url ?? null) || !j.url || s)) { stmt(db, "UPDATE jobs SET url = ? WHERE id = ?").run(url, j.id); changed++; }
    }
    return { changed };
  })();
}

/* Tín hiệu tin còn sống, chỉ ATS cho được: feed 200 thật mà tin từng thấy ở nguồn này không còn → closed_at.
   Xuất hiện lại → bỏ closed_at. KHÔNG đổi status, không ghi event — chỉ là nhãn để khỏi mở tin chết. */
export function markClosed(db, source, liveFingerprints) {
  const live = new Set(liveFingerprints);
  return db.transaction(() => {
    const at = now();
    let closed = 0;
    let reopened = 0;
    const rows = stmt(db, `SELECT j.id, j.fingerprint, j.closed_at FROM jobs j
      JOIN sightings s ON s.job_id = j.id WHERE s.source = ?`).all(source);
    for (const j of rows) {
      const alive = live.has(j.fingerprint);
      if (!alive && !j.closed_at) { stmt(db, "UPDATE jobs SET closed_at = ? WHERE id = ?").run(at, j.id); closed++; }
      if (alive && j.closed_at) { stmt(db, "UPDATE jobs SET closed_at = NULL WHERE id = ?").run(j.id); reopened++; }
    }
    return { closed, reopened };
  })();
}

/* Người Xác nhận một đề xuất phản hồi (bước 3b). ĐƯỜNG DUY NHẤT bảng replies đụng tới jobs.
   rejection → Từ chối; interview, assessment → Phỏng vấn; ack, other, no_reply → chỉ ghi nhận, tin không đổi.
   Chỉ đổi tin còn ở applied và chưa có offer: người đã chuyển tin đi nơi khác thì quyết định đó thắng.
   Quyết định ghi là của người — Claude đề xuất, người bấm. */
const REPLY_OUTCOME = { rejection: "rejected", interview: "interview", assessment: "interview" };

export function confirmReply(db, replyId) {
  return db.transaction(() => {
    const r = replies.getReply(db, replyId);
    if (!r) throw httpError(404, "không có đề xuất này");
    if (r.resolution) throw httpError(409, "đề xuất này đã xử lý rồi");
    const job = row(db, r.jobId);
    const outcome = REPLY_OUTCOME[r.status] ?? null;
    let changed = false;
    if (outcome && job.status === "applied" && job.outcome !== "offer" && job.outcome !== outcome) {
      writeStatus(db, job, { status: "applied", outcome, decidedBy: "human", killedBy: job.killed_by, by: "human", at: now() });
      changed = true;
    }
    replies.resolveReply(db, replyId, "confirmed");
    return { reply: replies.getReply(db, replyId), job: getJob(db, job.id), changed };
  })();
}

/* Người bảo đề xuất Sai: chỉ đánh dấu. Không đụng jobs; lần kéo sau đề xuất y hệt không quay lại. */
export function rejectReply(db, replyId) {
  const r = replies.getReply(db, replyId);
  if (!r) throw httpError(404, "không có đề xuất này");
  if (r.resolution) throw httpError(409, "đề xuất này đã xử lý rồi");
  replies.resolveReply(db, replyId, "wrong");
  return { reply: replies.getReply(db, replyId) };
}

/* ---------------------------- bước 5: JD và fit ----------------------------
   Ba hàm dưới chỉ UPDATE cột JD/fit. KHÔNG đổi status, outcome, decided_by, không ghi event:
   phân tích là nhãn để đọc nhanh hơn, quyết định vẫn là của người (CLAUDE.md: LLM không đổi trạng thái tin). */

export const JD_SOURCES = ["ats", "fetched", "title_only"];

/* Tin ở Hàng đọc cần phân tích: chưa có fit, hoặc fit làm với CV khác CV hiện tại. Có description (ATS, hoặc đã
   fetch) thì trả về để khỏi fetch lại. Đây là chỗ DUY NHẤT description rời jobs.js — đi thẳng vào enrich, không ra UI. */
export function pendingFit(db, cvHash, limit = 20) {
  return stmt(db, `SELECT id, title, company, location, url, description, jd_source, deadline FROM jobs
    WHERE status = 'queue' AND (fit_json IS NULL OR fit_cv_hash IS NOT ?)
    ORDER BY found_at DESC, rowid ASC LIMIT ?`).all(cvHash, limit)
    .map((r) => ({ id: r.id, title: r.title, company: r.company, location: r.location, url: r.url, description: r.description, jdSource: r.jd_source, deadline: r.deadline }));
}

/* Một tin kèm description, cho nút Xuất JD (ghi ra file ngoài app, đọc ở chỗ khác). Không ra danh sách. */
export function readJd(db, id) {
  const r = stmt(db, "SELECT id, title, company, url, description, jd_source FROM jobs WHERE id = ?").get(id);
  return r ? { id: r.id, title: r.title, company: r.company, url: r.url, description: r.description, jdSource: r.jd_source } : null;
}

export const countPendingFit = (db, cvHash) =>
  stmt(db, "SELECT COUNT(*) n FROM jobs WHERE status = 'queue' AND (fit_json IS NULL OR fit_cv_hash IS NOT ?)").get(cvHash).n;

/* Kết quả lấy JD. description chỉ ghi khi có chữ (title_only giữ nguyên cái đang có). deadline từ JSON-LD của trang
   (validThrough) là dữ kiện của hệ thống, ghi đè. */
export function setJd(db, id, { description = null, source, httpStatus = null, deadline = null }) {
  if (!JD_SOURCES.includes(source)) throw httpError(400, `jd_source không hợp lệ: ${source}`);
  return db.transaction(() => {
    if (!row(db, id)) throw httpError(404, "không có tin này");
    stmt(db, "UPDATE jobs SET jd_source = ?, jd_http_status = ? WHERE id = ?").run(source, httpStatus, id);
    if (description) stmt(db, "UPDATE jobs SET description = ? WHERE id = ?").run(description, id);
    if (deadline) stmt(db, "UPDATE jobs SET deadline = ? WHERE id = ?").run(deadline, id);
  })();
}

/* Kết quả Claude. deadline do model trích chỉ điền chỗ trống — JSON-LD (setJd) thắng. */
export function setFit(db, id, { fit, cvHash, deadline = null }) {
  if (!fit || typeof fit !== "object") throw httpError(400, "thiếu fit");
  return db.transaction(() => {
    if (!row(db, id)) throw httpError(404, "không có tin này");
    stmt(db, "UPDATE jobs SET fit_json = ?, fit_cv_hash = ?, fit_at = ? WHERE id = ?").run(JSON.stringify(fit), cvHash, now(), id);
    if (deadline) stmt(db, "UPDATE jobs SET deadline = COALESCE(deadline, ?) WHERE id = ?").run(deadline, id);
  })();
}

/* Tự lưu trữ theo thời gian nằm trong thùng (status_at), không theo found_at. */
export function archiveStale(db) {
  const { value } = stmt(db, "SELECT value FROM settings WHERE key = 'maybe_ttl'").get() ?? {};
  const ttl = Number(value) || 21;
  return db.transaction(() => {
    const at = now();
    const cutoff = new Date(Date.parse(at) - ttl * DAY_MS).toISOString();
    // CHỈ maybe và doubt. Hàng đọc tự cạn trong im lặng là kiểu hỏng tệ nhất — có check riêng.
    const rows = stmt(db, "SELECT * FROM jobs WHERE status IN ('maybe','doubt') AND status_at < ?").all(cutoff);
    for (const job of rows) {
      writeStatus(db, job, { status: "archived", decidedBy: job.decided_by, killedBy: job.killed_by, by: "system", at });
    }
    return { moved: rows.length };
  })();
}
