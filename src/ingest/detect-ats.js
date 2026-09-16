/* Dò ATS từ URL trang tuyển dụng. Ba tầng: xét URL trước (EngRadar, link ATS dán thẳng),
   rồi fetch HTML và tìm dấu vết từng nền tảng, rồi XÁC NHẬN bằng một lần gọi feed thật.
   Chỉ khi feed trả về và parse được mới ghi vào DB. Dò không ra → ats = 'manual'.

   CLI:  node src/ingest/detect-ats.js <url>     chỉ in kết quả, không ghi DB
         node src/ingest/detect-ats.js           dò mọi công ty có link mà chưa có ats, ghi DB */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORMS, fetchAts as realFetchAts, httpGet } from "./ats.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SKIP_TOKENS = new Set(["www", "api", "embed", "apply", "boards", "jobs", "careers", "help", "app", "cdn", "static", "assets"]);
const tok = (s) => (s && !SKIP_TOKENS.has(s.toLowerCase()) ? s : null);

/* Mẫu theo thứ tự thử. Mỗi mẫu: regex trên URL hoặc HTML → {platform, token}. */
const URL_PATTERNS = [
  // EngRadar: engradar.com/jobs/{platform}:{token}:{id} — cho thẳng platform và token.
  [/engradar\.com\/jobs\/([a-z]+):([^:/?#\s"']+)/i, (m) => ({ platform: m[1].toLowerCase(), token: m[2] })],
  [/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([\w-]+)/i, (m) => ({ platform: "greenhouse", token: tok(m[1]) })],
  [/boards-api(?:\.eu)?\.greenhouse\.io\/v1\/boards\/([\w-]+)/i, (m) => ({ platform: "greenhouse", token: tok(m[1]) })],
  [/greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^"'\s>]*&)?for=([\w-]+)/i, (m) => ({ platform: "greenhouse", token: tok(m[1]) })],
  [/jobs\.eu\.lever\.co\/([\w-]+)/i, (m) => ({ platform: "lever", token: tok(m[1]) && `eu:${m[1]}` })],
  [/api\.eu\.lever\.co\/v0\/postings\/([\w-]+)/i, (m) => ({ platform: "lever", token: tok(m[1]) && `eu:${m[1]}` })],
  [/jobs\.lever\.co\/([\w-]+)/i, (m) => ({ platform: "lever", token: tok(m[1]) })],
  [/api\.lever\.co\/v0\/postings\/([\w-]+)/i, (m) => ({ platform: "lever", token: tok(m[1]) })],
  [/jobs\.ashbyhq\.com\/([\w.-]+)/i, (m) => ({ platform: "ashby", token: tok(m[1]) })],
  [/api\.ashbyhq\.com\/posting-api\/job-board\/([\w.-]+)/i, (m) => ({ platform: "ashby", token: tok(m[1]) })],
  [/(?:^|[\s"'/])([\w-]+)\.recruitee\.com/i, (m) => ({ platform: "recruitee", token: tok(m[1]) })],
  [/(?:careers|jobs)\.smartrecruiters\.com\/([\w-]+)/i, (m) => ({ platform: "smartrecruiters", token: tok(m[1]) })],
  [/api\.smartrecruiters\.com\/v1\/companies\/([\w-]+)/i, (m) => ({ platform: "smartrecruiters", token: tok(m[1]) })],
  [/apply\.workable\.com\/(?:api\/v\d\/widget\/accounts\/)?([\w-]+)/i, (m) => ({ platform: "workable", token: tok(m[1]) })],
  [/(?:^|[\s"'/])([\w-]+)\.workable\.com/i, (m) => ({ platform: "workable", token: tok(m[1]) })],
  [/(?:^|[\s"'/])([\w-]+)\.jobs\.personio\.(?:de|com)/i, (m) => ({ platform: "personio", token: tok(m[1]) })],
  [/(?:^|[\s"'/])([\w-]+)\.teamtailor\.com/i, (m) => ({ platform: "teamtailor", token: tok(m[1]) && `https://${m[1]}.teamtailor.com` })],
];

const valid = (c) => c && c.platform in PLATFORMS && c.token;
const key = (c) => `${c.platform}|${c.token}`;

/* Xét riêng URL. Dùng cho link ATS dán thẳng và EngRadar. */
export function guessFromUrl(url) {
  for (const [re, make] of URL_PATTERNS) {
    const m = String(url ?? "").match(re);
    if (m) {
      const c = make(m);
      if (valid(c)) return c;
    }
  }
  return null;
}

/* Quét HTML: mọi mẫu, mọi lần khớp, theo thứ tự xuất hiện, bỏ trùng.
   Teamtailor trên domain riêng: chỉ thấy cdn.teamtailor.com trong HTML → token là origin của trang. */
export function guessFromHtml(html, pageUrl) {
  const s = String(html ?? "");
  const seen = new Set();
  const out = [];
  const push = (c) => {
    if (!valid(c) || seen.has(key(c))) return;
    seen.add(key(c));
    out.push(c);
  };
  const found = [];
  for (const [re, make] of URL_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = g.exec(s))) found.push({ index: m.index, c: make(m) });
  }
  found.sort((a, b) => a.index - b.index).forEach((f) => push(f.c));
  if (/teamtailor/i.test(s) && pageUrl) {
    try { push({ platform: "teamtailor", token: new URL(pageUrl).origin }); } catch { /* URL hỏng thì thôi */ }
  }
  return out;
}

/* Trang career thường là SPA: dấu vết ATS nằm ở trang con "open positions" hoặc trang một tin.
   Lấy link cùng host có mùi việc làm, ưu tiên link có id kiểu ATS, tối đa MAX_SUBPAGES. */
const MAX_SUBPAGES = 4;
const JOBISH = /job|position|opening|vacanc|career|rekry|avoimet|ty(ö|o)paik/i;
const STRONG = /gh_jid|\/jobs\/\d{6,}|lever-|ashby_jid|\?jid=/i;

export function subpageLinks(html, pageUrl) {
  let base;
  try { base = new URL(pageUrl); } catch { return []; }
  const out = new Map();
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(String(html ?? "")))) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) continue;
    let u;
    try { u = new URL(raw, base); } catch { continue; }
    if (u.host !== base.host || !JOBISH.test(u.pathname + u.search)) continue;
    u.hash = "";
    const href = u.toString();
    if (href === base.toString() || /\.(pdf|png|jpg|svg|css|js)$/i.test(u.pathname)) continue;
    if (!out.has(href)) out.set(href, STRONG.test(href) ? 0 : 1);
  }
  return [...out.entries()].sort((a, b) => a[1] - b[1]).map(([href]) => href).slice(0, MAX_SUBPAGES);
}

/* Fallback cuối: đoán slug từ hostname và tên công ty, thử từng nền tảng. Chỉ nhận khi feed có ít nhất
   một tin — SmartRecruiters trả 200 rỗng cho mọi slug, nên HTTP 200 chưa phải bằng chứng. */
const HOST_NOISE = /^(www|careers?|jobs?|join|work|apply|en|fi|about)$/i;

export function slugCandidates(pageUrl, name) {
  const out = new Set();
  try {
    const parts = new URL(pageUrl).hostname.toLowerCase().split(".").filter((p) => !HOST_NOISE.test(p));
    if (parts.length >= 2) {
      const [core, tld] = [parts[parts.length - 2], parts[parts.length - 1]];
      out.add(core);
      out.add(core + tld);
    } else if (parts.length === 1) out.add(parts[0]);
  } catch { /* URL hỏng */ }
  const n = String(name ?? "").toLowerCase().replace(/\b(oy|oyj|ab|ltd|inc|plc|group)\b/g, "").trim();
  if (n) {
    out.add(n.replace(/[^a-z0-9]/g, ""));
    out.add(n.split(/\s+/)[0].replace(/[^a-z0-9]/g, ""));
  }
  const slugs = [...out].filter((s) => s.length >= 3);
  return [...new Set([...slugs, ...slugs.map((s) => s + "oy")])];
}

const HINT = /(greenhouse|ashby|lever\.co|workable|recruitee|smartrecruiters|personio|teamtailor)/gi;
const HINT_PLATFORM = { "lever.co": "lever" };

function slugGuesses(slugs, hints) {
  const platforms = Object.keys(PLATFORMS).sort((a, b) => (hints.has(b) ? 1 : 0) - (hints.has(a) ? 1 : 0));
  return platforms.map((platform) => slugs.map((s) => ({
    platform,
    token: platform === "teamtailor" ? `https://${s}.teamtailor.com` : s,
  })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Dò rồi xác nhận. Trả { platform, token, total, label, tried } hoặc { platform: 'manual', tried, error }.
   get/fetchAts tiêm được để kiểm không cần mạng. Ba tầng: URL → HTML (trang chính + trang con) → đoán slug. */
export async function detectAts(url, { name = "", get = httpGet, fetchAts = realFetchAts, gapMs = 1000 } = {}) {
  const clean = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(clean)) return { platform: "manual", tried: [], error: "link phải bắt đầu bằng http" };

  const candidates = [];
  const push = (c) => { if (c && !candidates.some((x) => key(x) === key(c))) candidates.push(c); };
  push(guessFromUrl(clean));

  const hints = new Set();
  let pageError = null;
  let pageUrl = clean;
  try {
    const page = await get(clean, { accept: "text/html, */*;q=0.5" });
    if (page.status !== 200) pageError = `HTTP ${page.status}`;
    pageUrl = page.url || clean;
    push(pageUrl !== clean ? guessFromUrl(pageUrl) : null); // URL sau redirect cũng có thể chỉ thẳng ATS
    guessFromHtml(page.body, pageUrl).forEach(push);
    for (const h of page.body.match(HINT) ?? []) hints.add(HINT_PLATFORM[h.toLowerCase()] ?? h.toLowerCase());
    if (!candidates.length) {
      for (const sub of subpageLinks(page.body, pageUrl)) {
        await sleep(gapMs);
        try {
          const p = await get(sub, { accept: "text/html, */*;q=0.5" });
          if (p.status !== 200) continue;
          push(p.url && p.url !== sub ? guessFromUrl(p.url) : null);
          guessFromHtml(p.body, p.url || sub).forEach(push);
          for (const h of p.body.match(HINT) ?? []) hints.add(HINT_PLATFORM[h.toLowerCase()] ?? h.toLowerCase());
        } catch { /* trang con hỏng thì bỏ qua */ }
        if (candidates.length) break;
      }
    }
  } catch (e) {
    pageError = e.message;
  }

  const tried = [];
  const confirm = async (c, needItems) => {
    try {
      const r = await fetchAts(c.platform, c.token);
      if (needItems && !r.total) throw new Error("feed rỗng — chưa đủ bằng chứng");
      return { platform: c.platform, token: c.token, total: r.total, label: PLATFORMS[c.platform].label };
    } catch (e) {
      tried.push({ ...c, error: e.message });
      return null;
    }
  };

  for (const c of candidates) {
    const hit = await confirm(c, false);
    if (hit) return { ...hit, tried };
    await sleep(gapMs);
  }

  // Đoán slug: mỗi nền tảng một host riêng, nên chạy song song giữa nền tảng, tuần tự trong nền tảng.
  const seen = new Set(candidates.map(key));
  const groups = slugGuesses(slugCandidates(pageUrl, name), hints)
    .map((g) => g.filter((c) => !seen.has(key(c))));
  const results = await Promise.all(groups.map(async (g) => {
    for (let i = 0; i < g.length; i++) {
      if (i) await sleep(gapMs);
      const hit = await confirm(g[i], true);
      if (hit) return hit;
    }
    return null;
  }));
  const hit = results.find(Boolean);
  if (hit) return { ...hit, guessed: true, tried };

  return {
    platform: "manual",
    tried,
    error: candidates.length ? "có dấu vết nhưng feed không xác nhận được"
      : pageError || `không thấy dấu vết ATS, đoán slug cũng không ra${hints.size ? ` (trang nhắc tới: ${[...hints].join(", ")})` : ""}`,
  };
}

/* ---------------------------- CLI ---------------------------- */

async function main() {
  const arg = process.argv[2];
  if (arg) {
    const r = await detectAts(arg, { name: process.argv[3] ?? "" });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const { openDb } = await import("../core/db.js");
  const config = await import("../core/config.js");
  const db = openDb(path.join(process.env.DATA_DIR || path.join(ROOT, "data"), "jobs.db"));
  const todo = config.listCompanies(db).filter((c) => c.url && !c.ats);
  if (!todo.length) console.log("Không có công ty nào có link mà chưa dò.");
  for (const c of todo) {
    const r = await detectAts(c.url, { name: c.name });
    config.setCompanyAts(db, c.id, { platform: r.platform, token: r.token ?? null });
    console.log(`${c.name.padEnd(28)} ${r.platform === "manual" ? `manual  (${r.error})` : `${r.platform}:${r.token}  ${r.total} tin`}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  db.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
