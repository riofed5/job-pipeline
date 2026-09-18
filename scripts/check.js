/* Canh bốn nguyên tắc trong CLAUDE.md. Chạy: node scripts/check.js
   Không dependency, không framework. Mỗi kịch bản chạy trên DB :memory: riêng,
   không bao giờ đụng data/jobs.db. Sửa core/ thì thêm kịch bản ở đây. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, createBackups } from "../src/core/db.js";
import * as J from "../src/core/jobs.js";
import * as C from "../src/core/config.js";
import { fingerprint } from "../src/core/dedupe.js";
import { compileRules, compileTerm, evaluate } from "../src/core/rules.js";
import { manualSource } from "../src/ingest/normalize.js";
import { htmlToText } from "../src/ingest/html.js";
import { sortJobs } from "../src/ui/sort.js";
import { parseFeed, filterLocation, guessLanguage, fetchAts, hasForeignCountry, slugify, applyUrlTemplate } from "../src/ingest/ats.js";
import { guessFromUrl, guessFromHtml, detectAts } from "../src/ingest/detect-ats.js";
import { createPuller, atsSource } from "../src/ingest/pull.js";
import { summarize } from "../src/ingest/summary.js";
import { mailKey, mailText, mailChannel, sourceFor, extractJobs, createImapStep, imapConfigured, fetchAlertMails, buildRequest, parseJobsJson } from "../src/ingest/imap.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 60 * 60 * 1000;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: cần ${b}, thực tế ${a}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
}

const LINKEDIN = manualSource("LinkedIn");
const DUUNITORI = manualSource("Duunitori");

const one = (db, sql, ...p) => db.prepare(sql).get(...p);
const job = (db, id) => one(db, "SELECT * FROM jobs WHERE id = ?", id);
const state = (db, id) => {
  const j = job(db, id);
  return [j.status, j.decided_by, j.killed_by];
};
function add(db, title, company = "Wolt", extra = {}, src = LINKEDIN) {
  J.ingest(db, [{ title, company, ...extra }], src);
  return one(db, "SELECT * FROM jobs WHERE fingerprint = ?", fingerprint(company, title));
}
/* Lùi đồng hồ ngay trong script kiểm, không thêm móc thời gian vào code thật. */
function backdate(db, id, days, cols) {
  const at = new Date(Date.now() - days * DAY).toISOString();
  for (const c of cols) db.prepare(`UPDATE jobs SET ${c} = ? WHERE id = ?`).run(at, id);
}

/* Bất biến — kiểm sau mỗi kịch bản có DB. */
function invariants(db) {
  const none = (sql, what) => {
    const rows = db.prepare(sql).all();
    if (rows.length) throw new Error(`bất biến gãy — ${what}: ${JSON.stringify(rows.slice(0, 3))}`);
  };
  none(`SELECT j.id, j.status, j.killed_by FROM jobs j LEFT JOIN rules r ON r.id = j.killed_by
        WHERE j.decided_by = 'rule' AND (r.id IS NULL OR r.enabled = 0 OR j.status NOT IN ('killed','doubt','archived'))`,
    "tin do luật quyết phải gắn với một luật đang bật");
  none("SELECT id, status FROM jobs WHERE decided_by IS NULL AND status NOT IN ('new','maybe','archived')",
    "tin chưa ai quyết chỉ nằm ở new/maybe/archived");
  none("SELECT j.id FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM sightings s WHERE s.job_id = j.id)",
    "tin nào cũng có ít nhất một sighting");
  none(`SELECT j.id, j.status FROM jobs j
        WHERE j.status IS NOT (SELECT e.to_status FROM events e WHERE e.job_id = j.id ORDER BY e.id DESC LIMIT 1)`,
    "status phải khớp event cuối — mọi lần đổi status đều có event");
}

function scanSrc(re) {
  const hits = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(js|jsx|html|sql)$/.test(f.name)) {
        fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
          if (re.test(line)) hits.push(`${path.relative(ROOT, p)}:${i + 1}`);
        });
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return hits;
}

/* ============================ kịch bản ============================ */

check("nạp trùng: thêm sighting, không thêm job, không đụng status", () => {
  const db = openDb(":memory:");
  const a = add(db, "Backend Engineer");
  J.decide(db, a.id, "queue");
  eq(J.ingest(db, [{ title: " Backend  Engineer", company: "wolt" }], LINKEDIN), { added: 0, auto: 0, dup: 1, skipped: 0 }, "kết quả nạp lại");
  eq(one(db, "SELECT COUNT(*) n FROM jobs").n, 1, "số job");
  eq(one(db, "SELECT COUNT(*) n FROM sightings").n, 1, "cùng nguồn không nhân đôi sighting");
  eq(job(db, a.id).status, "queue", "status sau khi gặp lại");
  invariants(db);
});

check("cùng tin từ LinkedIn và Duunitori: hai sighting, hai kênh", () => {
  const db = openDb(":memory:");
  const a = add(db, "Backend Engineer");
  J.ingest(db, [{ title: "Backend Engineer", company: "Wolt" }], DUUNITORI);
  eq([LINKEDIN.source, DUUNITORI.source], ["manual:linkedin", "manual:duunitori"], "source key");
  eq(one(db, "SELECT COUNT(*) n FROM sightings WHERE job_id = ?", a.id).n, 2, "số sighting");
  eq(J.getJob(db, a.id).channels, ["LinkedIn", "Duunitori"], "channels");
  invariants(db);
});

check("fingerprint: bỏ dấu; chữ ngoài Latin không đè nhau", () => {
  eq(fingerprint("Wärtsilä", "Ohjelmistokehittäjä"), fingerprint("Wartsila", "Ohjelmistokehittaja"), "Wärtsilä = Wartsila");
  eq(fingerprint("Ørsted", "Engineer"), fingerprint("Orsted", "Engineer"), "Ørsted = Orsted");
  ok(fingerprint("Yandex", "Инженер") !== fingerprint("Yandex", "Разработчик"), "hai chức danh Kirin khác nhau bị trùng fingerprint");
});

check("khớp nguyên từ, ranh giới Unicode, dấu *", () => {
  const hits = (match, title) =>
    Boolean(evaluate({ title }, compileRules([{ id: "t", field: "title", match, action: "kill", enabled: 1, position: 0 }])));
  const cases = [
    ["ux", "Linux Engineer", false],
    ["ux", "UX Designer", true],
    ["sales", "Salesforce Developer", false],
    ["sales", "Sales Manager", true],
    ["hr", "Three.js Developer", false],
    ["hr", "Chrome Extension Engineer", false],
    ["hr", "HR Specialist", true],
    ["kehitt", "Kehittäjä", false], // \b của JS sẽ khớp ở đây vì coi ä là ranh giới
    ["kehittäjä", "Ohjelmistokehittäjä", false],
    ["*kehittäjä", "Ohjelmistokehittäjä", true],
    ["*kehittäjä", "Ohjelmistokehittäjää", false],
    ["*kehittäjä*", "Ohjelmistokehittäjää", true],
    ["*kehittäjä*", "ohjelmistokehittäjän", true],
    ["myynti*", "Myyntipäällikkö", true],
    ["KEHITTÄJÄ", "kehittäjä", true],
    ["kehittäjä", "Kehitta\u0308ja\u0308", true], // chuỗi dạng NFD (dán từ macOS)
    ["head of", "Head  of Engineering", true],
    ["c++ (", "C++ ( lạ", true],
    [".net", ".NET Developer", true],
    ["*", "bất kỳ", false],
  ];
  for (const [m, t, want] of cases) eq(hits(m, t), want, `"${m}" trên "${t}"`);
  eq(compileTerm("*"), null, "'*' đứng một mình bị bỏ qua");
  compileTerm("(("); // không được ném lỗi
});

check("luật mẫu r_abroad: bật sẵn, có ở DB mới lẫn DB cũ qua migration, loại theo mã nước", () => {
  const db = openDb(":memory:");
  const r = C.getRule(db, "r_abroad");
  ok(r && r.enabled && r.field === "location" && r.action === "kill", "luật mẫu có và bật");
  const a = add(db, "Backend Engineer", "Konecranes", { location: "Garner, us, Remote" });
  eq(state(db, a.id), ["killed", "rule", "r_abroad"], "us → loại");
  const b = add(db, "Data Engineer", "Konecranes", { location: "Hyvinkää, fi" });
  eq(state(db, b.id), ["new", null, null], "fi → giữ");
  const c = add(db, "SRE", "Konecranes", { location: "Remote in Finland" });
  eq(state(db, c.id), ["new", null, null], "'in' không còn trong luật → Remote in Finland giữ");
  eq(state(db, add(db, "QA", "Konecranes", { location: "Helsinki, no relocation" }).id), ["new", null, null], "'no' không còn trong luật");
  eq(state(db, add(db, "Dev", "Konecranes", { location: "Oslo, Norway" }).id), ["killed", "rule", "r_abroad"], "norway theo tên");
  eq(state(db, add(db, "Dev2", "Konecranes", { location: "Bengaluru, India" }).id), ["killed", "rule", "r_abroad"], "india theo tên");
  eq(one(db, "SELECT COUNT(*) n FROM rules WHERE id = 'r_abroad'").n, 1, "migration không nhân đôi");
  invariants(db);
});

