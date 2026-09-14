/* Engine luật. Thuần — không đụng DB. */

export const FIELDS = ["title", "company", "lang", "any"];
export const ACTIONS = ["kill", "doubt"];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const prep = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

/* Ranh giới từ hiểu Unicode. \b của JS coi ä/ö là ranh giới nên không dùng được. */
const EDGE_L = "(?<![\\p{L}\\p{N}])";
const EDGE_R = "(?![\\p{L}\\p{N}])";

/* Khớp nguyên từ. '*' ở đầu/cuối bỏ ranh giới phía đó: myynti*, *kehittäjä, *kehittäjä*. */
export function compileTerm(raw) {
  const t = prep(raw);
  const open = t.startsWith("*");
  const close = t.endsWith("*");
  const body = t.replace(/^\*+|\*+$/g, "").trim();
  if (!body) return null;
  return new RegExp(`${open ? "" : EDGE_L}${esc(body)}${close ? "" : EDGE_R}`, "iu");
}

export function compileRules(rules) {
  return rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ ...r, terms: String(r.match ?? "").split(",").map(compileTerm).filter(Boolean) }))
    .filter((r) => r.terms.length);
}

function haystack(job, field) {
  if (field === "title") return job.title;
  if (field === "company") return job.company;
  if (field === "lang") return job.adLanguage;
  if (field === "any") return [job.title, job.company, job.location, job.note].filter(Boolean).join(" ");
  return "";
}

/* Luật kill đầu tiên khớp thắng ngay; không có thì lấy luật doubt đầu tiên. */
export function evaluate(job, compiled) {
  let doubt = null;
  for (const r of compiled) {
    const hay = prep(haystack(job, r.field));
    if (!hay || !r.terms.some((re) => re.test(hay))) continue;
    if (r.action === "kill") return r;
    doubt ??= r;
  }
  return doubt;
}
