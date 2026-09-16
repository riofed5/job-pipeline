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
import { parseFeed, filterLocation, guessLanguage, fetchAts } from "../src/ingest/ats.js";
import { guessFromUrl, guessFromHtml, detectAts } from "../src/ingest/detect-ats.js";
import { createPuller, summarize, atsSource } from "../src/ingest/pull.js";

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
});

check("parse feed: 7 nền tảng, mỗi nền tảng ra title/location/url", () => {
  const cases = {
    greenhouse: [JSON.stringify({ jobs: [{ id: 1, title: "Backend Engineer", absolute_url: "https://boards.greenhouse.io/wolt/jobs/1", location: { name: "Helsinki, Finland" }, updated_at: "2026-09-01T00:00:00Z", content: "&lt;p&gt;Hello &amp;amp; hi&lt;/p&gt;" }] }), "wolt"],
    lever: [JSON.stringify([{ id: "a", text: "Data Engineer", hostedUrl: "https://jobs.lever.co/x/a", categories: { location: "Helsinki" }, createdAt: 1756684800000, descriptionPlain: "JD" }]), "x"],
    ashby: [JSON.stringify({ jobs: [{ id: "a", title: "SRE", jobUrl: "https://jobs.ashbyhq.com/x/a", location: "Helsinki", isRemote: true, publishedAt: "2026-09-01", descriptionHtml: "<p>JD</p>" }] }), "x"],
    recruitee: [JSON.stringify({ offers: [{ id: 1, title: "Dev", careers_url: "https://x.recruitee.com/o/dev", city: "Espoo", country: "Finland", created_at: "2026-09-01", description: "<p>JD</p>" }] }), "x"],
    smartrecruiters: [JSON.stringify({ content: [{ id: "99", name: "QA Engineer", location: { city: "Tampere", country: "fi" }, releasedDate: "2026-09-01T00:00:00Z" }] }), "x"],
    workable: [JSON.stringify({ jobs: [{ title: "Frontend", shortcode: "AB", url: "https://apply.workable.com/x/j/AB", city: "Oulu", country: "Finland", published_on: "2026-09-01", description: "<p>JD</p>" }] }), "x"],
    personio: ["<workzag-jobs><position><id>7</id><office>Helsinki</office><name>Ohjelmistokehittäjä</name><jobDescriptions><jobDescription><name>Tehtävä</name><value><![CDATA[<p>Meillä ja sinulla</p>]]></value></jobDescription></jobDescriptions></position></workzag-jobs>", "acme"],
    teamtailor: ["<rss><channel><item><title>Platform Engineer</title><link>https://career.acme.fi/jobs/1</link><location>Helsinki</location><pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate><description><![CDATA[<p>JD</p>]]></description></item></channel></rss>", "https://career.acme.fi"],
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
  eq(kept.map((x) => x.title), ["a", "b", "d", "e"], "giữ");
  eq(dropped.map((x) => x.title), ["c"], "ngoài phạm vi");
  eq(filterLocation(items, "").kept.length, 5, "danh sách trống = không lọc");
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
  const p = createPuller(db, { fetchAts, gapMs: 0 });
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

await checkAsync("kéo lại: 304 không đụng gì; tin biến khỏi feed → closed_at; quay lại → mở lại; không đổi status", async () => {
  const db = openDb(":memory:");
  const wolt = atsCompany(db, "Wolt", "greenhouse", "wolt");
  let feed = feedOf([{ title: "Backend Engineer", location: "Helsinki" }, { title: "Data Engineer", location: "Helsinki" }], "v1");
  const fetchAts = async (platform, token, { etag }) => (etag === feed.etag ? { notModified: true, etag } : feed);
  const p = createPuller(db, { fetchAts, gapMs: 0 });
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
  const p = createPuller(db, { fetchAts, gapMs: 0 });
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
  const p = createPuller(db, { fetchAts: async () => { calls++; return feedOf([]); }, gapMs: 0 });
  p.start();
  await p.wait();
  eq(calls, 0, "không gọi feed nào");
});

console.log(failed ? `\n${failed} FAIL` : "\nTất cả PASS");
process.exit(failed ? 1 : 0);