check("luật mẫu r_openapp: đơn mở → Ngờ vực; luật loại vẫn thắng khi cả hai khớp", () => {
  const db = openDb(":memory:");
  const r = C.getRule(db, "r_openapp");
  ok(r && r.enabled && r.field === "title" && r.action === "doubt", "luật mẫu có và bật");
  eq(state(db, add(db, "Open Application", "Reaktor", { location: "Helsinki" }).id), ["doubt", "rule", "r_openapp"], "open application");
  eq(state(db, add(db, "Avoin hakemus / ohjelmistokehittäjä", "Solita", { location: "Tampere", adLanguage: "en" }).id), ["doubt", "rule", "r_openapp"], "avoin hakemus");
  eq(state(db, add(db, "General Application - Engineering", "Wolt", { location: "Helsinki" }).id), ["doubt", "rule", "r_openapp"], "general application");
  eq(state(db, add(db, "Open Application", "Eficode", { location: "Philadelphia - US; Helsinki - Finland" }).id), ["killed", "rule", "r_abroad"], "kill (r_abroad) thắng doubt");
  eq(state(db, add(db, "Application Security Engineer", "Wolt", { location: "Helsinki" }).id), ["new", null, null], "chỉ khớp cụm nguyên");
  eq(one(db, "SELECT COUNT(*) n FROM rules WHERE id = 'r_openapp'").n, 1, "không nhân đôi");
  invariants(db);
});

check("từ khóa mới 2026-09-18: legal/electrical/investment/vp bị bắt; migration v9 không đè luật đã sửa tay", () => {
  const db = openDb(":memory:");
  eq(state(db, add(db, "Legal Counsel").id), ["killed", "rule", "r_notrole"], "legal");
  eq(state(db, add(db, "Electrical Engineer").id), ["killed", "rule", "r_notrole"], "electrical");
  eq(state(db, add(db, "Investment Intern").id), ["killed", "rule", "r_notrole"], "investment");
  eq(state(db, add(db, "Account Executive, Nordics").id), ["killed", "rule", "r_notrole"], "account executive");
  eq(state(db, add(db, "VP, Consumer & Commercial").id), ["killed", "rule", "r_senior_hard"], "vp nguyên từ");
  eq(state(db, add(db, "MVP Developer").id), ["new", null, null], "vp không dính MVP");
  eq(state(db, add(db, "Backend Engineer").id), ["new", null, null], "kỹ sư thường vẫn vào");
  // DB cũ: luật còn từ khóa cũ → v9 cập nhật; luật người đã sửa tay → giữ nguyên.
  // :memory: không mở lại được, nên dùng file tạm: ghi từ khóa cũ, hạ user_version về 8, mở lại để v9 chạy.
  const tmp = path.join(os.tmpdir(), `jobcheck-v9-${Date.now()}.db`);
  try {
    const f = openDb(tmp);
    f.prepare("UPDATE rules SET match = ? WHERE id = 'r_senior_hard'").run("lead, principal, head of, director, staff engineer, architect, vp of, chief, manager");
    f.prepare("UPDATE rules SET match = ? WHERE id = 'r_notrole'").run("sales, tao sửa tay");
    f.pragma("user_version = 8");
    f.close();
    const g = openDb(tmp);
    ok(C.getRule(g, "r_senior_hard").match.includes(", vp,"), "v9 cập nhật luật chưa sửa tay");
    eq(C.getRule(g, "r_notrole").match, "sales, tao sửa tay", "v9 không đè luật đã sửa tay");
    g.close();
  } finally { fs.rmSync(tmp, { force: true }); fs.rmSync(tmp + "-wal", { force: true }); fs.rmSync(tmp + "-shm", { force: true }); }
});

check("luật mẫu r_otherlang: german-speaking, ingeniero, entwickler, utvecklare → Ngờ vực", () => {
  const db = openDb(":memory:");
  const r = C.getRule(db, "r_otherlang");
  ok(r && r.enabled && r.field === "title" && r.action === "doubt", "luật mẫu có và bật");
  for (const t of ["DACH German-speaking Account Manager", "Ingeniero de Seguridad", "Softwareentwickler (m/w/d)", "Systemutvecklare", "Spanish Customer Support", "Serbian Speaking Developer", "Swedish-speaking Developer"]) {
    const s = state(db, add(db, t, "Acme").id);
    ok(s[0] !== "new", `${t}: ${JSON.stringify(s)}`);
  }
  eq(state(db, add(db, "Entwicklerin Backend", "Acme").id), ["new", null, null], "*entwickler không dính Entwicklerin (đuôi khác) — chấp nhận");
  eq(state(db, add(db, "Backend Engineer", "Acme").id), ["new", null, null], "tin thường vào");
  eq(one(db, "SELECT COUNT(*) n FROM rules WHERE id = 'r_otherlang'").n, 1, "không nhân đôi");
  invariants(db);
});

check("luật ngôn ngữ qua đường nạp", () => {
  const db = openDb(":memory:");
  const a = add(db, "Ohjelmistokehittäjä", "Solita", { adLanguage: "fi" });
  eq(state(db, a.id), ["doubt", "rule", "r_lang"], "tin tiếng Phần Lan");
  invariants(db);
});

check("luật loại tin → tắt luật → về new, xóa quy kết", () => {
  const db = openDb(":memory:");
  const a = add(db, "Lead Developer");
  eq(state(db, a.id), ["killed", "rule", "r_senior_hard"], "sau khi nạp");
  eq(J.toggleRule(db, "r_senior_hard").revived, { new: 1, maybe: 0 }, "số hồi sinh");
  eq(state(db, a.id), ["new", null, null], "sau khi tắt luật");
  invariants(db);
});

check("tin người đã quyết: tắt luật và chạy lại luật không đụng vào", () => {
  const db = openDb(":memory:");
  const a = add(db, "Lead Developer");
  const b = add(db, "Senior Backend Engineer");
  const c = add(db, "Sales Engineer");
  J.decide(db, a.id, "killed");
  J.decide(db, b.id, "doubt");
  J.decide(db, c.id, "new"); // "Trả về Hộp đến" — luật r_notrole vẫn bật và vẫn khớp
  J.toggleRule(db, "r_senior_hard");
  J.toggleRule(db, "r_senior_soft");
  J.rerunRules(db);
  eq(state(db, a.id), ["killed", "human", "r_senior_hard"], "a");
  eq(state(db, b.id), ["doubt", "human", "r_senior_soft"], "b");
  eq(state(db, c.id), ["new", "human", "r_notrole"], "c");
  invariants(db);
});

check("chạy lại luật xử lý cả tin decided_by NULL", () => {
  const db = openDb(":memory:");
  J.toggleRule(db, "r_notrole");
  const a = add(db, "Marketing Specialist");
  eq(state(db, a.id), ["new", null, null], "nạp khi luật đang tắt");
  J.toggleRule(db, "r_notrole");
  eq(J.rerunRules(db).touched, 1, "số tin đổi");
  eq(state(db, a.id), ["killed", "rule", "r_notrole"], "sau khi chạy lại");
  invariants(db);
});

check("người sửa quyết định của luật, U: về đúng killed_by, tắt luật vẫn hồi sinh được", () => {
  const db = openDb(":memory:");
  const a = add(db, "Lead Developer");
  J.decide(db, a.id, "queue");
  const u = J.undo(db);
  eq([u.job.id, u.ruleOff], [a.id, false], "U hoàn tác đúng tin; luật còn bật thì không ghi chú");
  eq(state(db, a.id), ["killed", "rule", "r_senior_hard"], "sau khi hoàn tác");
  J.toggleRule(db, "r_senior_hard");
  eq(state(db, a.id), ["new", null, null], "hồi sinh sau hoàn tác");
  invariants(db);
});

check("U không lặp, hết lịch sử thì dừng", () => {
  const db = openDb(":memory:");
  const a = add(db, "Backend Engineer");
  const b = add(db, "Frontend Engineer");
  J.decide(db, a.id, "queue");
  J.decide(db, b.id, "maybe");
  eq(J.undo(db).job.id, b.id, "U lần 1");
  eq(J.undo(db).job.id, a.id, "U lần 2");
  eq(J.undo(db), { nothing: true }, "U lần 3");
  ok(!J.canUndo(db), "canUndo phải false");
  eq([job(db, a.id).status, job(db, b.id).status], ["new", "new"], "status sau chuỗi hoàn tác");
  J.decide(db, a.id, "doubt");
  eq(J.undo(db).job.id, a.id, "U sau khi đã có event hoàn tác");
  invariants(db);
});

check("U trả về quyết định của luật đã tắt → xử lý như hồi sinh", () => {
  const db = openDb(":memory:");
  const a = add(db, "Senior Backend Engineer");
  J.decide(db, a.id, "maybe");
  J.toggleRule(db, "r_senior_soft"); // a là human → không hồi sinh
  eq(J.undo(db).ruleOff, true, "phải báo cho UI biết luật cũ đã tắt");
  eq(state(db, a.id), ["new", null, null], "không được quay về doubt của một luật đã tắt");
  invariants(db);
});

check("U đặt lại status_at: tin quay lại thùng không bị lưu trữ ngay", () => {
  const db = openDb(":memory:");
  const a = add(db, "Backend Engineer");
  J.decide(db, a.id, "maybe");
  J.decide(db, a.id, "queue");
  backdate(db, a.id, 30, ["status_at", "found_at"]);
  J.undo(db);
  eq(job(db, a.id).status, "maybe", "status sau hoàn tác");
  ok(Date.parse(job(db, a.id).status_at) > Date.now() - DAY, "status_at phải là lúc hoàn tác");
  // Quyết định giữ nguyên thùng (người xác nhận Ngờ vực của luật) rồi U: status không đổi, đồng hồ vẫn phải khởi động lại.
  const b = add(db, "Senior Backend Engineer");
  J.decide(db, b.id, "doubt");
  backdate(db, b.id, 30, ["status_at"]);
  J.undo(db);
  eq(state(db, b.id), ["doubt", "rule", "r_senior_soft"], "b sau hoàn tác");
  ok(Date.parse(job(db, b.id).status_at) > Date.now() - DAY, "b: status_at phải là lúc hoàn tác dù status không đổi");
  eq(J.archiveStale(db).moved, 0, "không bị lưu trữ");
  invariants(db);
});

