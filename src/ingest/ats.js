/* Tầng 1 — ATS API. Mỗi nền tảng: endpoint + parse thuần (kiểm được bằng fixture).
   fetchAts() là hàm duy nhất chạm mạng: User-Agent nói rõ là công cụ cá nhân, timeout 10 giây,
   ETag để trả 304 khi feed không đổi. Rate limit giữa các công ty nằm ở pull.js.
   Item trả về CHƯA có company — pull.js gắn tên trong bảng companies để fingerprint ổn định. */

import { htmlToText, decodeEntities } from "./html.js";

export const USER_AGENT = "job-pipeline/0.1 (personal job-search tool; one user; contact via careers page)";
const TIMEOUT_MS = 10_000;

const str = (v) => (v == null ? "" : String(v)).trim();
const iso = (v) => {
  if (!v) return null;
  const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const text = (html) => (html ? htmlToText(html) : null);
const joinLoc = (...parts) => parts.map(str).filter(Boolean).join(", ") || null;

/* Tách một tag XML/RSS đơn giản. Đủ cho Personio và Teamtailor; không dùng cho HTML. */
function xmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function xmlField(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  const inner = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return decodeEntities(inner).trim();
}

export const PLATFORMS = {
  greenhouse: {
    label: "Greenhouse",
    endpoint: (token) => `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
    parse: (body) => {
      const data = JSON.parse(body);
      if (!Array.isArray(data.jobs)) throw new Error("không có mảng jobs");
      return data.jobs.map((j) => ({
        title: str(j.title),
        location: str(j.location?.name) || null,
        url: str(j.absolute_url) || null,
        postedAt: iso(j.first_published || j.updated_at),
        // content=true trả HTML đã escape một lần.
        description: text(decodeEntities(j.content ?? "")),
        externalId: str(j.id),
      }));
    },
  },
  lever: {
    label: "Lever",
    // token "eu:acme" → vùng EU.
    endpoint: (token) => {
      const eu = token.startsWith("eu:");
      return `https://api.${eu ? "eu." : ""}lever.co/v0/postings/${eu ? token.slice(3) : token}?mode=json`;
    },
    parse: (body) => {
      const data = JSON.parse(body);
      if (!Array.isArray(data)) throw new Error("không phải mảng");
      return data.map((j) => ({
        title: str(j.text),
        location: joinLoc(j.categories?.location, j.categories?.allLocations?.join?.(", ")),
        url: str(j.hostedUrl) || null,
        postedAt: iso(j.createdAt),
        description: str(j.descriptionPlain) || text(j.description),
        externalId: str(j.id),
      }));
    },
  },
  ashby: {
    label: "Ashby",
    endpoint: (token) => `https://api.ashbyhq.com/posting-api/job-board/${token}`,
    parse: (body) => {
      const data = JSON.parse(body);
      if (!Array.isArray(data.jobs)) throw new Error("không có mảng jobs");
      return data.jobs.map((j) => ({
        title: str(j.title),
        location: joinLoc(j.location, ...(j.secondaryLocations ?? []).map((l) => l?.location), j.isRemote ? "Remote" : ""),
        url: str(j.jobUrl) || null,
        postedAt: iso(j.publishedAt),
        description: str(j.descriptionPlain) || text(j.descriptionHtml),
        externalId: str(j.id),
      }));
    },
  },
  recruitee: {
    label: "Recruitee",
    endpoint: (token) => `https://${token}.recruitee.com/api/offers/`,
    parse: (body) => {
      const data = JSON.parse(body);
      if (!Array.isArray(data.offers)) throw new Error("không có mảng offers");
      return data.offers.map((j) => ({
        title: str(j.title),
        location: str(j.location) || joinLoc(j.city, j.country) || (j.remote ? "Remote" : null),
        url: str(j.careers_url) || null,
        postedAt: iso(j.published_at || j.created_at),
        description: text([j.description, j.requirements].filter(Boolean).join("\n")),
        externalId: str(j.id),
      }));
    },
  },
  smartrecruiters: {
    label: "SmartRecruiters",
    endpoint: (token) => `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`,
    parse: (body, token) => {
      const data = JSON.parse(body);
      if (!Array.isArray(data.content)) throw new Error("không có mảng content");
      // Mô tả cần gọi từng tin — không làm ở bước này.
      return data.content.map((j) => ({
        title: str(j.name),
        location: joinLoc(j.location?.city, j.location?.country, j.location?.remote ? "Remote" : ""),
        url: `https://jobs.smartrecruiters.com/${token}/${str(j.id)}`,
        postedAt: iso(j.releasedDate),
        description: null,
        externalId: str(j.id),
      }));
    },
  },
  workable: {
    label: "Workable",
    endpoint: (token) => `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`,
    parse: (body) => {
      const data = JSON.parse(body);
      if (!Array.isArray(data.jobs)) throw new Error("không có mảng jobs");
      return data.jobs.map((j) => ({
        title: str(j.title),
        location: joinLoc(j.city, j.state, j.country, j.telecommuting ? "Remote" : ""),
        url: str(j.url) || str(j.application_url) || null,
        postedAt: iso(j.published_on),
        description: text([j.description, j.requirements].filter(Boolean).join("\n")),
        externalId: str(j.shortcode),
      }));
    },
  },
  personio: {
    label: "Personio",
    endpoint: (token) => `https://${token}.jobs.personio.de/xml`,
    parse: (body, token) => {
      if (!/<workzag-jobs|<position>/i.test(body)) throw new Error("không phải feed Personio");
      return xmlBlocks(body, "position").map((p) => ({
        title: xmlField(p, "name"),
        location: xmlField(p, "office") || null,
        url: `https://${token}.jobs.personio.de/job/${xmlField(p, "id")}`,
        postedAt: iso(xmlField(p, "createdAt")),
        description: text(xmlBlocks(p, "jobDescription").map((d) => xmlField(d, "value")).join("\n")) || null,
        externalId: xmlField(p, "id"),
      }));
    },
  },
  teamtailor: {
    label: "Teamtailor",
    // token = origin của trang career, vì Teamtailor thường chạy trên domain riêng.
    endpoint: (token) => `${token.replace(/\/$/, "")}/jobs.rss`,
    parse: (body) => {
      if (!/<rss|<channel/i.test(body)) throw new Error("không phải RSS");
      return xmlBlocks(body, "item").map((it) => ({
        title: xmlField(it, "title"),
        location: xmlField(it, "location") || xmlField(it, "tt:location") || null,
        url: xmlField(it, "link") || null,
        postedAt: iso(xmlField(it, "pubDate")),
        description: text(xmlField(it, "description")) || null,
        externalId: xmlField(it, "guid") || xmlField(it, "link"),
      }));
    },
  },
};

