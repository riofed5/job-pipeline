/* Bước 5 — phân tích fit cho tin ở Hàng đọc.

   Với mỗi tin status = 'queue' chưa có fit hoặc fit làm với CV cũ (hash profile/cv.md lệch): lấy JD, đưa CV + JD +
   title/company/location cho Claude, nhận JSON {fit, reason, confidence, gaps, strengths, years_required,
   finnish_required, deadline}, ghi jobs.fit_json. Tối đa 20 tin một lượt. Chạy nền trong process của server như
   pull.js: start() trả về ngay, status() cho UI hỏi. Không timer, không cron.

   JD: tin ATS đã có description. Tin khác fetch link gốc (kể cả trang tin lẻ linkedin.com/jobs/view, không đăng
   nhập, cách nhau 1 giây), ưu tiên JSON-LD JobPosting (sạch, có validThrough), không thì <main>/<article>/<body>,
   bỏ thẻ, cắt 8.000 ký tự. Fetch hỏng, không phải 200, trang đăng nhập, hay quá ngắn → jd_source = 'title_only' và
   confidence bị CODE ép 'low', không tin model.

   Claude chỉ gắn nhãn. File này không có đường nào đổi status/outcome của tin; cột fit/JD ghi qua jobs.setJd và
   jobs.setFit. "Dead" không phải việc của model: closed_at, deadline đã qua, hoặc HTTP 404/410 — xem src/ui/fit.js. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { now } from "../core/db.js";
import * as jobs from "../core/jobs.js";
import { htmlToText, decodeEntities } from "./html.js";
import { USER_AGENT } from "./ats.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MODEL = "claude-fable-5-1";
const EFFORT = "high";
export const LIMIT = 20;              // tin một lượt
export const MAX_JD_CHARS = 8000;
const MIN_JD_CHARS = 200;             // dưới mức này không phải JD (trang lỗi, shell SPA)
const FETCH_TIMEOUT_MS = 20_000;
const CLAUDE_TIMEOUT_MS = 180_000;    // Fable ở effort cao có thể nghĩ lâu
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const REASONS = ["domain", "stack", "level_low", "level_high", "language", "location", "none"];

export function enrichConfig(env = process.env) {
  return {
    apiKey: env.ANTHROPIC_API_KEY || "",
    model: env.ENRICH_MODEL || DEFAULT_MODEL,
    cvPath: env.CV_PATH || path.join(ROOT, "profile", "cv.md"),
  };
}
export const enrichConfigured = (env = process.env) => Boolean(enrichConfig(env).apiKey);

/* ---------------------------- CV ---------------------------- */

export const cvHashOf = (text) => crypto.createHash("sha1").update(String(text)).digest("hex");

/* Đọc CV. Thiếu file hay trống → ném lỗi, lượt chạy dừng trước khi ghi gì. */
export function loadCv(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { throw new Error(`chưa có ${path.relative(ROOT, file) || file} — chép từ profile/cv.example.md`); }
  text = text.trim();
  if (!text) throw new Error(`${path.relative(ROOT, file)} trống`);
  return { text, hash: cvHashOf(text) };
}

/* ---------------------------- JD ---------------------------- */

export async function httpGetHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.5", "Accept-Language": "en, fi;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.text(), url: res.url };
}

const LOGIN_URL = /\/(login|authwall|checkpoint|signin|sign-in|uas\/login)\b/i;

/* JSON-LD JobPosting trong trang: description (HTML) và validThrough. Nhiều trang tuyển dụng (kể cả LinkedIn
   trang khách) có sẵn, sạch hơn nhiều so với bỏ thẻ cả trang. */
export function jobPostingLd(html) {
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html ?? "")))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const list = Array.isArray(data) ? data : [data, ...(Array.isArray(data?.["@graph"]) ? data["@graph"] : [])];
    for (const d of list) {
      const t = d?.["@type"];
      if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return d;
    }
  }
  return null;
}

const ymdOf = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? "").trim());
  return m ? m[1] : null;
};

/* Khối mô tả theo class: LinkedIn trang khách (show-more-less-html__markup, description__text) không có JSON-LD,
   và <main> của nó mở đầu bằng modal đăng nhập. Lấy từ khối đó tới hết <main>; phần đuôi (tin tương tự) nằm sau 8k. */