check("tin luật đưa vào Ngờ vực đã lưu trữ → tắt luật → Có thể, không bị lưu trữ lại", () => {
  const db = openDb(":memory:");
  const a = add(db, "Senior Backend Engineer");
  backdate(db, a.id, 51, ["found_at"]);
  backdate(db, a.id, 30, ["status_at"]);
  eq(J.archiveStale(db).moved, 1, "lưu trữ");
  eq(state(db, a.id), ["archived", "rule", "r_senior_soft"], "sau khi lưu trữ");
  eq(J.toggleRule(db, "r_senior_soft").revived, { new: 0, maybe: 1 }, "số hồi sinh");
  eq(state(db, a.id), ["maybe", null, null], "sau khi tắt luật");
  eq(J.archiveStale(db).moved, 0, "lần tự lưu trữ kế tiếp");
  eq(job(db, a.id).status, "maybe", "vẫn ở Có thể");
  invariants(db);
});

check("tự lưu trữ không bao giờ đụng new, queue, applied, killed", () => {
  const db = openDb(":memory:");
  const want = { new: "new", queue: "queue", maybe: "archived", doubt: "archived", applied: "applied", killed: "killed" };
  const ids = {};
  for (const status of Object.keys(want)) {
    const j = add(db, `Engineer ${status}`);
    if (status !== "new") J.decide(db, j.id, status);
    backdate(db, j.id, 100, ["status_at", "found_at"]);
    ids[status] = j.id;
  }
  const ruleKilled = add(db, "Lead Developer");
  backdate(db, ruleKilled.id, 100, ["status_at", "found_at"]);
  eq(J.archiveStale(db).moved, 2, "số tin bị lưu trữ");
  for (const [status, id] of Object.entries(ids)) eq(job(db, id).status, want[status], `tin ở ${status}`);
  eq(job(db, ruleKilled.id).status, "killed", "tin luật loại");
  invariants(db);
});

check("deadline: cột có, trống mặc định, danh sách trả về", () => {
  const db = openDb(":memory:");
  const a = add(db, "Backend Engineer");
  eq(J.getJob(db, a.id).deadline, null, "trống");
  db.prepare("UPDATE jobs SET deadline = '2026-10-01' WHERE id = ?").run(a.id); // bước 5 mới có hàm ghi
  eq(J.listJobs(db)[0].deadline, "2026-10-01", "listJobs trả deadline");
});

check("sắp xếp thùng: mới thêm, cũ nhất, deadline gần nhất với trống xếp cuối", () => {
  const jobs = [
    { id: "a", foundAt: "2026-09-10T00:00:00Z", deadline: null },
    { id: "b", foundAt: "2026-09-12T00:00:00Z", deadline: "2026-10-05" },
    { id: "c", foundAt: "2026-09-11T00:00:00Z", deadline: "2026-09-20" },
    { id: "d", foundAt: "2026-09-13T00:00:00Z", deadline: null },
  ];
  const ids = (m) => sortJobs(jobs, m).map((j) => j.id);
  eq(ids("newest"), ["d", "b", "c", "a"], "mới thêm");
  eq(ids("oldest"), ["a", "c", "b", "d"], "cũ nhất");
  eq(ids("deadline"), ["c", "b", "d", "a"], "deadline gần nhất, trống cuối theo mới thêm");
  eq(ids("gì đó lạ"), ["d", "b", "c", "a"], "chế độ lạ = mặc định");
  eq(jobs.map((j) => j.id), ["a", "b", "c", "d"], "không đổi mảng gốc");
});

check("danh sách tin không trả description", () => {
  const db = openDb(":memory:");
  add(db, "Backend Engineer", "Wolt", { description: "JD dài…" });
  ok(one(db, "SELECT description FROM jobs").description, "description vẫn phải được lưu");
  const listed = J.listJobs(db)[0];
  ok(!("description" in listed), "listJobs lộ description");
  ok(!("description" in J.getJob(db, listed.id)), "getJob lộ description");
});

check("needs_rerun: bật hoặc sửa luật đang bật → nhắc; chạy lại → hết nhắc", () => {
  const db = openDb(":memory:");
  const flag = () => C.getRule(db, "r_custom").needsRerun;
  J.toggleRule(db, "r_custom");
  eq(flag(), true, "sau khi bật");
  J.rerunRules(db);
  eq(flag(), false, "sau khi chạy lại");
  C.patchRule(db, "r_custom", { label: "Đổi tên" });
  eq(flag(), false, "đổi tên không cần chạy lại");
  C.patchRule(db, "r_custom", { match: "gambling" });
  eq(flag(), true, "sửa từ khóa của luật đang bật");
  J.toggleRule(db, "r_custom");
  C.patchRule(db, "r_custom", { match: "casino" });
  eq(flag(), false, "sửa luật đang tắt");
  let threw = false;
  try {
    C.patchRule(db, "r_custom", { enabled: true });
  } catch {
    threw = true;
  }
  ok(threw, "PATCH không được phép bật/tắt luật");
});

/* UI chạy trong trình duyệt: mọi file nó import (đệ quy) phải thuần. Một import lạc vào core/db.js là
   Vite phục vụ better-sqlite3 cho trình duyệt và app không mở được. */
function uiImportClosure() {
  const uiDir = path.join(ROOT, "src/ui");
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const src = fs.readFileSync(file, "utf8");
    seen.set(file, src);
    const re = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec.startsWith(".")) continue; // gói npm và node: không đi theo; nội dung file sẽ bị quét bằng chuỗi
      visit(path.resolve(path.dirname(file), spec));
    }
  };
  for (const f of fs.readdirSync(uiDir)) if (/\.(jsx?|html)$/.test(f)) visit(path.join(uiDir, f));
  return seen;
}

check("src/ui và mọi file nó import (đệ quy) không đụng better-sqlite3, node:fs, node:util", () => {
  const closure = uiImportClosure();
  ok(closure.size >= 5, `quét được quá ít file: ${closure.size}`);
  const bad = [];
  for (const [file, src] of closure) {
    for (const needle of ["better-sqlite3", "node:fs", "node:util", "node:crypto", "node:path", "imapflow", "mailparser"]) {
      if (src.includes(needle)) bad.push(`${path.relative(ROOT, file)} chứa ${needle}`);
    }
  }
  eq(bad, [], "file UI kéo theo thứ chỉ chạy ở server");
});

check("không có lệnh xóa nào trong src/", () => {
  eq(scanSrc(/\bdelete\b|\bdrop\s+table\b|\btruncate\b/i), [], "chỗ có chữ delete/drop/truncate");
});

check("chỉ core/jobs.js ghi vào jobs, sightings, events", () => {
  const re = /\b(insert\s+(or\s+\w+\s+)?into|update|replace\s+into)\s+(jobs|sightings|events)\b/i;
  const hits = scanSrc(re);
  ok(hits.some((h) => h.startsWith("src/core/jobs.js")), "regex không bắt được chỗ ghi trong jobs.js — check hỏng");
  eq(hits.filter((h) => !h.startsWith("src/core/jobs.js")), [], "ghi ngoài jobs.js");
});

