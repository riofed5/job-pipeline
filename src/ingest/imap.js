/* Tầng 3 — email alert qua IMAP. Board không có API thì để nó gửi mail; đây đọc mail đó.

   Chỉ ĐỌC hộp thư: không đổi cờ, không xóa, không dọn hộp thư. Bộ nhớ "đã xử lý" là bảng mail_seen
   (Message-ID, hoặc hash(from+date+subject) khi thiếu). Cửa sổ luôn là 14 ngày; mail_seen lo phần
   bỏ qua, nên mail tồn không bao giờ bị bỏ sót vì last_pull.

   Parse: không viết regex cho từng board. Lấy HTML (ưu tiên hơn text/plain vì link đầy đủ nằm trong
   href), đổi <a href=X>Y</a> thành "Y (X)", rồi đưa cho Claude trả JSON. Claude chỉ trích xuất;
   trạng thái tin do luật và người quyết, như mọi đường nạp khác.

   Biến môi trường: IMAP_USER, IMAP_APP_PASSWORD, IMAP_LABEL (mặc định jobalerts), IMAP_HOST
   (mặc định imap.gmail.com), ANTHROPIC_API_KEY, CLAUDE_MODEL (mặc định claude-opus-5). */

import crypto from "node:crypto";
import * as jobs from "../core/jobs.js";
import * as config from "../core/config.js";
import { norm } from "../core/dedupe.js";
import { channelLabel } from "./normalize.js";
import { htmlToText } from "./html.js";
import { guessLanguage } from "./ats.js";

const WINDOW_DAYS = 14;
const MAX_CHARS = 60_000;       // một mail alert dài nhất cũng dưới mức này; quá thì ghi truncated
const DEFAULT_MODEL = "claude-opus-5";

export function imapConfig(env = process.env) {
  return {
    host: env.IMAP_HOST || "imap.gmail.com",
    user: env.IMAP_USER || "",
    password: env.IMAP_APP_PASSWORD || "",
    label: env.IMAP_LABEL || "jobalerts",
    apiKey: env.ANTHROPIC_API_KEY || "",
    model: env.CLAUDE_MODEL || DEFAULT_MODEL,
  };
}

export const imapConfigured = (env = process.env) => {
  const c = imapConfig(env);
  return Boolean(c.user && c.password && c.apiKey);
};

/* Khóa duy nhất của một mail. Message-ID thiếu (hiếm) thì hash from + date + subject. */
export function mailKey({ messageId, from, date, subject }) {
  const id = String(messageId ?? "").trim();
  if (id) return id;
  const h = crypto.createHash("sha1").update(`${from ?? ""}|${date ?? ""}|${subject ?? ""}`).digest("hex");
  return `hash:${h}`;
}

/* Chữ đưa cho Claude. HTML trước, text sau. */
export function mailText({ html, text }) {
  const body = html ? htmlToText(html, { keepLinks: true }) : String(text ?? "");
  return { text: body.slice(0, MAX_CHARS), truncated: body.length > MAX_CHARS };
}

/* ---------------------------- Claude ---------------------------- */

const SYSTEM = `You extract job postings from job-alert emails sent by job boards (LinkedIn, Duunitori, Oikotie, The Hub, Jobly, EngRadar, ...).
The email text is given as plain text; links appear as "anchor text (https://url)".
Return every job posting that appears in the email. For each: the job title, the employer/company name, the location as written, and the URL of the link that leads to that posting (a tracking link is fine; keep it exactly as written).
Do not invent postings. Skip navigation, unsubscribe links, ads for the board itself, and "similar jobs" that have no title. If a field is unknown, use an empty string.
adLanguage: "fi" if the posting's title or its text in the email is written in Finnish, otherwise "en".`;

const SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          company: { type: "string" },
          location: { type: "string" },
          url: { type: "string" },
          adLanguage: { type: "string", enum: ["fi", "en"] },
        },
        required: ["title", "company", "location", "url", "adLanguage"],
        additionalProperties: false,
      },
    },
  },
  required: ["jobs"],
  additionalProperties: false,
};

/* Lấy object JSON đầu tiên trong câu trả lời: schema đã ép, nhưng vẫn chịu được chữ thừa nếu có. */
export function parseJobsJson(out) {
  const s = String(out ?? "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) throw new Error("Claude không trả JSON");
  const parsed = JSON.parse(s.slice(a, b + 1));
  if (!Array.isArray(parsed.jobs)) throw new Error("Claude không trả mảng jobs");
  return parsed.jobs;
}

/* Không có effort: tách JSON từ một mail không cần nó ở model nào. */
export function buildRequest(text, model) {
  return {
    model,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: text }],
  };
}