const DESC_CLASS = /<[a-z][^>]*\bclass\s*=\s*["'][^"']*(show-more-less-html__markup|description__text|job-description|jobDescription)/i;

/* Chữ JD từ HTML: JSON-LD JobPosting → khối mô tả theo class → <main> → <article> → cả trang. */
export function jdFromHtml(html) {
  const ld = jobPostingLd(html);
  if (ld?.description) {
    const text = htmlToText(decodeEntities(String(ld.description)));
    if (text.length >= MIN_JD_CHARS) return { text, deadline: ymdOf(ld.validThrough), via: "ld+json" };
  }
  let scope = String(html ?? "");
  let via = "body";
  const pick = /<main\b[\s\S]*?<\/main>/i.exec(scope) ?? /<article\b[\s\S]*?<\/article>/i.exec(scope);
  if (pick) { scope = pick[0]; via = "main"; }
  const desc = DESC_CLASS.exec(scope);
  if (desc) { scope = scope.slice(desc.index); via = "description"; }
  return { text: htmlToText(scope), deadline: ymdOf(ld?.validThrough), via };
}

/* → { source: 'fetched', status, text, deadline } hoặc { source: 'title_only', status, why }. Không ném lỗi. */
export async function fetchJd(url, { get = httpGetHtml } = {}) {
  if (!url) return { source: "title_only", status: null, why: "không có link" };
  let res;
  try { res = await get(url); } catch (e) { return { source: "title_only", status: null, why: e.name === "TimeoutError" ? "quá 20 giây" : e.message }; }
  if (res.status !== 200) return { source: "title_only", status: res.status, why: `HTTP ${res.status}` };
  if (LOGIN_URL.test(res.url ?? "")) return { source: "title_only", status: 200, why: "trang đăng nhập" };
  const jd = jdFromHtml(res.body);
  const text = jd.text.slice(0, MAX_JD_CHARS);
  if (text.length < MIN_JD_CHARS) return { source: "title_only", status: 200, why: "trang không có mô tả" };
  return { source: "fetched", status: 200, text, deadline: jd.deadline, via: jd.via };
}

/* ---------------------------- Claude ---------------------------- */

const SYSTEM = `You screen job postings for one specific candidate, whose CV follows. For each posting you get the title, company, location, and the job description when it could be fetched (it may be missing). Decide whether this posting is worth the candidate's reading time. Be honest and concrete; a wrong "on" wastes an hour, a wrong "off" loses an application.
- fit: "on" when the candidate could credibly apply and have a real chance; "off" otherwise.
- reason: the single main reason when off — domain (different field of work), stack (core technology the candidate does not have and cannot pick up quickly), level_low (intern, junior, trainee, below the candidate), level_high (lead, principal, head, or far more years than the candidate has), language (requires Finnish, Swedish or another language the candidate lacks), location (not in Finland and not remote from Finland). "none" when on.
- confidence: "high" only when the description is present and the call is clear. Without a description, or when the posting is vague, "low".
- gaps: at most 3 short lines — things the posting asks for that the CV does not show. strengths: at most 2 short lines — what in the CV matches this posting. Plain sentences, no bullets, no markdown.
- years_required: years of experience the posting asks for, as an integer, or null when not stated.
- finnish_required: true only when the job itself requires Finnish language skills (not merely a posting written in Finnish).
- deadline: application deadline as YYYY-MM-DD when the posting states one, else null. Extract only; do not guess.
Without a description, judge from title, company and location only, keep gaps and strengths tentative, and say so in them.`;

const SCHEMA = {
  type: "object",
  properties: {
    fit: { type: "string", enum: ["on", "off"] },
    reason: { type: "string", enum: REASONS },
    confidence: { type: "string", enum: ["high", "low"] },
    gaps: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } },
    years_required: { anyOf: [{ type: "integer" }, { type: "null" }] },
    finnish_required: { type: "boolean" },
    deadline: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["fit", "reason", "confidence", "gaps", "strengths", "years_required", "finnish_required", "deadline"],
  additionalProperties: false,
};

/* Fable: thinking luôn bật, KHÔNG gửi tham số thinking (gửi disabled là 400); độ sâu qua output_config.effort.
   CV nằm trong system kèm cache_control để 20 tin một lượt chỉ trả tiền CV một lần. */
export function buildFitRequest({ cv, job, jd }, model) {
  const input = { title: job.title, company: job.company, location: job.location ?? null, description: jd ?? null };
  return {
    model,
    max_tokens: 4000,
    system: [
      { type: "text", text: SYSTEM },
      { type: "text", text: `CANDIDATE CV:\n${cv}`, cache_control: { type: "ephemeral" } },
    ],
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: JSON.stringify(input) }],
  };
}