check("sao lưu: .tmp sót lại không chặn, chạy liên tiếp không lỗi, giữ đúng số bản", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobcheck-"));
  try {
    const db = openDb(":memory:");
    add(db, "Backend Engineer");
    const b = createBackups(db, dir, { keep: 3 });
    fs.writeFileSync(path.join(dir, "jobs-2020-01-01T00-00-00-000Z.db.tmp"), "dở dang");
    ok(b.runIfStale(), "lần đầu phải sao lưu");
    ok(!b.runIfStale(), "trong 24 giờ không sao lưu lại");
    for (let i = 0; i < 5; i++) b.run();
    const files = fs.readdirSync(dir).sort();
    ok(!files.some((f) => f.endsWith(".tmp")), "còn file .tmp");
    ok(files.length >= 1 && files.length <= 3, `giữ tối đa 3 bản, thực tế ${files.length}`);
    const copy = openDb(path.join(dir, files.at(-1)));
    eq(one(copy, "SELECT COUNT(*) n FROM jobs").n, 1, "bản sao lưu có dữ liệu");
    copy.close();
    eq(b.status().backupError, null, "lỗi sao lưu");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================ bước 2: ATS ============================ */

function checkAsync(name, fn) {
  return fn().then(() => console.log(`PASS  ${name}`), (e) => { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); });
}

check("luật trên địa điểm: 'Remote (USA)' bị doubt, 'Helsinki' không", () => {
  const rules = compileRules([{ id: "us", field: "location", match: "usa, united states", action: "doubt", enabled: 1, position: 0 }]);
  ok(evaluate({ title: "Backend Engineer", location: "Remote (USA)" }, rules), "USA phải khớp");
  ok(!evaluate({ title: "Backend Engineer", location: "Helsinki" }, rules), "Helsinki không được khớp");
  const db = openDb(":memory:");
  const r = C.createRule(db);
  C.patchRule(db, r.id, { field: "location", match: "usa", action: "doubt" });
  J.toggleRule(db, r.id);
  const a = add(db, "Data Engineer", "Wolt", { location: "Remote, USA" });
  eq(state(db, a.id), ["doubt", "rule", r.id], "nạp qua đường ingest");
  invariants(db);
});

check("html → chữ: giữ link dạng 'chữ (url)', bỏ script, giải mã entity", () => {
  const html = `<html><head><style>a{}</style></head><body><script>x()</script>
    <p>Hi &amp; <b>welcome</b></p><a href="https://x.fi/job/1?a=1&amp;b=2">Backend Engineer</a><br>
    <a href="mailto:hr@x.fi">mail</a><table><tr><td>Wolt</td></tr></table></body></html>`;
  const t = htmlToText(html, { keepLinks: true });
  ok(t.includes("Hi & welcome"), `entity: ${t}`);
  ok(t.includes("Backend Engineer (https://x.fi/job/1?a=1&b=2)"), `link: ${t}`);
  ok(!t.includes("x()") && !t.includes("a{}"), "script/style phải biến mất");
  ok(!t.includes("mailto"), "mailto không thành link");
  ok(htmlToText("<a href='https://x.fi'>Job</a>").trim() === "Job", "không keepLinks thì chỉ còn chữ");
  eq(htmlToText("<p>Hi\u034F \u034F \u200B\u200Bthere</p>"), "Hi there", "đệm vô hình của preheader bị bỏ");
});

check("parse feed: 7 nền tảng, mỗi nền tảng ra title/location/url", () => {
  const cases = {
    greenhouse: [JSON.stringify({ jobs: [{ id: 1, title: "Backend Engineer", absolute_url: "https://boards.greenhouse.io/wolt/jobs/1", location: { name: "Helsinki, Finland" }, updated_at: "2026-09-01T00:00:00Z", content: "&lt;p&gt;Hello &amp;amp; hi&lt;/p&gt;" }] }), "wolt"],
    lever: [JSON.stringify([{ id: "a", text: "Data Engineer", hostedUrl: "https://jobs.lever.co/x/a", categories: { location: "Helsinki" }, createdAt: 1756684800000, descriptionPlain: "JD" }]), "x"],
    ashby: [JSON.stringify({ jobs: [{ id: "a", title: "SRE", jobUrl: "https://jobs.ashbyhq.com/x/a", location: "Helsinki", isRemote: true, publishedAt: "2026-09-01", descriptionHtml: "<p>JD</p>" },
      { id: "b", title: "Unlisted TEST job", jobUrl: "https://jobs.ashbyhq.com/x/b", location: "Helsinki", isListed: false }] }), "x"],
    recruitee: [JSON.stringify({ offers: [{ id: 1, title: "Dev", careers_url: "https://x.recruitee.com/o/dev", city: "Espoo", country: "Finland", created_at: "2026-09-01", description: "<p>JD</p>" }] }), "x"],
    smartrecruiters: [JSON.stringify({ content: [{ id: "99", name: "QA Engineer", location: { city: "Tampere", country: "fi" }, releasedDate: "2026-09-01T00:00:00Z" }] }), "x"],
    workable: [JSON.stringify({ jobs: [{ title: "Frontend", shortcode: "AB", url: "https://apply.workable.com/x/j/AB", city: "Oulu", country: "Finland", published_on: "2026-09-01", description: "<p>JD</p>" }] }), "x"],
    personio: ["<workzag-jobs><position><id>7</id><office>Helsinki</office><name>Ohjelmistokehittäjä</name><jobDescriptions><jobDescription><name>Tehtävä</name><value><![CDATA[<p>Meillä ja sinulla</p>]]></value></jobDescription></jobDescriptions></position></workzag-jobs>", "acme"],
    teamtailor: ['<rss xmlns:tt="https://teamtailor.com/locations"><channel><item><title>Platform Engineer</title><link>https://career.acme.fi/jobs/1</link><tt:locations><tt:location><tt:name>Tallinn, Estonia</tt:name><tt:city>Tallinn</tt:city></tt:location><tt:location><tt:name>Helsinki, Finland</tt:name></tt:location></tt:locations><pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate><description><![CDATA[<p>JD</p>]]></description></item></channel></rss>', "https://career.acme.fi"],
  };
  for (const [platform, [body, token]] of Object.entries(cases)) {
    const items = parseFeed(platform, body, token);
    eq(items.length, 1, `${platform}: số tin`);
    const it = items[0];
    ok(it.title && it.url && /^https:\/\//.test(it.url), `${platform}: thiếu title/url: ${JSON.stringify(it)}`);
    ok(it.location, `${platform}: thiếu location`);
    ok(!it.postedAt || !Number.isNaN(Date.parse(it.postedAt)), `${platform}: postedAt hỏng`);
  }
  eq(parseFeed("greenhouse", cases.greenhouse[0], "wolt")[0].description, "Hello & hi", "greenhouse content giải mã hai lớp");
  eq(parseFeed("ashby", cases.ashby[0], "x")[0].location, "Helsinki, Remote", "ashby: gộp remote vào location");
  eq(parseFeed("ashby", cases.ashby[0], "x").map((i) => i.title), ["SRE"], "ashby: tin isListed=false bị bỏ");
  eq(parseFeed("teamtailor", cases.teamtailor[0], "x")[0].location, "Tallinn, Estonia; Helsinki, Finland", "teamtailor: tt:location/tt:name, nhiều địa điểm");
  ok(parseFeed("lever", cases.lever[0], "x")[0].postedAt.startsWith("2025-09-01") || parseFeed("lever", cases.lever[0], "x")[0].postedAt.startsWith("2026-09-01"), "lever: ms epoch");
  let threw = false;
  try { parseFeed("greenhouse", "{}", "x"); } catch { threw = true; }
  ok(threw, "feed sai dạng phải ném lỗi, không trả rỗng");
});

check("lọc địa điểm: không phân biệt hoa thường, nhiều thành phố giữ, trống giữ, ghi số ngoài phạm vi", () => {
  const items = [
    { title: "a", location: "HELSINKI, Finland" },
    { title: "b", location: "Helsinki, Stockholm, Berlin" },
    { title: "c", location: "Berlin" },
    { title: "d", location: null },
    { title: "e", location: "Remote (USA)" },
  ];
  const { kept, dropped } = filterLocation(items, "Finland, helsinki, Remote");
  eq(kept.map((x) => x.title), ["a", "b", "d"], "giữ");
  eq(dropped.map((x) => x.title), ["c", "e"], "ngoài phạm vi: Berlin, và Remote (USA) vì có token nước ngoài");
  eq(filterLocation(items, "").kept.length, 5, "danh sách trống = không lọc");
  // Lớp mã nước: "fi" chỉ khớp khi đứng riêng làm token.
  const code = [
    ["Hyvinkää, fi", true], ["Espoo, FI", true], ["Remote (fi)", true], ["fi", true], ["Helsinki fi", true],
    ["Fifth Avenue, us", false], ["Finland Street, us", false], ["Sci-fi Studio, us", true], ["Warszawa, pl, Remote", false],
    ["Flexible within Subregion North (Finland, Sweden), se", false],
  ];
  for (const [loc, want] of code) eq(filterLocation([{ title: "x", location: loc }], "fi").kept.length === 1, want, `mã nước fi: "${loc}"`);
  eq(filterLocation([{ title: "x", location: "Flexible within Subregion North (Finland, Sweden), se" }], "fi, Finland").kept.length, 1, "lớp thành phố/tên nước vẫn khớp chuỗi con");
  eq(filterLocation([{ title: "x", location: "Hyvinkää, fi" }], "Hyvinkää").kept.length, 1, "thành phố có dấu");
  // Remote: chỉ giữ khi không có token nước ngoài Phần Lan. EU, Europe, Nordic không tính.
  const remote = [
    ["Remote", true], ["Remote, Finland", true], ["Remote (EU)", true],
    ["Remote, US", false], ["Remote (Poland)", false], ["Remote, Germany", false],
    ["Remote in Finland", true], ["Remote, Europe", true], ["Nordic remote", true], ["Garner, us, Remote", false],
    ["United States, us, Remote", false], ["Remote-first, Estonia", false], ["Any KC site within EU, or, fi", false], // không có chữ remote; mục "fi" mới giữ nó
  ];
  for (const [loc, want] of remote) eq(filterLocation([{ title: "x", location: loc }], "Remote").kept.length === 1, want, `Remote: "${loc}"`);
  ok(!hasForeignCountry("Remote in Finland") && hasForeignCountry("Remote, in") && !hasForeignCountry("Helsinki, fi"), "token nước theo đoạn, không theo từ");
  // Remote ở nước ngoài vẫn có thể được giữ bởi mục khác (thành phố Phần Lan trong chuỗi) — đó là ý đồ.
  eq(filterLocation([{ title: "x", location: "Helsinki or Remote, Sweden" }], "Helsinki, Remote").kept.length, 1, "Helsinki cứu chuỗi có Sweden");
});

check("đoán ngôn ngữ tin: dấu trong chức danh, hoặc JD nhiều từ Phần Lan", () => {
  eq(guessLanguage("Ohjelmistokehittäjä", ""), "fi", "title có ä");
  eq(guessLanguage("Software Developer", "Haemme tiimiin kehittäjää. Sinulla on kokemusta ja osaaminen."), "fi", "JD tiếng Phần Lan");
  eq(guessLanguage("Software Developer", "We are looking for a developer to join our team in Helsinki."), "en", "JD tiếng Anh");
});

check("dò ATS từ URL: EngRadar, link ATS thẳng, Lever EU, token rác bị bỏ", () => {
  eq(guessFromUrl("https://engradar.com/jobs/lever:wolt:abc123"), { platform: "lever", token: "wolt" }, "engradar");
  eq(guessFromUrl("https://boards.greenhouse.io/wolt/jobs/1"), { platform: "greenhouse", token: "wolt" }, "greenhouse");
  eq(guessFromUrl("https://job-boards.eu.greenhouse.io/aiven"), { platform: "greenhouse", token: "aiven" }, "greenhouse eu");
  eq(guessFromUrl("https://jobs.eu.lever.co/acme/1"), { platform: "lever", token: "eu:acme" }, "lever eu");
  eq(guessFromUrl("https://jobs.ashbyhq.com/supermetrics"), { platform: "ashby", token: "supermetrics" }, "ashby");
  eq(guessFromUrl("https://acme.recruitee.com/"), { platform: "recruitee", token: "acme" }, "recruitee");
  eq(guessFromUrl("https://careers.smartrecruiters.com/Wolt/"), { platform: "smartrecruiters", token: "Wolt" }, "smartrecruiters");
  eq(guessFromUrl("https://apply.workable.com/acme/"), { platform: "workable", token: "acme" }, "workable");
  eq(guessFromUrl("https://acme.jobs.personio.de/"), { platform: "personio", token: "acme" }, "personio");
  eq(guessFromUrl("https://acme.teamtailor.com/jobs"), { platform: "teamtailor", token: "https://acme.teamtailor.com" }, "teamtailor");
  eq(guessFromUrl("https://engradar.com/jobs/foo:bar:1"), null, "nền tảng lạ");
  eq(guessFromUrl("https://www.workable.com/"), null, "www không phải token");
  eq(guessFromUrl("https://careers.wolt.com/"), null, "trang thường");
});

check("dò ATS từ HTML: theo thứ tự xuất hiện, bỏ trùng, Teamtailor trên domain riêng", () => {
  const html = `<link rel="stylesheet" href="https://cdn.x.com/a.css">
    <iframe src="https://jobs.lever.co/wolt?lever-source=x"></iframe>
    <script src="https://boards.greenhouse.io/embed/job_board/js?for=wolt"></script>
    <a href="https://jobs.lever.co/wolt/123">Apply</a>`;
  eq(guessFromHtml(html, "https://careers.wolt.com"), [{ platform: "lever", token: "wolt" }, { platform: "greenhouse", token: "wolt" }], "thứ tự và trùng");
  eq(guessFromHtml('<script src="https://scripts.teamtailor-cdn.com/x.js"></script>', "https://career.acme.fi/jobs"),
    [{ platform: "teamtailor", token: "https://career.acme.fi" }], "teamtailor domain riêng");
  eq(guessFromHtml("<p>nothing</p>", "https://x.fi"), [], "không có gì");
});

await checkAsync("dò ATS: xác nhận bằng feed thật mới nhận; feed lỗi → thử ứng viên sau → hết thì manual", async () => {
  const pages = {
    "https://careers.acme.fi/": { status: 200, url: "https://careers.acme.fi/", body: '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script><a href="https://jobs.lever.co/acme">x</a>' },
    "https://careers.none.fi/": { status: 200, url: "https://careers.none.fi/", body: "<p>Send CV by mail</p>" },
    "https://careers.down.fi/": { status: 503, url: "https://careers.down.fi/", body: "" },
  };
  const get = async (url) => pages[url] ?? { status: 404, url, body: "" };
  const calls = [];
  const fetchAtsFake = async (platform, token) => {
    calls.push(`${platform}:${token}`);
    if (platform === "greenhouse") throw new Error("HTTP 404");
    if (platform === "smartrecruiters") return { items: [], total: 0, etag: null }; // 200 rỗng cho mọi slug
    if (platform === "lever" && token === "acme") return { items: [{ title: "x" }], total: 1, etag: null };
    throw new Error("HTTP 404");
  };
  const opt = { get, fetchAts: fetchAtsFake, gapMs: 0 };
  const r = await detectAts("https://careers.acme.fi/", opt);
  eq([r.platform, r.token, r.total, r.guessed], ["lever", "acme", 1, undefined], "ứng viên hai được xác nhận");
  eq(calls, ["greenhouse:acme", "lever:acme"], "thứ tự thử");
  eq(r.tried.length, 1, "ghi lại ứng viên hỏng");
  calls.length = 0;
  const none = await detectAts("https://careers.none.fi/", opt);
  eq(none.platform, "manual", "không dấu vết, đoán slug không ra → manual");
  ok(calls.some((c) => c === "lever:none") && calls.some((c) => c === "greenhouse:noneoy"), `đoán slug từ hostname: ${calls.join(" ")}`);
  ok(!calls.some((c) => c.startsWith("smartrecruiters:") && none.platform !== "manual"), "200 rỗng không được nhận");
  const down = await detectAts("https://careers.down.fi/", opt);
  eq([down.platform, down.error], ["manual", "HTTP 503"], "trang chết → manual kèm lý do");
  const direct = await detectAts("https://jobs.lever.co/acme", opt);
  eq(direct.platform, "lever", "link ATS dán thẳng không cần HTML");
  eq((await detectAts("not a url", opt)).platform, "manual", "không phải http");
});

await checkAsync("dò ATS qua trang con và đoán slug từ tên công ty", async () => {
  const pages = {
    "https://www.acme.fi/careers": { status: 200, url: "https://www.acme.fi/careers", body: '<a href="/careers/blog">blog</a><a href="/careers/open-positions">Open positions</a><a href="https://other.com/jobs">x</a>' },
    "https://www.acme.fi/careers/open-positions": { status: 200, url: "https://www.acme.fi/careers/open-positions", body: '<iframe src="https://jobs.lever.co/acme"></iframe>' },
    "https://www.bigcorp.fi/": { status: 200, url: "https://www.bigcorp.fi/", body: "<p>We use Greenhouse for recruiting</p>" },
  };
  const get = async (url) => pages[url] ?? { status: 404, url, body: "" };
  const calls = [];
  const fetchAtsFake = async (platform, token) => {
    calls.push(`${platform}:${token}`);
    if (platform === "lever" && token === "acme") return { items: [{ title: "x" }], total: 1, etag: null };
    if (platform === "greenhouse" && token === "bigcorpoy") return { items: [{ title: "x" }], total: 3, etag: null };
    throw new Error("HTTP 404");
  };
  const r = await detectAts("https://www.acme.fi/careers", { get, fetchAts: fetchAtsFake, gapMs: 0 });
  eq([r.platform, r.token], ["lever", "acme"], "thấy ở trang con");
  calls.length = 0;
  const g = await detectAts("https://www.bigcorp.fi/", { name: "BigCorp Oy", get, fetchAts: fetchAtsFake, gapMs: 0 });
  eq([g.platform, g.token, g.guessed], ["greenhouse", "bigcorpoy", true], "đoán slug + hậu tố oy");
  eq(calls[0], "greenhouse:bigcorp", "trang nhắc Greenhouse thì thử Greenhouse trước");
});

await checkAsync("fetchAts: 304 → notModified; ETag trả về; HTTP lỗi ném", async () => {
  const get = async (url, { etag }) => (etag === "v1"
    ? { status: 304, body: "", etag: "v1", url }
    : { status: 200, body: JSON.stringify([{ id: "1", text: "Dev", hostedUrl: "https://jobs.lever.co/x/1", categories: { location: "Helsinki" } }]), etag: "v1", url });
  const first = await fetchAts("lever", "x", { get });
  eq([first.total, first.etag, first.items[0].adLanguage], [1, "v1", "en"], "lần đầu");
  const second = await fetchAts("lever", "x", { etag: "v1", get });
  eq(second.notModified, true, "304");
  let threw = "";
  try { await fetchAts("lever", "x", { get: async (url) => ({ status: 500, body: "", etag: null, url }) }); } catch (e) { threw = e.message; }
  ok(threw.startsWith("HTTP 500"), `lỗi HTTP: ${threw}`);
});

await checkAsync("SmartRecruiters phân trang theo offset tới totalFound; trang rỗng thì dừng", async () => {
  const calls = [];
  const page = (offset, n, totalFound = 250) => JSON.stringify({ offset, limit: 100, totalFound,
    content: Array.from({ length: n }, (_, i) => ({ id: String(offset + i), name: `Job ${offset + i}`, location: { city: "Hyvinkää", country: "fi" } })) });
  const get = async (url) => {
    calls.push(url);
    const offset = Number(new URL(url).searchParams.get("offset"));
    return { status: 200, url, etag: offset ? null : "e1", body: page(offset, offset === 200 ? 50 : 100) };
  };
  const r = await fetchAts("smartrecruiters", "konecranes", { get });
  eq([r.total, r.etag], [250, "e1"], "gộp 3 trang, etag trang đầu");
  eq(calls.map((u) => new URL(u).searchParams.get("offset")), ["0", "100", "200"], "offset từng trang");
  eq(new Set(r.items.map((i) => i.externalId)).size, 250, "không trùng");
  const one = await fetchAts("smartrecruiters", "x", { get: async (url) => ({ status: 200, url, etag: null, body: page(0, 7, 7) }) });
  eq(one.total, 7, "dưới một trang thì không gọi thêm");
});

check("ghi kết quả kéo: last_new_at chỉ đổi khi có tin mới; setCompanyAts xóa ETag cũ", () => {
  const db = openDb(":memory:");
  const { company } = C.addCompany(db, { name: "Wolt" });
  C.setCompanyAts(db, company.id, { platform: "lever", token: "wolt" });
  C.markCompanyPull(db, company.id, { added: 3, count: 12, total: 340, etag: "e1" });
  let c = C.getCompany(db, company.id);
  ok(c.lastPull && c.lastNewAt === c.lastPull, "có tin mới → last_new_at = last_pull");
  eq([c.pullCount, c.pullTotal], [12, 340], "giữ/tổng");
  const firstNew = c.lastNewAt;
  C.markCompanyPull(db, company.id, { added: 0, count: 12, total: 340, error: null });
  c = C.getCompany(db, company.id);
  eq(c.lastNewAt, firstNew, "không tin mới → last_new_at giữ nguyên");
  C.markCompanyPull(db, company.id, { error: "HTTP 500" });
  eq(C.getCompany(db, company.id).lastError, "HTTP 500", "lỗi được ghi");
  C.setCompanyAts(db, company.id, { platform: "manual" });
  eq(one(db, "SELECT ats, ats_token, ats_etag e FROM companies WHERE id = ?", company.id), { ats: "manual", ats_token: null, e: null }, "manual + bỏ etag");
  C.markSourcePull(db, "s1", { added: 2, count: 5 });
  const s = C.listSources(db).find((x) => x.id === "s1");
  ok(s.lastPull && s.lastNewAt, "nguồn: ghi được");
});

/* ============================ bước 2: kéo ============================ */

function atsCompany(db, name, platform, token) {
  const { company } = C.addCompany(db, { name });
  return C.setCompanyAts(db, company.id, { platform, token });
}
const feedOf = (items, etag = null) => ({ items: items.map((it) => ({ adLanguage: "en", ...it })), total: items.length, etag });

await checkAsync("kéo: mọi tin qua ingest + luật; số feed/giữ/ngoài phạm vi ghi lại; nguồn lỗi không chặn nguồn khác", async () => {
  const db = openDb(":memory:");
  const wolt = atsCompany(db, "Wolt", "greenhouse", "wolt");
  const dead = atsCompany(db, "Dead Co", "lever", "dead");
  const acme = atsCompany(db, "Acme", "ashby", "acme");
  const fetchAts = async (platform, token) => {
    if (token === "dead") throw new Error("HTTP 500");
    if (token === "wolt") return feedOf([
      { title: "Backend Engineer", location: "Helsinki, Finland", url: "https://w/1" },
      { title: "Sales Manager", location: "Helsinki", url: "https://w/2" },
      { title: "Backend Engineer", location: "Berlin", url: "https://w/3" }, // trùng fingerprint, ngoài phạm vi
      { title: "iOS Engineer", location: "Berlin", url: "https://w/4" },
    ]);
    return feedOf([{ title: "Data Engineer", location: null, url: "https://a/1" }]);
  };
  const p = createPuller(db, { fetchAts, extra: [], gapMs: 0 });
  eq(p.start().started, true, "bắt đầu");
  eq(p.start().started, false, "đang chạy thì không chạy chồng");
  ok(p.status().running, "running");
  const s = await p.wait();
  ok(!s.running && s.finishedAt, "đã xong");
  const byName = Object.fromEntries(s.results.map((r) => [r.name, r]));
  eq([byName.Wolt.total, byName.Wolt.kept, byName.Wolt.dropped, byName.Wolt.added, byName.Wolt.auto], [4, 2, 2, 2, 1], "Wolt: feed/giữ/ngoài/mới/luật");
  eq(byName["Dead Co"].error, "HTTP 500", "nguồn lỗi ghi lỗi");
  eq([byName.Acme.total, byName.Acme.kept, byName.Acme.added], [1, 1, 1], "Acme: location trống vẫn giữ, nguồn sau nguồn lỗi vẫn chạy");
  eq(one(db, "SELECT COUNT(*) n FROM jobs").n, 3, "3 tin vào DB");
  eq(state(db, job(db, one(db, "SELECT id FROM jobs WHERE title = 'Sales Manager'").id).id), ["killed", "rule", "r_senior_hard"], "luật chạy trên tin ATS (manager khớp trước sales)");
  const j = J.listJobs(db).find((x) => x.title === "Backend Engineer");
  eq(j.channels, ["Trang công ty"], "kênh = Trang công ty");
  const cw = C.getCompany(db, wolt.id);
  eq([cw.pullTotal, cw.pullCount, cw.lastError], [4, 2, null], "ghi vào companies");
  ok(cw.lastNewAt, "có tin mới → last_new_at");
  eq(C.getCompany(db, dead.id).lastError, "HTTP 500", "companies.last_error");
  ok(C.getCompany(db, dead.id).lastPull, "nguồn lỗi vẫn ghi last_pull");
  const settings = C.getSettings(db);
  ok(settings.lastPull && settings.lastPullResult.results.length === 3, "settings.last_pull + kết quả");
  eq(s.results, settings.lastPullResult.results, "status sau khi xong đọc từ settings");
  ok(summarize(s.results).includes("3 tin mới") && summarize(s.results).includes("1 nguồn lỗi") && summarize(s.results).includes("2 ngoài phạm vi"), summarize(s.results));
  eq(C.getCompany(db, acme.id).ats, "ashby", "không đụng cấu hình");
  invariants(db);
});

check("slug kiểu trang công ty + mẫu link tin", () => {
  eq(slugify("MarTech Engineer"), "martech-engineer", "đơn giản");
  eq(slugify("Senior Client Programmer, Project R.I.S.E"), "senior-client-programmer-project-rise", "dấu chấm bỏ hẳn");
  eq(slugify("Senior Product Manager, Live Ops & Monetization, Hay Day"), "senior-product-manager-live-ops-monetization-hay-day", "& bỏ hẳn");
  eq(slugify("Art Director, Clash of Clans"), "art-director-clash-of-clans", "dấu phẩy");
  eq(slugify("Ohjelmistokehittäjä (Senior)"), "ohjelmistokehittaja-senior", "bỏ dấu, ngoặc");
  const it = { title: "MarTech Engineer", externalId: "32c5", url: "https://jobs.ashbyhq.com/supercell/32c5" };
  eq(applyUrlTemplate("https://supercell.com/en/careers/{slug}/{id}/", it), "https://supercell.com/en/careers/martech-engineer/32c5/", "mẫu");
  eq(applyUrlTemplate("", it), it.url, "không mẫu → url feed");
  eq(applyUrlTemplate("https://x/{id}", { ...it, externalId: "" }), it.url, "không id → url feed");
});

await checkAsync("mẫu link tin: tin mới dùng mẫu, tin cũ được nối lại, patchCompany đòi {id}", async () => {
  const db = openDb(":memory:");
  const sc = atsCompany(db, "Supercell", "ashby", "supercell");
  const feed = () => feedOf([{ title: "MarTech Engineer", location: "Helsinki", url: "https://jobs.ashbyhq.com/supercell/32c5", externalId: "32c5" }]);
  const p = createPuller(db, { fetchAts: async () => feed(), extra: [], gapMs: 0 });
  p.start(); await p.wait();
  const id = one(db, "SELECT id FROM jobs WHERE title = 'MarTech Engineer'").id;
  eq(job(db, id).url, "https://jobs.ashbyhq.com/supercell/32c5", "chưa có mẫu → url feed");
  let threw = false;
  try { C.patchCompany(db, sc.id, { jobUrlTemplate: "https://supercell.com/en/careers/" }); } catch (e) { threw = e.status === 400; }
  ok(threw, "mẫu không có {id} bị từ chối");
  C.patchCompany(db, sc.id, { jobUrlTemplate: "https://supercell.com/en/careers/{slug}/{id}/" });
  eq(C.getCompany(db, sc.id).jobUrlTemplate, "https://supercell.com/en/careers/{slug}/{id}/", "lưu mẫu");
  const p2 = createPuller(db, { fetchAts: async () => feed(), extra: [], gapMs: 0 });
  p2.start(); const s = await p2.wait();
  eq(s.results[0].relinked, 1, "một tin nối lại");
  eq(job(db, id).url, "https://supercell.com/en/careers/martech-engineer/32c5/", "tin cũ trỏ sang trang công ty");
  eq(one(db, "SELECT url FROM sightings WHERE job_id = ?", id).url, "https://supercell.com/en/careers/martech-engineer/32c5/", "sighting cũng đổi");
  eq(one(db, "SELECT COUNT(*) n FROM events").n, 1, "nối lại không ghi event");
  C.patchCompany(db, sc.id, { jobUrlTemplate: "" });
  eq(C.getCompany(db, sc.id).jobUrlTemplate, "", "xóa mẫu");
  invariants(db);
});

await checkAsync("kéo lại: 304 không đụng gì; tin biến khỏi feed → closed_at; quay lại → mở lại; không đổi status", async () => {
  const db = openDb(":memory:");
  const wolt = atsCompany(db, "Wolt", "greenhouse", "wolt");
  let feed = feedOf([{ title: "Backend Engineer", location: "Helsinki" }, { title: "Data Engineer", location: "Helsinki" }], "v1");
  const fetchAts = async (platform, token, { etag }) => (etag === feed.etag ? { notModified: true, etag } : feed);
  const p = createPuller(db, { fetchAts, extra: [], gapMs: 0 });
  p.start(); await p.wait();
  const be = one(db, "SELECT id FROM jobs WHERE title = 'Backend Engineer'").id;
  J.decide(db, be, "queue");
  eq(C.getCompany(db, wolt.id).atsEtag, "v1", "etag lưu lại");

  p.start(); const s2 = await p.wait();
  eq([s2.results[0].notModified, s2.results[0].total, s2.results[0].kept, s2.results[0].added], [true, 2, 2, 0], "304: giữ số cũ, không tin mới");
  const firstNew = C.getCompany(db, wolt.id).lastNewAt;

  feed = feedOf([{ title: "Data Engineer", location: "Helsinki" }], "v2");
  p.start(); const s3 = await p.wait();
  eq(s3.results[0].closed, 1, "một tin đóng");
  ok(job(db, be).closed_at, "closed_at được ghi");
  eq(job(db, be).status, "queue", "status không đổi");
  eq(J.getJob(db, be).closedAt, job(db, be).closed_at, "API trả closedAt");
  eq(C.getCompany(db, wolt.id).lastNewAt, firstNew, "không tin mới → last_new_at giữ nguyên");
  eq(one(db, "SELECT COUNT(*) n FROM events").n, 3, "đóng/mở không ghi event");

  feed = feedOf([{ title: "Backend Engineer", location: "Helsinki" }, { title: "Data Engineer", location: "Helsinki" }], "v3");
  p.start(); await p.wait();
  eq(job(db, be).closed_at, null, "xuất hiện lại → mở lại");
  eq(one(db, "SELECT COUNT(*) n FROM jobs").n, 2, "không tạo job mới");
  eq(J.markClosed(db, "ats:nope:x", []), { closed: 0, reopened: 0 }, "nguồn lạ không đụng ai");
  invariants(db);
});

await checkAsync("runIfStale: chưa kéo → kéo; vừa kéo → không; quá 12 tiếng → kéo; đang chạy → không", async () => {
  const db = openDb(":memory:");
  let block;
  const fetchAts = () => new Promise((res) => { block = () => res(feedOf([])); });
  atsCompany(db, "Wolt", "greenhouse", "wolt");
  const p = createPuller(db, { fetchAts, extra: [], gapMs: 0 });
  eq(p.runIfStale().started, true, "chưa kéo lần nào → kéo");
  eq(p.runIfStale().started, false, "đang chạy → không");
  block(); await p.wait();
  eq(p.runIfStale().started, false, "vừa kéo → không");
  C.setSetting(db, "last_pull", new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString());
  eq(p.runIfStale().started, true, "13 tiếng → kéo");
  block(); await p.wait();
  eq(atsSource({ ats: "greenhouse", atsToken: "wolt" }).source, "ats:greenhouse:wolt", "source key");
});

await checkAsync("công ty manual hoặc chưa dò không được kéo", async () => {
  const db = openDb(":memory:");
  C.addCompany(db, { name: "NoAts" });
  atsCompany(db, "Manual Co", "manual", null);
  let calls = 0;
  const p = createPuller(db, { fetchAts: async () => { calls++; return feedOf([]); }, extra: [], gapMs: 0 });
  p.start();
  await p.wait();
  eq(calls, 0, "không gọi feed nào");
});

check("ứng viên ATS: link máy đoán chỉ ghi ats_candidate; Xác nhận → ats; Sai → bỏ, ats giữ nguyên", () => {
  const db = openDb(":memory:");
  const { company } = C.addCompany(db, { name: "Knowit" });
  C.setCompanyCandidate(db, company.id, { platform: "greenhouse", token: "udacity", total: 17, url: "https://www.udacity.com/" });
  let c = C.getCompany(db, company.id);
  eq([c.ats, c.atsCandidate.platform, c.atsCandidate.token], [null, "greenhouse", "udacity"], "ứng viên không đụng ats");
  ok(c.atsCandidate.at, "có thời điểm");
  c = C.resolveCandidate(db, company.id, false);
  eq([c.ats, c.atsCandidate], [null, null], "Sai → bỏ ứng viên, ats vẫn NULL");
  // ats đã lỡ ghi (bấm Dò ATS trên link máy đoán) rồi mới bấm Sai: ats phải về NULL, link đoán bị bỏ.
  C.patchCompany(db, company.id, { url: "https://www.udacity.com/" });
  C.setCompanyAts(db, company.id, { platform: "greenhouse", token: "udacity" });
  C.setCompanyCandidate(db, company.id, { platform: "greenhouse", token: "udacity", total: 17, url: "https://www.udacity.com/", guessedLink: true });
  c = C.resolveCandidate(db, company.id, false);
  eq([c.ats, c.atsToken, c.atsCandidate, c.url], [null, null, null, ""], "Sai → ats NULL, token NULL, link máy đoán bị bỏ");
  // Link do người điền thì Sai không đụng link.
  C.patchCompany(db, company.id, { url: "https://www.knowit.fi/careers" });
  C.setCompanyCandidate(db, company.id, { platform: "lever", token: "x", url: "https://www.knowit.fi/careers" });
  eq(C.resolveCandidate(db, company.id, false).url, "https://www.knowit.fi/careers", "link người điền giữ nguyên");
  C.setCompanyCandidate(db, company.id, { platform: "workable", token: "knowit", total: 3 });
  c = C.resolveCandidate(db, company.id, true);
  eq([c.ats, c.atsToken, c.atsCandidate], ["workable", "knowit", null], "Xác nhận → ats");
  let threw = false;
  try { C.resolveCandidate(db, company.id, true); } catch (e) { threw = e.status === 400; }
  ok(threw, "không có ứng viên thì 400");
  C.setCompanyCandidate(db, company.id, { platform: "manual", error: "không thấy" });
  eq(C.resolveCandidate(db, company.id, true).ats, "manual", "xác nhận manual cũng là câu trả lời");
});

check("killBySource: tin từ nguồn ghi nhầm công ty → killed, decided_by human, note, event; không xóa", () => {
  const db = openDb(":memory:");
  const src = { source: "ats:greenhouse:udacity", channel: "Trang công ty" };
  J.ingest(db, [{ title: "Backend Engineer", company: "Knowit" }, { title: "Sales Manager", company: "Knowit" }, { title: "Data Engineer", company: "Knowit" }], src);
  const be = one(db, "SELECT id FROM jobs WHERE title = 'Backend Engineer'").id;
  J.decide(db, be, "queue");
  const before = one(db, "SELECT COUNT(*) n FROM events").n;
  eq(J.killBySource(db, src.source, "sai công ty"), { killed: 3, total: 3 }, "cả tin luật đã loại cũng chuyển sang quyết định người");
  eq(one(db, "SELECT COUNT(*) n FROM jobs").n, 3, "không xóa");
  eq(db.prepare("SELECT status, decided_by, note FROM jobs").all(), Array(3).fill({ status: "killed", decided_by: "human", note: "sai công ty" }), "trạng thái");
  eq(one(db, "SELECT COUNT(*) n FROM events").n - before, 3, "mỗi tin một event");
  eq(J.killBySource(db, src.source, "sai công ty").killed, 0, "chạy lại không ghi event thừa");
  eq(J.killBySource(db, "ats:nope:x", "n"), { killed: 0, total: 0 }, "nguồn lạ không đụng ai");
  invariants(db);
});

/* ============================ bước 3: IMAP ============================ */

check("khóa mail: Message-ID, thiếu thì hash(from+date+subject)", () => {
  eq(mailKey({ messageId: "<a@x>", from: "f", date: "d", subject: "s" }), "<a@x>", "có Message-ID");
  const h1 = mailKey({ from: "jobs@linkedin.com", date: "2026-09-16", subject: "5 new jobs" });
  const h2 = mailKey({ from: "jobs@linkedin.com", date: "2026-09-16", subject: "5 new jobs" });
  const h3 = mailKey({ from: "jobs@linkedin.com", date: "2026-09-17", subject: "5 new jobs" });
  ok(h1.startsWith("hash:") && h1 === h2 && h1 !== h3, "hash ổn định và phân biệt");
});

check("chữ đưa cho Claude: HTML ưu tiên hơn text/plain, link giữ dạng 'chức danh (url)'", () => {
  const { text, truncated } = mailText({ html: '<p><a href="https://lnkd.in/x1">Backend Engineer</a> at Wolt</p>', text: "Backend Engineer at Wolt https://short/x" });
  ok(text.includes("Backend Engineer (https://lnkd.in/x1)") && !text.includes("short/x"), text);
  ok(!truncated, "không cắt");
  eq(mailText({ text: "chỉ text" }).text, "chỉ text", "không có HTML thì lấy text");
  ok(mailText({ text: "x".repeat(70_000) }).truncated, "quá 60k thì báo cắt");
});

check("kênh từ người gửi; khớp dòng trong bảng sources", () => {
  eq(mailChannel({ from: "jobs-noreply@linkedin.com", fromName: "LinkedIn Job Alerts" }), "LinkedIn", "linkedin");
  eq(mailChannel({ from: "noreply@duunitori.fi", fromName: "Duunivahti" }), "Duunitori", "duunivahti → Duunitori");
  eq(mailChannel({ from: "alerts@thehub.io", fromName: "" }), "The Hub", "theo domain");
  eq(mailChannel({ from: "noreply@engradar.com", fromName: "EngRadar Alerts" }), "EngRadar", "engradar");
  eq(mailChannel({ from: "x@unknown-board.com", fromName: "" }), "unknown-board.com", "không rõ thì domain");
  const db = openDb(":memory:");
  const sources = C.listSources(db);
  eq(sourceFor(sources, "LinkedIn").id, "s1", "LinkedIn ↔ LinkedIn Jobs");
  eq(sourceFor(sources, "Duunitori").id, "s2", "Duunitori");
  eq(sourceFor(sources, "Oikotie").id, "s3", "Oikotie ↔ Oikotie Työpaikat");
  eq(sourceFor(sources, "Jobly"), undefined, "không có dòng thì undefined");
});

await checkAsync("parser Claude: gọi đúng dạng, trả JSON, lọc tin thiếu chức danh; từ chối và lỗi HTTP ném", async () => {
  let seen;
  const fetchFn = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ jobs: [
      { title: "Backend Engineer", company: "Wolt", location: "Helsinki", url: "https://lnkd.in/1", adLanguage: "en" },
      { title: "Harjoitteluun Bravida Finlandille", company: "Bravida", location: "Vantaa", url: "https://lnkd.in/2", adLanguage: "fi" },
      { title: "", company: "X", location: "", url: "" },
    ] }) }] }) };
  };
  const items = await extractJobs("mail", { apiKey: "k", model: "claude-opus-5", fetchFn });
  eq(items, [
    { title: "Backend Engineer", company: "Wolt", location: "Helsinki", url: "https://lnkd.in/1", adLanguage: "en" },
    { title: "Harjoitteluun Bravida Finlandille", company: "Bravida", location: "Vantaa", url: "https://lnkd.in/2", adLanguage: "fi" },
  ], "kết quả, có adLanguage");
  eq(seen.body.output_config.format.schema.properties.jobs.items.properties.adLanguage.enum, ["fi", "en"], "schema đòi adLanguage");
  eq(seen.url, "https://api.anthropic.com/v1/messages", "endpoint");
  eq(seen.init.headers["x-api-key"], "k", "key");
  eq(seen.init.headers["anthropic-version"], "2023-06-01", "version");
  eq(seen.body.model, "claude-opus-5", "model");
  eq(Object.keys(seen.body).sort(), ["max_tokens", "messages", "model", "output_config", "system"], "khóa của body");
  ok(!JSON.stringify(seen.body).includes('"effort"'), "body không chứa effort");
  eq(Object.keys(seen.body.output_config), ["format"], "output_config chỉ có format");
  eq(seen.body.output_config.format.type, "json_schema", "ép JSON theo schema");
  eq(seen.body.output_config.format.schema.required, ["jobs"], "schema có jobs");
  ok(typeof seen.body.system === "string" && seen.body.system.length > 50, "system prompt");
  eq(seen.body.messages[0].content, "mail", "mail là user turn");
  ok(!JSON.stringify(buildRequest("x", "m")).includes('"effort"'), "buildRequest không effort");
  eq(parseJobsJson('Here you go:\n```json\n{"jobs":[{"title":"A","company":"B","location":"","url":""}]}\n```'), [{ title: "A", company: "B", location: "", url: "" }], "JSON trong rào và chữ thừa vẫn tách được");
  let bad = "";
  try { parseJobsJson("no json here"); } catch (e) { bad = e.message; }
  ok(/JSON/.test(bad), "không có JSON thì ném");
  let err = "";
  try { await extractJobs("m", { apiKey: "k", fetchFn: async () => ({ ok: true, json: async () => ({ stop_reason: "refusal", content: [] }) }) }); } catch (e) { err = e.message; }
  ok(/từ chối/.test(err), `refusal: ${err}`);
  try { await extractJobs("m", { apiKey: "k", fetchFn: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "slow down" } }) }) }); } catch (e) { err = e.message; }
  ok(/429/.test(err), `HTTP: ${err}`);
  try { await extractJobs("m", { apiKey: "" }); } catch (e) { err = e.message; }
  ok(/ANTHROPIC_API_KEY/.test(err), "thiếu key");
});

