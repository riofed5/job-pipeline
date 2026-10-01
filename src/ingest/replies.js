/* Bước 3b — phản hồi của công ty cho hồ sơ đã nộp.

   Với mỗi công ty có tin ở Đã nộp / Phỏng vấn: IMAP SEARCH toàn hộp thư ([Gmail]/All Mail, đổi bằng
   IMAP_REPLIES_MAILBOX; không có thì INBOX) SINCE ngày nộp sớm nhất, TEXT tên công ty và tên khác
   (companies.aliases). Không dùng nhãn, không lọc người gửi — Claude lo phần phân biệt mail thật với mail
   nhắc tên công ty (alert, newsletter). Chỉ ĐỌC hộp thư: không cờ, không xóa, không chuyển.

   Một lần gọi Claude mỗi công ty: hồ sơ (title, ngày nộp) + mail (subject, from, date, text) → với mỗi hồ sơ
   {status, evidence_message_id, note}. Kết quả ghi bảng replies — là ĐỀ XUẤT. File này không đụng jobs;
   tin chỉ đổi khi người bấm Xác nhận ở tab Phản hồi (jobs.confirmReply). Đầu vào không đổi (hash) thì không gọi. */

import * as R from "../core/replies.js";
import { imapConfig, imapConfigured, mailKey } from "./imap.js";
import { htmlToText } from "./html.js";

const DEFAULT_MAILBOX = "[Gmail]/All Mail";
const MAX_MAILS = 60;      // mail mới nhất giữ lại mỗi công ty cho một lần gọi
const MAX_CHARS = 4000;    // mỗi mail; thư trả lời ứng viên ngắn, phần dài là chữ ký và trích dẫn
const DEFAULT_MODEL = "claude-opus-5";

export function repliesConfig(env = process.env) {
  return { ...imapConfig(env), mailbox: env.IMAP_REPLIES_MAILBOX || DEFAULT_MAILBOX };
}
export const repliesConfigured = (env = process.env) => imapConfigured(env);

/* Câu SEARCH cho một công ty: SINCE ngày nộp sớm nhất, TEXT tên (OR tên khác). */
export function searchQuery({ since, terms }) {
  const list = [...new Set(terms.map((t) => String(t ?? "").trim()).filter(Boolean))];
  const q = { since: new Date(since) };
  if (list.length === 1) q.text = list[0];
  else q.or = list.map((t) => ({ text: t }));
  return q;
}

/* Tìm và tải mail của một công ty, bỏ mail đã lưu (skip). Hai lượt: envelope rồi source, như imap.js. */
export async function fetchCompanyMails(client, { since, terms, skip = () => false, max = MAX_MAILS }) {
  const { simpleParser } = await import("mailparser");
  const q = searchQuery({ since, terms });
  const uids = (await client.search(q, { uid: true })) || [];
  const newest = uids.slice(-max);
  const out = [];
  if (!newest.length) return { mails: out, found: uids.length, capped: uids.length > max };
  const fresh = [];
  for await (const m of client.fetch(newest, { uid: true, envelope: true }, { uid: true })) {
    const env = m.envelope ?? {};
    const key = mailKey({ messageId: env.messageId, from: env.from?.[0]?.address, date: env.date, subject: env.subject });
    if (!skip(key)) fresh.push({ uid: m.uid, key });
  }
  for (const f of fresh) {
    const m = await client.fetchOne(f.uid, { source: true }, { uid: true });
    const parsed = await simpleParser(m.source);
    const body = parsed.html ? htmlToText(parsed.html) : String(parsed.text ?? "");
    out.push({
      messageId: f.key,
      from: [parsed.from?.value?.[0]?.name, parsed.from?.value?.[0]?.address].filter(Boolean).join(" ") || "",
      subject: parsed.subject ?? "",
      date: parsed.date ?? null,
      text: body.slice(0, MAX_CHARS),
    });
  }
  return { mails: out, found: uids.length, capped: uids.length > max };
}

/* ---------------------------- Claude ---------------------------- */

const SYSTEM = `You track the status of job applications by reading a candidate's mailbox.
You get one company: the applications the candidate sent there (id, title, applied date, current stage) and every email in the mailbox that mentions the company name since the earliest application. Most of these emails are noise: job alerts from boards that merely list the company, newsletters, unrelated threads. Only emails actually sent by or on behalf of the company about one of these applications count.
For EVERY application return exactly one result:
- no_reply: nothing from the company about this application.
- ack: automatic confirmation that the application was received.
- rejection: the company declined this application.
- interview: invitation to a call, interview or meeting.
- assessment: take-home task, coding test or similar assignment.
- other: a real message about this application that fits none of the above (request for information, delay notice, offer).
Pick the LATEST relevant stage. evidence_message_id must be the message_id of the email you based the result on, exactly as given, or "" for no_reply. If one email covers several applications, use it for each. If an email is about the company but you cannot tell which application, prefer the application whose title it mentions; otherwise the most recent one. note: one short sentence, quoting the key phrase. Never invent emails.`;

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          job_id: { type: "string" },
          status: { type: "string", enum: R.REPLY_STATUSES },
          evidence_message_id: { type: "string" },
          note: { type: "string" },
        },
        required: ["job_id", "status", "evidence_message_id", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

export function buildRepliesRequest({ company, applications, mails }, model) {
  const input = {
    company,
    applications: applications.map((a) => ({ id: a.id, title: a.title, applied_at: a.appliedAt, stage: a.outcome ?? "applied" })),
    emails: mails.map((m) => ({ message_id: m.messageId, from: m.from, subject: m.subject, date: m.date, text: m.text })),
  };
  return {
    model,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: JSON.stringify(input) }],
  };
}

