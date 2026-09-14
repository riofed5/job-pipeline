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

console.log(failed ? `\n${failed} FAIL` : "\nTất cả PASS");
process.exit(failed ? 1 : 0);