await checkAsync("bước IMAP: mỗi mail qua ingest + luật; mail đã xử lý không đọc lại; parser hỏng thì không đánh dấu; nguồn bật alert đều có last_pull", async () => {
  const db = openDb(":memory:");
  C.patchSource(db, "s1", { alert: true });
  C.patchSource(db, "s3", { alert: true }); // Oikotie: bật alert nhưng không có mail
  const mails = [
    { key: "<m1@linkedin>", from: "jobs-noreply@linkedin.com", fromName: "LinkedIn", subject: "a", text: "M1", truncated: false },
    { key: "<m2@duunitori>", from: "noreply@duunitori.fi", fromName: "Duunivahti", subject: "b", text: "M2", truncated: false },
    { key: "<m3@linkedin>", from: "jobs-noreply@linkedin.com", fromName: "LinkedIn", subject: "c", text: "BOOM", truncated: false },
  ];
  const fetched = [];
  const fetchMails = async ({ skip, label, user }) => {
    eq([label, user], ["jobalerts", "me@gmail.com"], "cấu hình từ env");
    const fresh = mails.filter((m) => !skip(m.key));
    fetched.push(fresh.map((m) => m.key));
    return { mails: fresh, scanned: mails.length };
  };
  let extracts = 0;
  const extract = async (text) => {
    extracts++;
    if (text === "BOOM") throw new Error("Claude HTTP 500");
    if (text === "M1") return [{ title: "Backend Engineer", company: "Wolt", location: "Helsinki", url: "https://l/1" }, { title: "Sales Manager", company: "Wolt", location: "Helsinki", url: "https://l/2" }, { title: "Korkeakouluharjoittelu", company: "DNA", location: "Helsinki", url: "https://l/3", adLanguage: "fi" }];
    return [{ title: "Backend Engineer", company: "Wolt", location: "Helsinki", url: "https://d/1" }];
  };
  const env = { IMAP_USER: "me@gmail.com", IMAP_APP_PASSWORD: "p", ANTHROPIC_API_KEY: "k" };
  ok(imapConfigured(env) && !imapConfigured({}), "imapConfigured");
  const step = createImapStep({ env, fetchMails, extract });
  const p = createPuller(db, { fetchAts: async () => feedOf([]), extra: [step], gapMs: 0 });
  p.start(); const s = await p.wait();
  const li = s.results.find((r) => r.name === "LinkedIn");
  const du = s.results.find((r) => r.name === "Duunitori");
  eq([li.kind, li.mails, li.added, li.auto, li.error], ["imap", 1, 3, 2, "Claude HTTP 500"], "LinkedIn: 1 mail xong, 1 mail hỏng");
  eq(state(db, one(db, "SELECT id FROM jobs WHERE title = 'Korkeakouluharjoittelu'").id), ["doubt", "rule", "r_lang"], "adLanguage fi từ Claude → luật ngôn ngữ bắt, dù tiêu đề không có ä/ö");
  eq([du.mails, du.added, du.dup], [1, 0, 1], "Duunitori: trùng → gộp kênh");
  eq(J.listJobs(db).find((j) => j.title === "Backend Engineer").channels, ["LinkedIn", "Duunitori"], "hai kênh");
  eq(one(db, "SELECT COUNT(*) n FROM mail_seen").n, 2, "mail hỏng không được đánh dấu");
  const src = Object.fromEntries(C.listSources(db).map((x) => [x.id, x]));
  ok(src.s1.lastPull && src.s1.lastNewAt && src.s1.firstPull, "LinkedIn: có tin mới");
  ok(src.s2.lastPull && !src.s2.lastNewAt, "Duunitori: chỉ trùng → không last_new_at");
  ok(src.s3.lastPull && !src.s3.lastNewAt && src.s3.pullCount === 0, "Oikotie bật alert, không mail → vẫn ghi last_pull");
  ok(!src.s5.lastPull, "nguồn không bật alert, không mail → không đụng");
  eq(src.s1.lastError, "Claude HTTP 500", "lỗi ghi vào nguồn");

  p.start(); await p.wait();
  eq(fetched[1], ["<m3@linkedin>"], "lần hai chỉ còn mail hỏng lần trước");
  eq(extracts, 4, "không gọi Claude lại cho mail đã xử lý");
  eq(one(db, "SELECT COUNT(*) n FROM jobs").n, 3, "không nạp lại");
  invariants(db);
});

