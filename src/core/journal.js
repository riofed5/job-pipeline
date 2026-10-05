import { now, localDate } from "./db.js";
import { weeksBetween, isoWeek } from "./week.js";

/* Tab Nhật ký (bước 5b). Chỉ ĐỌC jobs, events, people, replies; ghi duy nhất vào weekly_log.
   Không có LLM ở đây: mọi con số đều đếm từ quyết định của người. */

const DAY_MS = 24 * 60 * 60 * 1000;
const ACK_DAYS = 3;
export const GUT_MIN_SAMPLE = 10;
const httpError = (status, message) => Object.assign(new Error(message), { status });

/* "On-profile" theo fit_json HIỆN TẠI: model nói on, hoặc chưa phân tích (NULL). Off thì không tính vào tiến độ —
   nộp hồ sơ off-profile không phải input đáng đếm. */
const ON_PROFILE = "(json_extract(j.fit_json, '$.fit') IS NULL OR json_extract(j.fit_json, '$.fit') = 'on')";
/* Event còn hiệu lực: không phải lần hoàn tác, và chưa bị hoàn tác. */
const LIVE = "e.undo_of IS NULL AND NOT EXISTS (SELECT 1 FROM events u WHERE u.undo_of = e.id)";

const dayOf = (iso) => localDate(new Date(iso));

/* Tuần ISO từ start_date tới hôm nay, mới nhất trước. apps = số tin on-profile BƯỚC VÀO Đã nộp trong tuần (distinct);
   messages = người có contacted_at trong tuần; prep / prepNote từ weekly_log. */
export function weeklyProgress(db, today = localDate()) {
  const { value: start } = db.prepare("SELECT value FROM settings WHERE key = 'start_date'").get() ?? { value: today };
  const weeks = weeksBetween(start < today ? start : today, today);
  const apps = new Map();
  const seen = new Set();
  for (const e of db.prepare(`SELECT e.at, e.job_id FROM events e JOIN jobs j ON j.id = e.job_id
      WHERE e.by = 'human' AND e.to_status = 'applied' AND e.from_status IS NOT 'applied' AND ${LIVE} AND ${ON_PROFILE}
      ORDER BY e.id`).all()) {
    const w = isoWeek(dayOf(e.at));
    const key = `${w}|${e.job_id}`;
    if (seen.has(key)) continue; // nộp, hoàn tác, nộp lại trong cùng tuần: một hồ sơ
    seen.add(key);
    apps.set(w, (apps.get(w) ?? 0) + 1);
  }
  const messages = new Map();
  for (const p of db.prepare("SELECT contacted_at FROM people WHERE contacted_at IS NOT NULL").all()) {
    const w = isoWeek(p.contacted_at);
    messages.set(w, (messages.get(w) ?? 0) + 1);
  }
  const logs = new Map(db.prepare("SELECT * FROM weekly_log").all().map((r) => [r.week, r]));
  return weeks.map((w) => ({
    ...w,
    current: w.week === isoWeek(today),
    apps: apps.get(w.week) ?? 0,
    messages: messages.get(w.week) ?? 0,
    prep: logs.get(w.week)?.prep ?? null,
    prepNote: logs.get(w.week)?.prep_note ?? "",
  }));
}

/* Số nhập tay của một tuần. prep null = xóa trống. */
export function setWeeklyLog(db, week, { prep = null, prepNote = null } = {}) {
  if (!/^\d{4}-W\d{2}$/.test(String(week))) throw httpError(400, "tuần phải có dạng YYYY-Www");
  if (prep != null && (!Number.isInteger(prep) || prep < 0)) throw httpError(400, "prep phải là số nguyên không âm");
  const note = prepNote == null ? null : String(prepNote).trim() || null;
  db.prepare(`INSERT INTO weekly_log (week, prep, prep_note, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (week) DO UPDATE SET prep = excluded.prep, prep_note = excluded.prep_note, updated_at = excluded.updated_at`)
    .run(week, prep, note, now());
  const r = db.prepare("SELECT * FROM weekly_log WHERE week = ?").get(week);
  return { week: r.week, prep: r.prep, prepNote: r.prep_note ?? "" };
}

/* Ba số dưới bảng tuần, trên hồ sơ on-profile đang ở Đã nộp / Phỏng vấn / Offer / Từ chối:
   - ackRate: trong số hồ sơ nộp ≥ 3 ngày trước, bao nhiêu % có hồi âm trong 3 ngày — reply người đã Xác nhận
     (khác no_reply, ngày mail ≤ applied_at + 3 ngày) hoặc đổi outcome trong 3 ngày.
   - daysToRejection: trung bình ngày từ applied_at tới event từ chối đầu tiên còn hiệu lực.
   - interviewRate: từng tới Phỏng vấn hoặc Offer (event còn hiệu lực) / tổng. */