export async function extractJobs(text, { apiKey, model = DEFAULT_MODEL, fetchFn = fetch } = {}) {
  if (!apiKey) throw new Error("thiếu ANTHROPIC_API_KEY");
  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(buildRequest(text, model)),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}: ${data.error?.message ?? ""}`.trim());
  if (data.stop_reason === "refusal") throw new Error("Claude từ chối mail này");
  if (data.stop_reason === "max_tokens") throw new Error("Claude bị cắt giữa chừng (max_tokens)");
  const out = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return parseJobsJson(out).map((j) => ({
    title: String(j.title ?? "").trim(),
    company: String(j.company ?? "").trim(),
    location: String(j.location ?? "").trim() || null,
    url: String(j.url ?? "").trim() || null,
    adLanguage: j.adLanguage === "fi" ? "fi" : "en",
  })).filter((j) => j.title && j.company);
}

/* ---------------------------- IMAP ---------------------------- */

/* Đọc mail trong cửa sổ 14 ngày, bỏ mail skip(key) bảo bỏ. Hai lượt: envelope cho mọi mail (rẻ),
   source chỉ cho mail mới. Không đụng cờ. Tiêm client để kiểm không cần mạng. */
export async function fetchAlertMails({ host, user, password, label, skip = () => false, makeClient } = {}) {
  const { ImapFlow } = makeClient ? {} : await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = makeClient ? makeClient() : new ImapFlow({ host, port: 993, secure: true, auth: { user, pass: password }, logger: false });
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const out = [];
  let scanned = 0;
  await client.connect();
  const lock = await client.getMailboxLock(label);
  try {
    const fresh = [];
    for await (const m of client.fetch({ since }, { uid: true, envelope: true })) {
      scanned++;
      const env = m.envelope ?? {};
      const key = mailKey({ messageId: env.messageId, from: env.from?.[0]?.address, date: env.date, subject: env.subject });
      if (skip(key)) continue;
      fresh.push({ uid: m.uid, key }); // không có trần: mọi mail mới trong 14 ngày đều được xử lý lần này
    }
    for (const f of fresh) {
      const m = await client.fetchOne(f.uid, { source: true }, { uid: true });
      const parsed = await simpleParser(m.source);
      const from = parsed.from?.value?.[0] ?? {};
      const { text, truncated } = mailText({ html: parsed.html, text: parsed.text });
      out.push({ key: f.key, from: from.address ?? "", fromName: from.name ?? "", subject: parsed.subject ?? "", date: parsed.date ?? null, text, truncated });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return { mails: out, scanned };
}

/* Kênh từ người gửi: "jobs-noreply@linkedin.com" → LinkedIn. Tên hiển thị trước, rồi domain. */
export function mailChannel({ from, fromName }) {
  const byName = channelLabel(fromName);
  if (byName !== "không rõ" && byName !== String(fromName ?? "").trim()) return byName;
  const domain = String(from ?? "").split("@")[1] ?? "";
  const byDomain = channelLabel(domain);
  return byDomain !== "không rõ" && byDomain !== domain ? byDomain : byName !== "không rõ" ? byName : domain || "không rõ";
}

/* Tìm dòng trong bảng sources cho một kênh: "LinkedIn Jobs" ↔ "LinkedIn". */
export function sourceFor(sources, channel) {
  const c = norm(channel);
  return sources.find((s) => norm(s.name) === c) || sources.find((s) => norm(s.name).startsWith(c) || c.startsWith(norm(s.name)));
}

/* Bước cho pull.js: async (db) → mảng kết quả, một dòng mỗi kênh. */
export function createImapStep({ env = process.env, fetchMails = fetchAlertMails, extract = extractJobs } = {}) {
  const step = async (db) => {
    const cfg = imapConfig(env);
    const { mails, scanned } = await fetchMails({ ...cfg, skip: (key) => config.mailSeen(db, key) });
    const perChannel = new Map();
    const row = (channel) => {
      if (!perChannel.has(channel)) perChannel.set(channel, { kind: "imap", name: channel, mails: 0, added: 0, auto: 0, dup: 0, skipped: 0, error: null });
      return perChannel.get(channel);
    };
    for (const mail of mails) {
      const channel = mailChannel(mail);
      const r = row(channel);
      const source = `imap:${norm(channel)}`;
      try {
        // Claude đọc cả nội dung tin trong mail nên biết ngôn ngữ; tiêu đề có ä/ö vẫn là lưới đỡ.
        const items = (await extract(mail.text, cfg)).map((it) => ({ ...it, adLanguage: it.adLanguage === "fi" || guessLanguage(it.title, "") === "fi" ? "fi" : "en" }));
        const counts = jobs.ingest(db, items, { source, channel });
        config.markMailSeen(db, mail.key, source, items.length);
        r.mails++;
        r.added += counts.added; r.auto += counts.auto; r.dup += counts.dup; r.skipped += counts.skipped;
        if (mail.truncated) r.error = "một mail dài quá 60k ký tự đã bị cắt";
      } catch (e) {
        // Không đánh dấu đã xử lý: lần sau thử lại.
        r.error = e.message;
      }
    }
    // Mọi nguồn đã bật alert đều "được kéo" lần này, kể cả không có mail — để phát hiện nguồn chết.
    const sources = config.listSources(db);
    const touched = new Set();
    for (const r of perChannel.values()) {
      const s = sourceFor(sources, r.name);
      if (!s) continue;
      touched.add(s.id);
      config.markSourcePull(db, s.id, { added: r.added, count: r.added + r.dup, error: r.error });
    }
    for (const s of sources) if (s.alert && !touched.has(s.id)) config.markSourcePull(db, s.id, { added: 0, count: 0 });
    const results = [...perChannel.values()];
    if (!results.length) results.push({ kind: "imap", name: "Email alert", mails: 0, scanned, added: 0, auto: 0, dup: 0, error: null });
    return results;
  };
  step.kind = "imap";
  step.label = "Email alert";
  return step;
}