await checkAsync("fetchAlertMails: cửa sổ 14 ngày, envelope trước rồi mới tải source của mail mới, không đổi cờ, luôn logout", async () => {
  const calls = [];
  const box = [
    { uid: 1, envelope: { messageId: "<old@x>", from: [{ address: "a@x" }], date: new Date(), subject: "s" } },
    { uid: 2, envelope: { messageId: "<new@x>", from: [{ address: "jobs@linkedin.com", name: "LinkedIn" }], date: new Date(), subject: "t" } },
    { uid: 3, envelope: { from: [{ address: "b@x" }], date: new Date(), subject: "no id" } },
  ];
  const makeClient = () => ({
    connect: async () => calls.push("connect"),
    logout: async () => calls.push("logout"),
    getMailboxLock: async (name) => { calls.push(`lock:${name}`); return { release: () => calls.push("release") }; },
    fetch: async function* (q, opts) {
      calls.push(`fetch:since=${q.since instanceof Date}:src=${Boolean(opts.source)}`);
      for (const m of box) yield m;
    },
    fetchOne: async (uid) => {
      calls.push(`one:${uid}`);
      return { source: Buffer.from(`From: LinkedIn <jobs@linkedin.com>\r\nSubject: t\r\nContent-Type: text/html\r\n\r\n<a href="https://l/1">Backend Engineer</a>`) };
    },
    messageFlagsAdd: () => { throw new Error("không được đụng cờ"); },
    messageDelete: () => { throw new Error("không được xóa"); },
  });
  const r = await fetchAlertMails({ label: "jobalerts", skip: (k) => k === "<old@x>", makeClient });
  eq(r.scanned, 3, "quét 3");
  eq(r.mails.map((m) => m.key), ["<new@x>", r.mails[1].key], "hai mail mới");
  ok(r.mails[1].key.startsWith("hash:"), "mail không Message-ID dùng hash");
  ok(r.mails[0].text.includes("Backend Engineer (https://l/1)"), r.mails[0].text);
  eq(r.mails[0].from, "jobs@linkedin.com", "from");
  eq(calls, ["connect", "lock:jobalerts", "fetch:since=true:src=false", "one:2", "one:3", "release", "logout"], "thứ tự gọi");
});

check("imap.js không xóa, không expunge, không đổi cờ mail", () => {
  eq(scanSrc(/messageDelete|expunge|messageFlagsAdd|messageFlagsSet|messageMove|\\Deleted|\\Seen/), [], "chỗ đụng hộp thư");
});

console.log(failed ? `\n${failed} FAIL` : "\nTất cả PASS");
process.exit(failed ? 1 : 0);
