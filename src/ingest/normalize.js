import { norm } from "../core/dedupe.js";

/* Gom các cách viết khác nhau của cùng một kênh về một tên. */
const SRC_ALIAS = [
  [/linkedin/i, "LinkedIn"],
  [/duunitori|duunivahti/i, "Duunitori"],
  [/oikotie/i, "Oikotie"],
  [/työmarkkinatori|tyomarkkinatori|te-palvelut|job market finland/i, "Työmarkkinatori"],
  [/thehub|the hub/i, "The Hub"],
  [/work ?in ?finland/i, "Work in Finland"],
  [/jobs ?in ?helsinki/i, "Jobs in Helsinki"],
  [/eurotech/i, "EuroTechJobs"],
  [/wellfound|angellist/i, "Wellfound"],
  [/startup\.jobs/i, "startup.jobs"],
  [/jobly/i, "Jobly"],
  [/engradar/i, "EngRadar"],
  [/talented|witted/i, "Talented"],
  [/toughbyte/i, "Toughbyte"],
  [/academic ?work/i, "Academic Work"],
  [/barona/i, "Barona"],
  [/glassdoor/i, "Glassdoor"],
  [/indeed/i, "Indeed"],
  [/greenhouse|lever|ashby|teamtailor|recruitee|workable|smartrecruiters|career|trang công ty/i, "Trang công ty"],
];

export function channelLabel(s) {
  const raw = String(s ?? "").trim();
  if (!raw) return "không rõ";
  for (const [re, name] of SRC_ALIAS) if (re.test(raw)) return name;
  return raw.length > 24 ? raw.slice(0, 24) : raw;
}

/* Tin dán tay: source key mang theo kênh, để PK (job_id, source) không nuốt mất kênh thứ hai. */
export function manualSource(raw) {
  const channel = channelLabel(raw);
  return { source: `manual:${norm(channel)}`, channel };
}

const clean = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
const LANGS = ["fi", "en", "sv"];

export function normalizeItem(raw) {
  return {
    title: clean(raw.title),
    company: clean(raw.company),
    location: clean(raw.location) || null,
    url: clean(raw.url) || null,
    adLanguage: LANGS.includes(raw.adLanguage) ? raw.adLanguage : "en",
    note: clean(raw.note) || null,
    description: raw.description ? String(raw.description) : null,
    postedAt: raw.postedAt || null,
  };
}
