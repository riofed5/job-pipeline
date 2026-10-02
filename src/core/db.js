import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SEED_RULES, SEED_SOURCES } from "./seed.js";

/* Mọi timestamp ghi vào DB đi qua đây: cùng một định dạng ISO UTC thì so sánh chuỗi mới đúng. */
export const now = () => new Date().toISOString();
/* Ngày theo giờ máy, YYYY-MM-DD. */
export const localDate = (d = new Date()) => d.toLocaleDateString("sv-SE");

const SCHEMA_V1 = `
CREATE TABLE rules (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  field       TEXT NOT NULL,              -- title | company | location | lang | any
  match       TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,              -- kill | doubt
  enabled     INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  TEXT NOT NULL,
  position    INTEGER NOT NULL,           -- thứ tự đánh giá
  needs_rerun INTEGER NOT NULL DEFAULT 0  -- bật/sửa rồi mà chưa chạy lại trên tin cũ
);

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,       -- norm(company)|norm(title)
  title       TEXT NOT NULL,
  company     TEXT NOT NULL,
  location    TEXT,
  url         TEXT,
  ad_language TEXT,                       -- fi | en | sv
  description TEXT,
  note        TEXT,
  posted_at   TEXT,
  found_at    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','queue','maybe','doubt','applied','killed','archived')),
  status_at   TEXT NOT NULL,              -- lần đổi status gần nhất; TTL tự lưu trữ tính từ đây
  decided_by  TEXT CHECK (decided_by IN ('rule','human')),
  killed_by   TEXT REFERENCES rules(id),
  summary     TEXT
);
CREATE INDEX jobs_status    ON jobs(status);
CREATE INDEX jobs_killed_by ON jobs(killed_by);

-- Một tin có thể xuất hiện ở nhiều kênh.
CREATE TABLE sightings (
  job_id  TEXT NOT NULL REFERENCES jobs(id),
  source  TEXT NOT NULL,                  -- ats:greenhouse:wolt | tmt | imap:linkedin | manual:linkedin
  channel TEXT NOT NULL,                  -- tên hiển thị
  url     TEXT,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (job_id, source)
);

CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  at              TEXT NOT NULL,
  from_status     TEXT,                   -- NULL = lần nạp đầu
  to_status       TEXT NOT NULL,
  by              TEXT NOT NULL,          -- human | rule | system
  rule_id         TEXT,
  prev_decided_by TEXT,
  prev_killed_by  TEXT,
  undo_of         INTEGER REFERENCES events(id)
);
CREATE INDEX events_job ON events(job_id);

CREATE TABLE companies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL DEFAULT '', careers_url TEXT,
  ats TEXT, ats_token TEXT, last_pull TEXT, note TEXT
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, url TEXT,
  alert_on INTEGER NOT NULL DEFAULT 0, last_pull TEXT
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
`;

/* v2 — bước 2/3: kết quả kéo theo công ty và theo nguồn, mail đã xử lý, tin đã đóng. */
const SCHEMA_V2 = `
ALTER TABLE companies ADD COLUMN last_new_at TEXT;   -- lần gần nhất kéo ra tin MỚI (không phải trùng)
ALTER TABLE companies ADD COLUMN pull_count  INTEGER; -- số tin giữ lại ở lần kéo gần nhất
ALTER TABLE companies ADD COLUMN pull_total  INTEGER; -- số tin feed trả về ở lần đó, trước lọc địa điểm
ALTER TABLE companies ADD COLUMN last_error  TEXT;
ALTER TABLE companies ADD COLUMN ats_etag    TEXT;
ALTER TABLE sources ADD COLUMN last_new_at TEXT;
ALTER TABLE sources ADD COLUMN pull_count  INTEGER;
ALTER TABLE sources ADD COLUMN last_error  TEXT;
ALTER TABLE jobs ADD COLUMN closed_at TEXT;           -- tin ats:* biến khỏi feed; chỉ đánh dấu, không đổi status

-- Mail đã đọc. Không đụng cờ hay label trên hộp thư; đây là bộ nhớ duy nhất.
CREATE TABLE mail_seen (
  message_id   TEXT PRIMARY KEY,                     -- Message-ID, hoặc hash(from+date+subject) khi thiếu
  processed_at TEXT NOT NULL,
  source       TEXT,
  found        INTEGER NOT NULL DEFAULT 0
);
`;