export function parseRepliesJson(out) {
  const s = String(out ?? "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) throw new Error("Claude không trả JSON");
  const parsed = JSON.parse(s.slice(a, b + 1));
  if (!Array.isArray(parsed.results)) throw new Error("Claude không trả mảng results");
  return parsed.results;
}

/* Gọi Claude cho một công ty. Kết quả đã lọc: job_id phải là hồ sơ đã gửi, evidence phải là mail đã gửi
   (không thì về null), mỗi hồ sơ lấy kết quả đầu tiên. */
export async function assessReplies({ company, applications, mails }, { apiKey, model = DEFAULT_MODEL, fetchFn = fetch } = {}) {
  if (!apiKey) throw new Error("thiếu ANTHROPIC_API_KEY");
  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(buildRepliesRequest({ company, applications, mails }, model)),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}: ${data.error?.message ?? ""}`.trim());
  if (data.stop_reason === "refusal") throw new Error("Claude từ chối");
  if (data.stop_reason === "max_tokens") throw new Error("Claude bị cắt giữa chừng (max_tokens)");
  const out = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const ids = new Set(applications.map((a) => a.id));
  const known = new Set(mails.map((m) => m.messageId));
  const seen = new Set();
  const results = [];
  for (const r of parseRepliesJson(out)) {
    const jobId = String(r.job_id ?? "");
    if (!ids.has(jobId) || seen.has(jobId) || !R.REPLY_STATUSES.includes(r.status)) continue;
    seen.add(jobId);
    const ev = String(r.evidence_message_id ?? "").trim();
    results.push({ jobId, status: r.status, evidence: known.has(ev) ? ev : null, note: String(r.note ?? "").trim() });
  }
  return results;
}

/* ---------------------------- bước cho pull.js ---------------------------- */

/* Mở hộp thư; không có folder All Mail (không phải Gmail) thì INBOX. */
async function openMailbox(client, mailbox) {
  try { return { lock: await client.getMailboxLock(mailbox), mailbox }; } catch { /* thử INBOX */ }
  return { lock: await client.getMailboxLock("INBOX"), mailbox: "INBOX" };
}

export function createRepliesStep({ env = process.env, makeClient, assess = assessReplies, fetchMails = fetchCompanyMails } = {}) {
  const step = async (db) => {
    const cfg = repliesConfig(env);
    const r = { kind: "replies", name: "Phản hồi", companies: 0, mails: 0, calls: 0, proposals: 0, added: 0, auto: 0, dup: 0, error: null, note: null };
    const groups = R.trackedApplications(db);
    if (!groups.length) return [r];
    const { ImapFlow } = makeClient ? {} : await import("imapflow");
    const client = makeClient ? makeClient() : new ImapFlow({ host: cfg.host, port: 993, secure: true, auth: { user: cfg.user, pass: cfg.password }, logger: false });
    const errors = [];
    const notes = [];
    await client.connect();
    const { lock } = await openMailbox(client, cfg.mailbox);
    try {
      for (const g of groups) {
        r.companies++;
        try {
          const terms = [g.name, ...R.aliasesFor(db, g.name)];
          const since = g.since ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
          const got = await fetchMails(client, { since, terms, skip: (key) => R.mailStored(db, key, g.key) });
          for (const m of got.mails) R.storeMail(db, g.key, m);
          r.mails += got.mails.length;
          if (got.capped) notes.push(`${g.name}: hơn ${MAX_MAILS} mail khớp tên, chỉ xem ${MAX_MAILS} mail mới nhất`);
          const mails = R.listMails(db, g.key);
          const hash = R.inputHash(g.applications, mails);
          if (R.lastRun(db, g.key)?.input_hash === hash) continue; // không có gì mới → không gọi Claude
          const results = await assess({ company: g.name, applications: g.applications, mails }, cfg);
          r.calls++;
          let proposals = 0;
          db.transaction(() => {
            for (const x of results) {
              if (R.hasProposal(db, x.jobId, x.status, x.evidence)) continue;
              R.addProposal(db, g.key, x);
              if (x.status !== "no_reply") proposals++;
            }
            R.markRun(db, g.key, { hash, mails: mails.length, proposals });
          })();
          r.proposals += proposals;
        } catch (e) {
          errors.push(`${g.name}: ${e.message}`);
        }
      }
    } finally {
      lock.release();
      await client.logout();
    }
    if (errors.length) r.error = errors.join(" · ");
    if (notes.length) r.note = notes.join(" · ");
    return [r];
  };
  step.kind = "replies";
  step.label = "Phản hồi";
  return step;
}
