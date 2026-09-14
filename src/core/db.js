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
  field       TEXT NOT NULL,              -- title | company | lang | any
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