/* v3 — first_pull: để biết một nguồn đã được kéo bao lâu mà chưa ra tin mới nào. */
const SCHEMA_V3 = `
ALTER TABLE sources ADD COLUMN first_pull TEXT;
ALTER TABLE companies ADD COLUMN first_pull TEXT;
`;

/* v4 — ats_candidate: kết quả dò từ link MÁY đoán. Chỉ người duyệt mới thành ats. JSON {platform, token, total, url, at, error}. */
const SCHEMA_V4 = `
ALTER TABLE companies ADD COLUMN ats_candidate TEXT;
`;

/* v5 — jobs.deadline (để trống tới bước 5, enrich.js điền). Bỏ ETag ATS một lần vì bộ lọc địa điểm đổi:
   304 sẽ bỏ qua lọc lại, mà lần này chính bộ lọc là thứ cần chạy lại. */
const SCHEMA_V5 = `
ALTER TABLE jobs ADD COLUMN deadline TEXT;
UPDATE companies SET ats_etag = NULL;
`;

/* Luật mẫu thêm sau v1 cho DB đã có (seed chỉ chạy ở v1). Bật sẵn, needs_rerun để UI nhắc chạy lại. */
function insertSeedRule(db, id) {
  const r = SEED_RULES.find((x) => x.id === id);
  if (db.prepare("SELECT 1 FROM rules WHERE id = ?").get(r.id)) return;
  const { p } = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rules").get();
  db.prepare(`INSERT INTO rules (id, label, field, match, action, enabled, note, created_at, position, needs_rerun)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`).run(r.id, r.label, r.field, r.match, r.action, r.note, now(), p);
}
const migrateV6 = (db) => insertSeedRule(db, "r_abroad");

