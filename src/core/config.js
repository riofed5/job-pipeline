import crypto from "node:crypto";
import { now, localDate } from "./db.js";
import { norm } from "./dedupe.js";
import { FIELDS, ACTIONS } from "./rules.js";
import { SEED_COMPANIES } from "./seed.js";

/* Luật, công ty, nguồn, cài đặt.
   File này KHÔNG ghi vào jobs, sightings, events — việc đó chỉ core/jobs.js làm. */

const httpError = (status, message) => Object.assign(new Error(message), { status });

/* ---------------------------- luật ---------------------------- */

const toRule = (r) => ({
  id: r.id,
  label: r.label,
  field: r.field,
  match: r.match,
  action: r.action,
  enabled: Boolean(r.enabled),
  note: r.note ?? "",
  position: r.position,
  needsRerun: Boolean(r.needs_rerun),
});

export const listRules = (db) => db.prepare("SELECT * FROM rules ORDER BY position").all().map(toRule);

export function getRule(db, id) {
  const r = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  return r ? toRule(r) : null;
}

export function createRule(db) {
  const id = `r_${crypto.randomUUID().slice(0, 8)}`;
  const { p } = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rules").get();
  db.prepare(`INSERT INTO rules (id, label, field, match, action, enabled, note, created_at, position)
    VALUES (?, 'Luật mới', 'title', '', 'doubt', 0, '', ?, ?)`).run(id, now(), p);
  return getRule(db, id);
}

const RULE_EDITABLE = ["label", "field", "match", "action", "note"];
const RULE_BEHAVIOR = ["field", "match", "action"];

/* Bật/tắt KHÔNG đi qua đây — nó phải kèm hồi sinh, xem jobs.toggleRule. */
export function patchRule(db, id, patch) {
  const rule = getRule(db, id);
  if (!rule) throw httpError(404, "không có luật này");
  const keys = Object.keys(patch ?? {});
  const bad = keys.filter((k) => !RULE_EDITABLE.includes(k));
  if (bad.length) throw httpError(400, `không sửa được: ${bad.join(", ")}`);
  if ("field" in patch && !FIELDS.includes(patch.field)) throw httpError(400, "field không hợp lệ");
  if ("action" in patch && !ACTIONS.includes(patch.action)) throw httpError(400, "action không hợp lệ");

  // Luật đang bật mà đổi cách khớp thì tin cũ chưa phản ánh — nhắc chạy lại.
  const behaviorChanged = rule.enabled && RULE_BEHAVIOR.some((k) => k in patch && String(patch[k]) !== rule[k]);
  db.transaction(() => {
    for (const k of keys) db.prepare(`UPDATE rules SET ${k} = ? WHERE id = ?`).run(String(patch[k]), id);
    if (behaviorChanged) db.prepare("UPDATE rules SET needs_rerun = 1 WHERE id = ?").run(id);
  })();
  return getRule(db, id);
}

/* ---------------------------- cài đặt ---------------------------- */

export function getSettings(db) {
  const m = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]));
  return { startDate: m.start_date, lastSweep: m.last_sweep ?? null, maybeTTL: Number(m.maybe_ttl) || 21 };
}

export function markSweep(db) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('last_sweep', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(localDate());
  return getSettings(db);
}

/* ---------------------------- công ty ---------------------------- */

const TIERS = ["", "a", "b", "c", "consult"];

const toCompany = (c) => ({
  id: c.id,
  name: c.name,
  tier: c.tier,
  url: c.careers_url ?? "",
  note: c.note ?? "",
  ats: c.ats,
  lastPull: c.last_pull,
});

export const listCompanies = (db) => db.prepare("SELECT * FROM companies ORDER BY name").all().map(toCompany);

const insertCompany = (db, name, tier) =>
  db.prepare("INSERT INTO companies (id, name, tier) VALUES (?, ?, ?)").run(crypto.randomUUID(), name, tier);

export function addCompany(db, { name, tier = "" } = {}) {
  const clean = String(name ?? "").trim();
  if (!clean) throw httpError(400, "thiếu tên công ty");
  if (!TIERS.includes(tier)) throw httpError(400, "hạng không hợp lệ");
  const existing = listCompanies(db).find((c) => norm(c.name) === norm(clean));
  if (existing) return { company: existing, existed: true };
  insertCompany(db, clean, tier);
  return { company: listCompanies(db).find((c) => c.name === clean), existed: false };
}

export function patchCompany(db, id, patch = {}) {
  const cols = { tier: "tier", url: "careers_url", note: "note" };
  const bad = Object.keys(patch).filter((k) => !(k in cols));
  if (bad.length) throw httpError(400, `không sửa được: ${bad.join(", ")}`);
  if ("tier" in patch && !TIERS.includes(patch.tier)) throw httpError(400, "hạng không hợp lệ");
  if (!db.prepare("SELECT 1 FROM companies WHERE id = ?").get(id)) throw httpError(404, "không có công ty này");
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE companies SET ${cols[k]} = ? WHERE id = ?`).run(String(v), id);
  })();
  return toCompany(db.prepare("SELECT * FROM companies WHERE id = ?").get(id));
}

export function seedCompanies(db) {
  const have = new Set(listCompanies(db).map((c) => norm(c.name)));
  const missing = SEED_COMPANIES.filter(([n]) => !have.has(norm(n)));
  db.transaction(() => {
    for (const [n, t] of missing) insertCompany(db, n, t);
  })();
  return { added: missing.length };
}

/* ---------------------------- nguồn ---------------------------- */

const toSource = (s) => ({ id: s.id, name: s.name, kind: s.kind, url: s.url, alert: Boolean(s.alert_on), lastPull: s.last_pull });

export const listSources = (db) => db.prepare("SELECT * FROM sources ORDER BY rowid").all().map(toSource);

export function patchSource(db, id, { alert } = {}) {
  if (typeof alert !== "boolean") throw httpError(400, "alert phải là true/false");
  const r = db.prepare("UPDATE sources SET alert_on = ? WHERE id = ?").run(alert ? 1 : 0, id);
  if (!r.changes) throw httpError(404, "không có nguồn này");
  return toSource(db.prepare("SELECT * FROM sources WHERE id = ?").get(id));
}