export const isPlatform = (p) => Object.prototype.hasOwnProperty.call(PLATFORMS, p);

export function parseFeed(platform, body, token) {
  if (!isPlatform(platform)) throw new Error(`nền tảng không rõ: ${platform}`);
  return PLATFORMS[platform].parse(body, token).filter((j) => j.title);
}

/* ---------------------------- lọc địa điểm ----------------------------
   Chỗ DUY NHẤT vứt tin trước khi vào DB. Vì thế pull ghi lại tổng/giữ/ngoài phạm vi để nhìn thấy được.
   Không phân biệt hoa thường; "Helsinki, Stockholm, Berlin" giữ vì một thành phố khớp; trống thì giữ. */

export const parseLocations = (s) => String(s ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

export function locationOk(location, locations) {
  const loc = str(location).toLowerCase();
  if (!loc || !locations.length) return true;
  return locations.some((l) => loc.includes(l));
}

export function filterLocation(items, locationList) {
  const locations = parseLocations(locationList);
  const kept = [];
  const dropped = [];
  for (const it of items) (locationOk(it.location, locations) ? kept : dropped).push(it);
  return { kept, dropped };
}

/* ---------------------------- ngôn ngữ tin ----------------------------
   Cùng tinh thần với dán tay (/[äöå]/), thêm vài từ chức năng để JD không dấu vẫn nhận ra. */
const FI_WORDS = /\b(ja|tai|sekä|meillä|meille|haemme|hakemus|kokemus|kokemusta|osaaminen|tehtävä|tehtävässä|työ|työtä|tiimi|tiimiin|olet|sinulla|sinä|etsimme|kehittäjä|kehittäjää|suunnittelija)\b/gi;

export function guessLanguage(title, description) {
  if (/[äöå]/i.test(str(title))) return "fi";
  const sample = str(description).slice(0, 1500);
  if (!sample) return "en";
  const hits = (sample.match(FI_WORDS) ?? []).length;
  return hits >= 4 ? "fi" : "en";
}

/* ---------------------------- mạng ---------------------------- */

export async function httpGet(url, { etag = null, accept = "application/json, application/xml, text/html;q=0.8, */*;q=0.5" } = {}) {
  const headers = { "User-Agent": USER_AGENT, Accept: accept };
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = res.status === 304 ? "" : await res.text();
  return { status: res.status, body, etag: res.headers.get("etag"), url: res.url };
}

/* → { items, total, etag } hoặc { notModified: true, etag }. Ném lỗi khi HTTP lỗi hoặc body không parse được. */
export async function fetchAts(platform, token, { etag = null, get = httpGet } = {}) {
  if (!isPlatform(platform)) throw new Error(`nền tảng không rõ: ${platform}`);
  const url = PLATFORMS[platform].endpoint(token);
  const res = await get(url, { etag });
  if (res.status === 304) return { notModified: true, etag };
  if (res.status !== 200) throw new Error(`HTTP ${res.status} từ ${url}`);
  const items = parseFeed(platform, res.body, token).map((it) => ({ ...it, adLanguage: guessLanguage(it.title, it.description) }));
  return { items, total: items.length, etag: res.etag ?? null };
}
