/* Lớp gọi REST, thay cho window.storage của bản artifact.
   Mọi lời gọi đi tuần tự: phím U bấm ngay sau phím 1 không được chạy trước quyết định vừa bấm,
   và lần tải lại không được đọc trước khi lệnh ghi xong. */

let queue = Promise.resolve();

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function send(method, url, body) {
  const run = () => call(method, url, body);
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

export const api = {
  jobs: () => send("GET", "/api/jobs"),
  rules: () => send("GET", "/api/rules"),
  companies: () => send("GET", "/api/companies"),
  sources: () => send("GET", "/api/sources"),
  settings: () => send("GET", "/api/settings"),
  exportAll: () => send("GET", "/api/export"),

  ingest: (source, items) => send("POST", "/api/ingest", { source, items }),
  decide: (id, status) => send("POST", `/api/jobs/${encodeURIComponent(id)}/status`, { status }),
  undo: () => send("POST", "/api/undo"),
  archiveStale: () => send("POST", "/api/archive-stale"),

  createRule: () => send("POST", "/api/rules"),
  patchRule: (id, patch) => send("PATCH", `/api/rules/${encodeURIComponent(id)}`, patch),
  toggleRule: (id) => send("POST", `/api/rules/${encodeURIComponent(id)}/toggle`),
  rerun: () => send("POST", "/api/rules/rerun"),

  addCompany: (name, tier) => send("POST", "/api/companies", { name, tier }),
  seedCompanies: () => send("POST", "/api/companies/seed"),
  patchCompany: (id, patch) => send("PATCH", `/api/companies/${encodeURIComponent(id)}`, patch),
  patchSource: (id, patch) => send("PATCH", `/api/sources/${encodeURIComponent(id)}`, patch),
  sweep: () => send("POST", "/api/sweep"),
};