const MIGRATIONS = [
  (db) => {
    db.exec(SCHEMA_V1);
    const at = now();
    const rule = db.prepare(`INSERT INTO rules (id, label, field, match, action, enabled, note, created_at, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    SEED_RULES.forEach((r, i) => rule.run(r.id, r.label, r.field, r.match, r.action, r.enabled ? 1 : 0, r.note, at, i));
    const source = db.prepare("INSERT INTO sources (id, name, kind, url) VALUES (?, ?, ?, ?)");
    for (const s of SEED_SOURCES) source.run(s.id, s.name, s.kind, s.url);
    const setting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    setting.run("start_date", localDate());
    setting.run("maybe_ttl", "21");
  },
  (db) => {
    db.exec(SCHEMA_V2);
  },
  (db) => {
    db.exec(SCHEMA_V3);
  },
  (db) => {
    db.exec(SCHEMA_V4);
  },
  (db) => {
    db.exec(SCHEMA_V5);
  },
  migrateV6,
  /* v7 — r_abroad bỏ "in" và "no" (trùng từ tiếng Anh), thay bằng india, norway. Chỉ sửa nếu người chưa đổi tay. */
  (db) => {
    db.prepare("UPDATE rules SET match = ?, needs_rerun = 1 WHERE id = 'r_abroad' AND match = ?")
      .run("us, gb, uk, pl, de, se, dk, ca, india, norway", "us, gb, uk, pl, de, se, no, dk, in, ca");
  },
  /* v8 — luật mẫu r_openapp: đơn mở → Ngờ vực. */
  (db) => insertSeedRule(db, "r_openapp"),
  /* v9 — từ khóa mới cho r_notrole và r_senior_hard (NOTES 2026-09-18). Chỉ sửa nếu người chưa đổi tay. */
  (db) => {
    const upd = db.prepare("UPDATE rules SET match = ?, needs_rerun = 1 WHERE id = ? AND match = ?");
    upd.run(SEED_RULES.find((r) => r.id === "r_notrole").match, "r_notrole",
      "sales, marketing, recruiter, talent acquisition, hr, account manager, designer, ux, customer success, support specialist, controller, accountant");
    upd.run(SEED_RULES.find((r) => r.id === "r_senior_hard").match, "r_senior_hard",
      "lead, principal, head of, director, staff engineer, architect, vp of, chief, manager");
  },
  /* v10 — luật mẫu r_otherlang: tiêu đề bằng/đòi ngôn ngữ khác → Ngờ vực. */
  (db) => insertSeedRule(db, "r_otherlang"),
  /* v11 — companies.job_url_template: công ty tắt trang hosted của ATS (Supercell) thì dựng link tin từ mẫu
     của trang công ty, {id} và {slug} thay bằng id và slug của tin. */
  (db) => {
    if (!db.pragma("table_info(companies)").some((c) => c.name === "job_url_template")) {
      db.exec("ALTER TABLE companies ADD COLUMN job_url_template TEXT");
    }
  },
  /* v12 — bước 3b. jobs.outcome: giai đoạn SAU khi nộp (phỏng vấn / từ chối / offer), status vẫn là 'applied' —
     CHECK của status không nới. jobs.applied_at: lần chuyển sang applied gần nhất, để hiện "N ngày".
     events ghi cả outcome trước/sau, không thì đổi outcome không có lịch sử và U không hoàn tác được.
     Backfill applied_at từ events nằm ở jobs.backfillAppliedAt (chỉ jobs.js được ghi vào jobs). */
  (db) => {
    const has = (table, col) => db.pragma(`table_info(${table})`).some((c) => c.name === col);
    if (!has("jobs", "outcome")) db.exec("ALTER TABLE jobs ADD COLUMN outcome TEXT CHECK (outcome IN ('interview','rejected','offer'))");
    if (!has("jobs", "applied_at")) db.exec("ALTER TABLE jobs ADD COLUMN applied_at TEXT");
    if (!has("events", "from_outcome")) db.exec("ALTER TABLE events ADD COLUMN from_outcome TEXT");
    if (!has("events", "to_outcome")) db.exec("ALTER TABLE events ADD COLUMN to_outcome TEXT");
  },
  /* v13 — phản hồi của công ty (replies.js). Mail tìm được theo tên công ty lưu ở reply_mails để UI hiện bằng
     chứng không cần IMAP; một mail có thể khớp nhiều công ty nên khóa là (message_id, company_key).
     replies là ĐỀ XUẤT của Claude — không đụng jobs; chỉ khi người Xác nhận (jobs.confirmReply) tin mới đổi.
     reply_runs nhớ hash đầu vào mỗi công ty để không gọi Claude lại khi không có gì mới.
     companies.aliases: tên khác (phân cách bằng dấu phẩy) dùng thêm trong IMAP SEARCH. */
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reply_mails (
        message_id  TEXT NOT NULL,
        company_key TEXT NOT NULL,                 -- norm(tên công ty trên tin)
        from_addr   TEXT,
        subject     TEXT,
        date        TEXT,
        text        TEXT,                          -- đã cắt, không link
        fetched_at  TEXT NOT NULL,
        PRIMARY KEY (message_id, company_key)
      );
      CREATE TABLE IF NOT EXISTS reply_runs (
        company_key TEXT PRIMARY KEY,
        input_hash  TEXT NOT NULL,
        ran_at      TEXT NOT NULL,
        mails       INTEGER NOT NULL DEFAULT 0,
        proposals   INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS replies (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id              TEXT NOT NULL REFERENCES jobs(id),
        company_key         TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('no_reply','ack','rejection','interview','assessment','other')),
        evidence_message_id TEXT,                  -- phải nằm trong reply_mails của công ty đó lúc đề xuất
        note                TEXT,
        proposed_at         TEXT NOT NULL,
        resolution          TEXT CHECK (resolution IN ('confirmed','wrong')),
        resolved_at         TEXT
      );
      CREATE INDEX IF NOT EXISTS replies_job ON replies(job_id);
    `);
    if (!db.pragma("table_info(companies)").some((c) => c.name === "aliases")) db.exec("ALTER TABLE companies ADD COLUMN aliases TEXT");
  },
  /* v14 — bước 5, phân tích fit (enrich.js). fit_json: kết quả Claude {fit, reason, confidence, gaps, strengths,
     years_required, finnish_required} — chỉ là nhãn, không đổi status. fit_cv_hash: hash profile/cv.md lúc phân tích,
     lệch hash hiện tại = "CV đã đổi, phân tích lại". jd_source: ats | fetched | title_only — JD lấy từ đâu;
     title_only thì confidence bị ép low. jd_http_status: mã HTTP lần fetch gần nhất; 404/410 là tin chết (do hệ thống,
     cùng với closed_at và deadline đã qua). JD fetch được ghi vào jobs.description có sẵn. */
  (db) => {
    const has = (col) => db.pragma("table_info(jobs)").some((c) => c.name === col);
    if (!has("fit_json")) db.exec("ALTER TABLE jobs ADD COLUMN fit_json TEXT");
    if (!has("fit_cv_hash")) db.exec("ALTER TABLE jobs ADD COLUMN fit_cv_hash TEXT");
    if (!has("fit_at")) db.exec("ALTER TABLE jobs ADD COLUMN fit_at TEXT");
    if (!has("jd_source")) db.exec("ALTER TABLE jobs ADD COLUMN jd_source TEXT CHECK (jd_source IN ('ats','fetched','title_only'))");
    if (!has("jd_http_status")) db.exec("ALTER TABLE jobs ADD COLUMN jd_http_status INTEGER");
  },
  /* v15 — lý do loại tay. events.reason cùng mã với fit.reason (+ dead, other) để so người với model;
     reason_source: human = người chọn ở picker, model = "Loại tất cả off-profile" chép fit.reason của tin.
     Phím 4 ở Hộp đến và nút Loại ở thùng khác không hỏi → NULL. Chỉ event by = human, to_status = killed có giá trị. */
  (db) => {
    const has = (col) => db.pragma("table_info(events)").some((c) => c.name === col);
    if (!has("reason")) db.exec("ALTER TABLE events ADD COLUMN reason TEXT CHECK (reason IN ('domain','stack','level_low','level_high','language','location','dead','other'))");
    if (!has("reason_text")) db.exec("ALTER TABLE events ADD COLUMN reason_text TEXT");
    if (!has("reason_source")) db.exec("ALTER TABLE events ADD COLUMN reason_source TEXT CHECK (reason_source IN ('human','model'))");
  },
];