const lines = (v, n) => (Array.isArray(v) ? v : []).map((s) => String(s ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, n);

/* Kết quả model về dạng chuẩn. Luật của hệ thống thắng model: không có JD → confidence low; on → reason none. */
export function normalizeFit(raw, { hasJd }) {
  const r = raw && typeof raw === "object" ? raw : {};
  if (r.fit !== "on" && r.fit !== "off") throw new Error("Claude không trả fit on/off");
  const fit = r.fit;
  const reason = fit === "on" ? "none" : REASONS.includes(r.reason) && r.reason !== "none" ? r.reason : "domain";
  const confidence = !hasJd ? "low" : r.confidence === "high" ? "high" : "low";
  const years = Number.isInteger(r.years_required) && r.years_required >= 0 && r.years_required < 50 ? r.years_required : null;
  return {
    fit,
    reason,
    confidence,
    gaps: lines(r.gaps, 3),
    strengths: lines(r.strengths, 2),
    years_required: years,
    finnish_required: r.finnish_required === true,
    deadline: ymdOf(r.deadline),
  };
}

export function parseFitJson(out) {
  const s = String(out ?? "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) throw new Error("Claude không trả JSON");
  return JSON.parse(s.slice(a, b + 1));
}

export async function assessFit({ cv, job, jd }, { apiKey, model = DEFAULT_MODEL, fetchFn = fetch } = {}) {
  if (!apiKey) throw new Error("thiếu ANTHROPIC_API_KEY");
  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(buildFitRequest({ cv, job, jd }, model)),
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}: ${data.error?.message ?? ""}`.trim());
  if (data.stop_reason === "refusal") throw new Error("Claude từ chối tin này");
  if (data.stop_reason === "max_tokens") throw new Error("Claude bị cắt giữa chừng (max_tokens)");
  const out = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return normalizeFit(parseFitJson(out), { hasJd: Boolean(jd) });
}

/* ---------------------------- lượt chạy ---------------------------- */

/* Giống createPuller: start() trả về ngay, status() cho UI hỏi; không timer. Tiêm fetchJd / assess / loadCv để kiểm
   không cần mạng. Mỗi tin một dòng kết quả: { id, title, company, jdSource, fit, error }. */
export function createEnricher(db, { env = process.env, fetchJd: getJd = fetchJd, assess = assessFit, readCv = loadCv, gapMs = 1000, limit = LIMIT, log = () => {} } = {}) {
  let running = false;
  let startedAt = null;
  let finishedAt = null;
  let results = [];
  let fatal = null;

  /* CV hiện tại và số tin chờ — đọc file mỗi lần hỏi, rẻ, để UI biết "CV đã đổi" mà không cần bộ nhớ riêng. */
  function cvState() {
    const cfg = enrichConfig(env);
    try {
      const cv = readCv(cfg.cvPath);
      return { cvHash: cv.hash, cvError: null, pending: jobs.countPendingFit(db, cv.hash) };
    } catch (e) {
      return { cvHash: null, cvError: e.message, pending: null };
    }
  }

  async function one(cv, cfg, j) {
    const r = { id: j.id, title: j.title, company: j.company, jdSource: j.jdSource ?? null, fit: null, error: null, fetched: false };
    try {
      let jd = j.description || null;
      if (jd) {
        if (j.jdSource !== "ats" && j.jdSource !== "fetched") jobs.setJd(db, j.id, { source: "ats" });
        r.jdSource = j.jdSource === "fetched" ? "fetched" : "ats";
      } else {
        r.fetched = true;
        const got = await getJd(j.url);
        jobs.setJd(db, j.id, { source: got.source, httpStatus: got.status, description: got.text ?? null, deadline: got.deadline ?? null });
        r.jdSource = got.source;
        if (got.source === "title_only") r.why = got.why;
        jd = got.text ?? null;
      }
      const fit = await assess({ cv: cv.text, job: j, jd }, cfg);
      jobs.setFit(db, j.id, { fit, cvHash: cv.hash, deadline: fit.deadline });
      r.fit = fit;
    } catch (e) {
      r.error = e.message;
    }
    return r;
  }

  async function run() {
    const cfg = enrichConfig(env);
    if (!cfg.apiKey) throw new Error("thiếu ANTHROPIC_API_KEY trong .env");
    const cv = readCv(cfg.cvPath); // thiếu CV → ném, không ghi gì
    const list = jobs.pendingFit(db, cv.hash, limit);
    let fetchedBefore = false;
    for (const j of list) {
      if (fetchedBefore && !j.description) await sleep(gapMs); // lịch sự: 1 fetch/giây
      const r = await one(cv, cfg, j);
      fetchedBefore = r.fetched;
      results.push(r);
      log(r);
    }
  }

  function start() {
    if (running) return { started: false, ...status() };
    running = true;
    fatal = null;
    startedAt = now();
    finishedAt = null;
    results = [];
    run()
      .catch((e) => { fatal = e.message; })
      .finally(() => { running = false; finishedAt = now(); });
    return { started: true, ...status() };
  }

  function status() {
    return { running, startedAt, finishedAt, results, error: fatal, ...cvState() };
  }

  async function wait() {
    while (running) await sleep(10);
    return status();
  }

  return { start, status, wait };
}

/* ---------------------------- xuất JD ----------------------------
   Nút "Xuất JD": ghi jd/<company>-<title>.md để đọc ngoài app (thư mục JD_EXPORT_DIR). Đây là đường DUY NHẤT
   description rời app ra ngoài, và là việc đắt — người bấm từng tin, không có xuất hàng loạt. */

export const slug = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

export function exportJd({ title, company, url, description }, dir) {
  if (!description) throw Object.assign(new Error("tin này chưa có JD — chưa phân tích, hoặc không lấy được mô tả"), { status: 400 });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(company)}-${slug(title)}.md`);
  fs.writeFileSync(file, `# ${title}\n\n${company}\n\n${url ?? ""}\n\n---\n\n${description}\n`);
  return file;
}