export function funnel(db, today = localDate()) {
  const jobs = db.prepare(`SELECT j.id, j.applied_at FROM jobs j WHERE j.status = 'applied' AND ${ON_PROFILE}`).all();
  const nowMs = Date.parse(`${today}T23:59:59.999Z`);
  const outcomes = new Map();
  for (const e of db.prepare(`SELECT e.job_id, e.at, e.to_outcome FROM events e
      WHERE e.to_outcome IS NOT NULL AND e.to_outcome IS NOT e.from_outcome AND ${LIVE} ORDER BY e.id`).all()) {
    if (!outcomes.has(e.job_id)) outcomes.set(e.job_id, []);
    outcomes.get(e.job_id).push(e);
  }
  const mails = new Map();
  for (const r of db.prepare(`SELECT r.job_id, m.date FROM replies r
      JOIN reply_mails m ON m.message_id = r.evidence_message_id AND m.company_key = r.company_key
      WHERE r.resolution = 'confirmed' AND r.status != 'no_reply' AND m.date IS NOT NULL`).all()) {
    if (!mails.has(r.job_id)) mails.set(r.job_id, []);
    mails.get(r.job_id).push(r.date);
  }
  let ackPool = 0, acked = 0, interviewed = 0;
  const rejectionDays = [];
  for (const j of jobs) {
    const applied = Date.parse(j.applied_at);
    const limit = applied + ACK_DAYS * DAY_MS;
    const evs = outcomes.get(j.id) ?? [];
    if (nowMs >= limit) {
      ackPool++;
      const byMail = (mails.get(j.id) ?? []).some((d) => Date.parse(d) >= applied && Date.parse(d) <= limit);
      const byOutcome = evs.some((e) => Date.parse(e.at) <= limit);
      if (byMail || byOutcome) acked++;
    }
    if (evs.some((e) => e.to_outcome === "interview" || e.to_outcome === "offer")) interviewed++;
    const rej = evs.find((e) => e.to_outcome === "rejected");
    if (rej) rejectionDays.push((Date.parse(rej.at) - applied) / DAY_MS);
  }
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  return {
    total: jobs.length,
    ackPool,
    acked,
    ackRate: ackPool ? Math.round((acked / ackPool) * 100) : null,
    rejected: rejectionDays.length,
    daysToRejection: avg(rejectionDays),
    interviewed,
    interviewRate: jobs.length ? Math.round((interviewed / jobs.length) * 100) : null,
  };
}

/* Ghi chú hồ sơ: event còn hiệu lực có note hoặc gut, mới nhất trước. Không có mô tả công việc. */
export function journalEntries(db) {
  return db.prepare(`SELECT e.id, e.at, e.from_status, e.to_status, e.from_outcome, e.to_outcome, e.note, e.gut,
      j.id AS job_id, j.title, j.company, j.status AS job_status, j.outcome AS job_outcome
    FROM events e JOIN jobs j ON j.id = e.job_id
    WHERE (e.note IS NOT NULL OR e.gut IS NOT NULL) AND ${LIVE}
    ORDER BY e.id DESC`).all().map((e) => ({
    id: e.id, at: e.at, fromStatus: e.from_status, toStatus: e.to_status, fromOutcome: e.from_outcome, toOutcome: e.to_outcome,
    note: e.note, gut: e.gut,
    job: { id: e.job_id, title: e.title, company: e.company, status: e.job_status, outcome: e.job_outcome },
  }));
}

/* Gut × kết quả hiện tại: mỗi hồ sơ lấy gut của lần bước vào Đã nộp gần nhất còn hiệu lực. Kết quả theo tin HIỆN TẠI:
   chờ (applied, outcome NULL) / phỏng vấn (interview, offer) / từ chối; tin đã rời applied không tính.
   Dưới GUT_MIN_SAMPLE hồ sơ thì rows = null — ít mẫu thì bảng chỉ gây ảo giác. */
export function gutTable(db) {
  const rows = db.prepare(`SELECT e.gut, j.outcome FROM events e JOIN jobs j ON j.id = e.job_id
    WHERE e.gut IS NOT NULL AND e.to_status = 'applied' AND j.status = 'applied' AND ${LIVE}
      AND e.id = (SELECT MAX(x.id) FROM events x WHERE x.job_id = e.job_id AND x.gut IS NOT NULL
                  AND x.undo_of IS NULL AND NOT EXISTS (SELECT 1 FROM events u WHERE u.undo_of = x.id))`).all();
  const table = [1, 2, 3, 4, 5].map((gut) => ({ gut, waiting: 0, interview: 0, rejected: 0 }));
  for (const r of rows) {
    const t = table[r.gut - 1];
    if (r.outcome === "rejected") t.rejected++;
    else if (r.outcome === "interview" || r.outcome === "offer") t.interview++;
    else t.waiting++;
  }
  return { sample: rows.length, min: GUT_MIN_SAMPLE, rows: rows.length >= GUT_MIN_SAMPLE ? table : null };
}

export const journal = (db, today = localDate()) => ({
  weeks: weeklyProgress(db, today),
  funnel: funnel(db, today),
  entries: journalEntries(db),
  gut: gutTable(db),
});