export function openDb(file) {
  const memory = file === ":memory:";
  if (!memory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (!memory) db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true });
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

/* Dump mọi bảng cho nút "Tải file sao lưu". Đây là file sao lưu, không phải màn hình — có description. */
export function exportAll(db) {
  const tables = ["jobs", "sightings", "events", "rules", "companies", "sources", "settings", "mail_seen", "reply_mails", "reply_runs", "replies"];
  return {
    exportedAt: now(),
    schemaVersion: db.pragma("user_version", { simple: true }),
    ...Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()])),
  };
}

/* ---------------------------- sao lưu ----------------------------
   Tự kích hoạt: gọi lúc khởi động và ở mỗi request ghi. Không có timer —
   chỉ so thời điểm bản gần nhất trong bộ nhớ. VACUUM INTO chứ không cp file,
   vì với WAL bản cp có thể thiếu phần chưa checkpoint. */

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const BACKUP_NAME = /^jobs-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

export function createBackups(db, dir, { maxAgeMs = DAY_MS, keep = 30 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const list = () => fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f)).sort();

  const newest = list().at(-1);
  let lastAt = newest ? fs.statSync(path.join(dir, newest)).mtimeMs : null;
  let lastError = null;
  let failedAt = 0;

  function run() {
    // Bản dở dang từ lần bị ngắt: VACUUM INTO sẽ ném lỗi nếu file đích đã tồn tại.
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".tmp")) fs.rmSync(path.join(dir, f), { force: true });
    const final = path.join(dir, `jobs-${now().replace(/[:.]/g, "-")}.db`);
    const tmp = `${final}.tmp`;
    db.prepare("VACUUM INTO ?").run(tmp);
    fs.renameSync(tmp, final);
    lastAt = Date.now();
    lastError = null;
    const files = list();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
    return final;
  }

  function runIfStale() {
    const t = Date.now();
    if (lastAt !== null && t - lastAt < maxAgeMs) return false;
    if (lastError && t - failedAt < RETRY_MS) return false;
    try {
      run();
      return true;
    } catch (e) {
      lastError = e.message;
      failedAt = t;
      console.error("Sao lưu thất bại:", e.message);
      return false;
    }
  }

  const status = () => ({
    lastBackupAt: lastAt === null ? null : new Date(lastAt).toISOString(),
    backupError: lastError,
  });

  return { run, runIfStale, status };
}
