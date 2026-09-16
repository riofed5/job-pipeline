/* Kéo mọi nguồn đã cấu hình. Chạy nền trong process của server, không timer: start() trả về ngay,
   status() cho UI hỏi. runIfStale() cùng cơ chế với sao lưu — chỉ so last_pull, không lịch.
   Mọi tin đi qua jobs.ingest như dán tay, nên luật và lọc trùng chạy y hệt.

   CLI: node src/ingest/pull.js   kéo một lần rồi thoát (không cần UI mở). */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { now } from "../core/db.js";
import * as jobs from "../core/jobs.js";
import * as config from "../core/config.js";
import { fingerprint } from "../core/dedupe.js";
import { fetchAts as realFetchAts, filterLocation } from "./ats.js";
import { imapConfigured, createImapStep } from "./imap.js";
import { summarize } from "./summary.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STALE_MS = 12 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const atsSource = (c) => ({ source: `ats:${c.ats}:${c.atsToken}`, channel: "Trang công ty" });

/* Nạp .env ở gốc repo nếu có. Node 20.12+ có sẵn, không cần dotenv. */
export function loadEnv() {
  try { process.loadEnvFile(path.join(ROOT, ".env")); } catch { /* không có .env thì thôi */ }
}

/* Nguồn ngoài ATS đang cấu hình: IMAP khi đủ biến môi trường. */
export const defaultExtra = () => (imapConfigured() ? [createImapStep()] : []);

export function createPuller(db, { fetchAts = realFetchAts, extra = defaultExtra(), gapMs = 1000, staleMs = STALE_MS, log = () => {} } = {}) {
  let running = false;
  let startedAt = null;
  let finishedAt = null;
  let results = [];
  let fatal = null;

  /* Một công ty ATS → một dòng kết quả. total/kept/dropped để bộ lọc địa điểm không mù. */
  async function pullCompany(c, locations) {
    const r = { kind: "ats", id: c.id, name: c.name, platform: c.ats, total: 0, kept: 0, dropped: 0, added: 0, auto: 0, dup: 0, closed: 0, error: null, notModified: false };
    try {
      const feed = await fetchAts(c.ats, c.atsToken, { etag: c.atsEtag });
      if (feed.notModified) {
        r.notModified = true;
        r.total = c.pullTotal ?? 0;
        r.kept = c.pullCount ?? 0;
        r.dropped = r.total - r.kept;
        config.markCompanyPull(db, c.id, { added: 0, count: c.pullCount, total: c.pullTotal });
        return r;
      }
      const { kept, dropped } = filterLocation(feed.items, locations);
      r.total = feed.items.length;
      r.kept = kept.length;
      r.dropped = dropped.length;
      const counts = jobs.ingest(db, kept.map((it) => ({ ...it, company: c.name })), atsSource(c));
      Object.assign(r, { added: counts.added, auto: counts.auto, dup: counts.dup });
      // Feed 200 thật (không phải 304): tin ats:* từng có mà không còn trong feed → đã đóng.
      const live = feed.items.map((it) => fingerprint(c.name, it.title));
      r.closed = jobs.markClosed(db, atsSource(c).source, live).closed;
      config.markCompanyPull(db, c.id, { added: counts.added, count: kept.length, total: feed.items.length, etag: feed.etag });
    } catch (e) {
      r.error = e.message;
      config.markCompanyPull(db, c.id, { error: e.message });
    }
    return r;
  }

  async function run() {
    const { pullLocations } = config.getSettings(db);
    const companies = config.listCompanies(db).filter((c) => c.ats && c.ats !== "manual" && c.atsToken);
    for (let i = 0; i < companies.length; i++) {
      if (i) await sleep(gapMs); // lịch sự: 1 req/giây
      const r = await pullCompany(companies[i], pullLocations);
      results.push(r);
      log(r);
    }
    // Nguồn khác (IMAP ở bước 3): mỗi cái là hàm async trả về mảng kết quả cùng dạng.
    for (const step of extra) {
      try {
        for (const r of await step(db)) { results.push(r); log(r); }
      } catch (e) {
        results.push({ kind: step.kind ?? "extra", name: step.label ?? "nguồn", added: 0, auto: 0, dup: 0, error: e.message });
      }
    }
    const at = now();
    config.setSetting(db, "last_pull", at);
    config.setSetting(db, "last_pull_result", JSON.stringify({ at, startedAt, results }));
  }

  function start() {
    if (running) return { started: false, ...status() };
    running = true;
    fatal = null;
    startedAt = now();
    finishedAt = null;
    results = [];
    run()
      .catch((e) => { fatal = e.message; console.error("Kéo thất bại:", e); })
      .finally(() => { running = false; finishedAt = now(); });
    return { started: true, ...status() };
  }

  /* Gọi lúc mở app. Quá 12 tiếng (hoặc chưa kéo lần nào) và không đang chạy thì kéo. */
  function runIfStale() {
    if (running) return { started: false, ...status() };
    const { lastPull } = config.getSettings(db);
    if (lastPull && Date.now() - Date.parse(lastPull) < staleMs) return { started: false, ...status() };
    return start();
  }

  function status() {
    const { lastPull, lastPullResult } = config.getSettings(db);
    return { running, startedAt, finishedAt, results: running ? results : (lastPullResult?.results ?? results), lastPull, error: fatal };
  }

  /* Cho CLI và kiểm: đợi lần đang chạy xong. */
  async function wait() {
    while (running) await sleep(20);
    return status();
  }

  return { start, runIfStale, status, wait };
}

/* ---------------------------- CLI ---------------------------- */

async function main() {
  loadEnv();
  const { openDb } = await import("../core/db.js");
  const db = openDb(path.join(process.env.DATA_DIR || path.join(ROOT, "data"), "jobs.db"));
  const puller = createPuller(db, {
    log: (r) => console.log(`${(r.name ?? "").padEnd(28)} ${r.error ? `LỖI ${r.error}` : r.kind === "imap"
      ? `${r.mails} mail · ${r.added} mới · ${r.dup} trùng`
      : `${r.total ?? "-"} tin · ${r.kept ?? "-"} giữ · ${r.dropped ?? "-"} ngoài phạm vi · ${r.added} mới · ${r.dup} trùng${r.notModified ? " (không đổi)" : ""}`}`),
  });
  puller.start();
  const s = await puller.wait();
  console.log(summarize(s.results));
  db.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
