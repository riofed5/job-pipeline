import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";

/* ============================================================
   Bàn phân loại — job pipeline
   Nguyên tắc: không có gì bị xóa. Loại = ẩn, không phải mất.
   ============================================================ */

const K_JOBS = "jobhunt:jobs";
const K_CONF = "jobhunt:config";

const BINS = [
  { id: "new", label: "Hộp đến", hint: "chờ phân loại" },
  { id: "queue", label: "Hàng đọc", hint: "chắc chắn liên quan" },
  { id: "maybe", label: "Có thể", hint: "rà soát định kỳ" },
  { id: "doubt", label: "Ngờ vực", hint: "loại nhưng chưa chắc" },
  { id: "applied", label: "Đã nộp", hint: "" },
  { id: "killed", label: "Đã loại", hint: "" },
  { id: "archived", label: "Lưu trữ", hint: "quá hạn" },
];

const DEFAULT_RULES = [
  {
    id: "r_lang",
    label: "Tin đăng tiếng Phần Lan",
    field: "lang",
    match: "fi",
    action: "doubt",
    enabled: true,
    note: "Ngôn ngữ tin đăng thường phản ánh ngôn ngữ làm việc. Để Ngờ vực vì có công ty đăng song ngữ.",
  },
  {
    id: "r_senior_hard",
    label: "Vượt tầm kinh nghiệm",
    field: "title",
    match: "lead, principal, head of, director, staff engineer, architect, vp of, chief, manager",
    action: "kill",
    enabled: true,
    note: "3.5 năm không với tới. Tắt rule này nếu muốn xem lại toàn bộ.",
  },
  {
    id: "r_senior_soft",
    label: "Senior — sát ngưỡng",
    field: "title",
    match: "senior",
    action: "doubt",
    enabled: true,
    note: "Nhiều công ty ở Phần Lan gọi 3–5 năm là Senior. Đáng liếc qua.",
  },
  {
    id: "r_notrole",
    label: "Không phải vai trò của tao",
    field: "title",
    match: "sales, marketing, recruiter, talent acquisition, hr , account manager, designer, ux, customer success, support specialist, controller, accountant",
    action: "kill",
    enabled: true,
    note: "",
  },
  {
    id: "r_custom",
    label: "Ngành ngoài phạm vi",
    field: "any",
    match: "",
    action: "kill",
    enabled: false,
    note: "Để trống sẵn. Điền khi mày phát hiện mẫu lặp lại đáng loại.",
  },
];

const SEED_SOURCES = [
  { id: "s1", name: "LinkedIn Jobs", url: "https://www.linkedin.com/jobs", kind: "board", alert: false },
  { id: "s2", name: "Duunitori", url: "https://duunitori.fi", kind: "board", alert: false },
  { id: "s3", name: "Oikotie Työpaikat", url: "https://tyopaikat.oikotie.fi", kind: "board", alert: false },
  { id: "s4", name: "Työmarkkinatori", url: "https://tyomarkkinatori.fi", kind: "board", alert: false },
  { id: "s5", name: "The Hub", url: "https://thehub.io/jobs/location/finland", kind: "tech", alert: false },
  { id: "s6", name: "Work in Finland", url: "https://www.workinfinland.com", kind: "tech", alert: false },
  { id: "s7", name: "Jobs in Helsinki", url: "https://www.jobsinhelsinki.com", kind: "tech", alert: false },
  { id: "s8", name: "EuroTechJobs", url: "https://www.eurotechjobs.com/jobs/finland", kind: "tech", alert: false },
  { id: "s9", name: "Wellfound", url: "https://wellfound.com/location/finland", kind: "tech", alert: false },
  { id: "s10", name: "startup.jobs", url: "https://startup.jobs/locations/finland", kind: "tech", alert: false },
  { id: "s11", name: "Talented (Witted)", url: "https://talented.fi", kind: "agent", alert: false },
  { id: "s12", name: "Toughbyte", url: "https://toughbyte.com", kind: "agent", alert: false },
  { id: "s13", name: "Finders Seekers", url: "https://findersseekers.io", kind: "agent", alert: false },
  { id: "s14", name: "Academic Work", url: "https://www.academicwork.fi", kind: "agent", alert: false },
  { id: "s15", name: "Barona", url: "https://barona.fi", kind: "agent", alert: false },
];

const SEED_COMPANIES = [
  ["Futurice", "consult"], ["Reaktor", "consult"], ["Nitor", "consult"], ["Solita", "consult"],
  ["Siili Solutions", "consult"], ["Gofore", "consult"], ["Vincit", "consult"], ["Eficode", "consult"],
  ["Knowit", "consult"], ["Qvik", "consult"], ["Wunder", "consult"], ["TietoEVRY", "consult"],
  ["CGI Suomi", "consult"], ["Codemate", "consult"],
  ["Wolt", ""], ["Supercell", ""], ["Rovio", ""], ["Unity", ""], ["Smartly.io", ""],
  ["RELEX Solutions", ""], ["Aiven", ""], ["Oura", ""], ["Varjo", ""], ["Swappie", ""],
  ["Supermetrics", ""], ["Hoxhunt", ""], ["IQM Quantum Computers", ""], ["M-Files", ""],
  ["Valohai", ""], ["IPRally", ""], ["Silo AI", ""],
  ["Nokia", ""], ["Vaisala", ""], ["KONE", ""], ["Wärtsilä", ""], ["Konecranes", ""],
  ["OP Financial Group", ""], ["Nordea", ""], ["Elisa", ""], ["Telia Finland", ""],
  ["S-Group", ""], ["Kesko", ""], ["Sanoma", ""], ["Yle", ""], ["VR Group", ""], ["Posti", ""],
];

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
  [/talented|witted/i, "Talented"],
  [/toughbyte/i, "Toughbyte"],
  [/academic ?work/i, "Academic Work"],
  [/barona/i, "Barona"],
  [/glassdoor/i, "Glassdoor"],
  [/indeed/i, "Indeed"],
  [/greenhouse|lever|ashby|teamtailor|recruitee|workable|smartrecruiters|career|trang công ty/i, "Trang công ty"],
];
const srcLabel = (s) => {
  const raw = (s || "").trim();
  if (!raw) return "không rõ";
  for (const [re, name] of SRC_ALIAS) if (re.test(raw)) return name;
  return raw.length > 24 ? raw.slice(0, 24) : raw;
};
const channels = (j) => (j.seenOn && j.seenOn.length ? j.seenOn : [j.source].filter(Boolean));
/* Chỉ thấy ở trang tuyển dụng của công ty = tin chưa lên board = ít cạnh tranh hơn. */
const isEarly = (j) => { const c = channels(j); return c.length === 1 && c[0] === "Trang công ty"; };

const uid = () => Math.random().toString(36).slice(2, 10);
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const jobKey = (j) => norm(j.company) + "|" + norm(j.title);
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

/* --------------------- rules engine --------------------- */
function evaluate(job, rules) {
  let doubtHit = null;
  for (const r of rules) {
    if (!r.enabled) continue;
    const terms = (r.match || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (!terms.length) continue;
    let hay = "";
    if (r.field === "title") hay = job.title;
    else if (r.field === "company") hay = job.company;
    else if (r.field === "lang") hay = job.adLanguage || "";
    else hay = [job.title, job.company, job.note, job.location].join(" ");
    hay = (hay || "").toLowerCase();
    if (terms.some((t) => hay.includes(t))) {
      if (r.action === "kill") return r;
      if (!doubtHit) doubtHit = r;
    }
  }
  return doubtHit;
}

/* ============================= APP ============================= */
export default function App() {
  const [jobs, setJobs] = useState([]);
  const [conf, setConf] = useState(null);
  const [view, setView] = useState("new");
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState("");
  const undoRef = useRef([]);

  /* ---------- load ---------- */
  useEffect(() => {
    (async () => {
      let j = [];
      let c = null;
      try {
        const r = await window.storage.get(K_JOBS);
        if (r) j = JSON.parse(r.value);
      } catch (e) { /* chưa có dữ liệu */ }
      try {
        const r = await window.storage.get(K_CONF);
        if (r) c = JSON.parse(r.value);
      } catch (e) { /* chưa có dữ liệu */ }
      if (!c) {
        c = {
          rules: DEFAULT_RULES,
          companies: [],
          sources: SEED_SOURCES,
          lastSweep: null,
          startDate: today(),
          keywords: "Software Engineer, Machine Learning Engineer, AI Engineer, Backend Engineer, Full-stack Engineer",
          place: "Finland (Helsinki, Tampere, Turku, Oulu, remote)",
          maybeTTL: 21,
        };
      }
      // auto-archive: Có thể / Ngờ vực quá hạn
      const t = today();
      let moved = 0;
      j = j.map((x) => {
        if ((x.status === "maybe" || x.status === "doubt") && daysBetween(x.found, t) > (c.maybeTTL || 21)) {
          moved++;
          return { ...x, status: "archived", archivedFrom: x.status };
        }
        return x;
      });
      setJobs(j);
      setConf(c);
      setReady(true);
      if (moved) setToast(`${moved} tin quá ${c.maybeTTL} ngày đã chuyển sang Lưu trữ`);
    })();
  }, []);

  /* ---------- save ---------- */
  const saveJobs = useCallback(async (next) => {
    setJobs(next);
    try { await window.storage.set(K_JOBS, JSON.stringify(next)); }
    catch (e) { setToast("Không lưu được. Xuất file dự phòng ở tab Dữ liệu."); }
  }, []);

  const saveConf = useCallback(async (next) => {
    setConf(next);
    try { await window.storage.set(K_CONF, JSON.stringify(next)); }
    catch (e) { setToast("Không lưu được cấu hình."); }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const counts = useMemo(() => {
    const m = {};
    for (const b of BINS) m[b.id] = 0;
    for (const j of jobs) m[j.status] = (m[j.status] || 0) + 1;
    return m;
  }, [jobs]);

  /* ---------- actions ---------- */
  const move = useCallback((id, status) => {
    const before = jobs.find((x) => x.id === id);
    if (!before) return;
    undoRef.current = [{ id, status: before.status, manual: before.manual }, ...undoRef.current].slice(0, 20);
    saveJobs(jobs.map((x) => (x.id === id ? { ...x, status, manual: true } : x)));
  }, [jobs, saveJobs]);

  const undo = useCallback(() => {
    const last = undoRef.current[0];
    if (!last) return;
    undoRef.current = undoRef.current.slice(1);
    saveJobs(jobs.map((x) => (x.id === last.id ? { ...x, status: last.status, manual: last.manual } : x)));
    setToast("Đã hoàn tác");
  }, [jobs, saveJobs]);

  const ingest = useCallback((incoming) => {
    const byKey = new Map(jobs.map((j) => [jobKey(j), j]));
    const fresh = [];
    const merged = new Map();
    let dup = 0;
    for (const raw of incoming) {
      const src = srcLabel(raw.source);
      const j = {
        id: uid(),
        title: (raw.title || "").trim(),
        company: (raw.company || "").trim(),
        location: (raw.location || "").trim(),
        url: (raw.url || "").trim(),
        source: src,
        seenOn: [src],
        adLanguage: raw.adLanguage || "en",
        note: (raw.note || "").trim(),
        found: today(),
        status: "new",
        manual: false,
        killedBy: null,
      };
      if (!j.title || !j.company) continue;
      const k = jobKey(j);
      const existing = byKey.get(k);
      if (existing) {
        // Không tạo dòng mới — chỉ ghi thêm kênh đã bắt gặp nó.
        const prev = merged.get(k) || existing;
        const on = prev.seenOn || [prev.source].filter(Boolean);
        if (!on.includes(src)) merged.set(k, { ...prev, seenOn: [...on, src] });
        dup++;
        continue;
      }
      byKey.set(k, j);
      const hit = evaluate(j, conf.rules);
      if (hit) { j.status = hit.action === "kill" ? "killed" : "doubt"; j.killedBy = hit.id; }
      fresh.push(j);
    }
    const next = jobs.map((x) => merged.get(jobKey(x)) || x);
    saveJobs([...fresh, ...next]);
    const auto = fresh.filter((x) => x.status !== "new").length;
    setToast(`Thêm ${fresh.length} tin · ${auto} bị luật xử lý · ${dup} trùng đã gộp nguồn`);
    return fresh.length;
  }, [jobs, conf, saveJobs]);

  /* ---------- rule toggle → hồi sinh ---------- */
  const toggleRule = useCallback((ruleId) => {
    const rule = conf.rules.find((r) => r.id === ruleId);
    if (!rule) return;
    const turningOff = rule.enabled;
    const nextRules = conf.rules.map((r) => (r.id === ruleId ? { ...r, enabled: !r.enabled } : r));
    saveConf({ ...conf, rules: nextRules });
    if (turningOff) {
      const affected = jobs.filter((x) => x.killedBy === ruleId && !x.manual && (x.status === "killed" || x.status === "doubt"));
      if (affected.length) {
        saveJobs(jobs.map((x) =>
          x.killedBy === ruleId && !x.manual && (x.status === "killed" || x.status === "doubt")
            ? { ...x, status: "new", killedBy: null } : x));
        setToast(`${affected.length} tin bị luật này xử lý đã quay về Hộp đến`);
      } else {
        setToast("Đã tắt luật. Không có tin nào cần hồi sinh.");
      }
    }
  }, [conf, jobs, saveConf, saveJobs]);

  const editRule = useCallback((ruleId, patch) => {
    saveConf({ ...conf, rules: conf.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)) });
  }, [conf, saveConf]);

  const rerun = useCallback(() => {
    let touched = 0;
    const next = jobs.map((x) => {
      if (x.manual || x.status === "applied") return x;
      if (!["new", "killed", "doubt"].includes(x.status)) return x;
      const hit = evaluate(x, conf.rules);
      const want = hit ? (hit.action === "kill" ? "killed" : "doubt") : "new";
      if (want !== x.status || (hit && hit.id !== x.killedBy)) touched++;
      return { ...x, status: want, killedBy: hit ? hit.id : null };
    });
    saveJobs(next);
    setToast(`Chạy lại luật: ${touched} tin đổi trạng thái`);
  }, [jobs, conf, saveJobs]);

  if (!ready || !conf) {
    return <div style={{ padding: 40, fontFamily: "system-ui", color: "#6A757F" }}>Đang mở bàn làm việc…</div>;
  }

  const sweepDays = conf.lastSweep ? daysBetween(conf.lastSweep, today()) : null;
  const sweepCount = counts.maybe + counts.doubt;
  const campaignDay = daysBetween(conf.startDate, today()) + 1;

  return (
    <div className="jh">
      <style>{CSS}</style>

      <header className="top">
        <div className="topL">
          <span className="mark" />
          <b>Bàn phân loại</b>
          <span className="sep">/</span>
          <span className="dim">ngày {campaignDay} của chiến dịch</span>
        </div>
        <div className="topR">
          {sweepCount > 0 && (
            <button className={"sweepBtn" + (sweepDays === null || sweepDays >= 7 ? " due" : "")}
              onClick={() => setView("sweep")}>
              {sweepDays === null ? `Chưa rà soát lần nào · ${sweepCount} tin`
                : sweepDays >= 7 ? `Rà soát quá hạn ${sweepDays} ngày · ${sweepCount} tin`
                  : `Rà soát ${sweepDays} ngày trước · ${sweepCount} tin`}
            </button>
          )}
          <button className="ghost" onClick={undo} disabled={!undoRef.current.length}>Hoàn tác</button>
        </div>
      </header>

      <div className="body">
        <nav className="rail">
          <div className="railHead">Thùng chứa</div>
          {BINS.map((b) => (
            <button key={b.id} className={"bin" + (view === b.id ? " on" : "")} onClick={() => setView(b.id)}>
              <span className="binLbl">{b.label}</span>
              <span className={"binN" + (counts[b.id] ? "" : " zero")}>{counts[b.id] || 0}</span>
            </button>
          ))}
          <div className="railNote">Không có gì bị xóa. Mọi tin đều nằm trong một thùng.</div>
          <div className="railHead sp">Công cụ</div>
          {[["find", "Tìm job"], ["sweep", "Rà soát"], ["companies", "Công ty"], ["sources", "Nguồn"], ["rules", "Luật"], ["data", "Dữ liệu"]].map(([id, lbl]) => (
            <button key={id} className={"tool" + (view === id ? " on" : "")} onClick={() => setView(id)}>{lbl}</button>
          ))}
        </nav>

        <main className="main">
          {view === "new" && <Triage jobs={jobs.filter((j) => j.status === "new")} move={move} undo={undo} />}
          {["queue", "maybe", "doubt", "applied", "killed", "archived"].includes(view) && (
            <BinList bin={view} jobs={jobs.filter((j) => j.status === view)} move={move}
              rules={conf.rules} />
          )}
          {view === "sweep" && <Sweep jobs={jobs} move={move} conf={conf} saveConf={saveConf} setToast={setToast} />}
          {view === "find" && <Find conf={conf} saveConf={saveConf} ingest={ingest} companies={conf.companies} />}
          {view === "companies" && <Companies conf={conf} saveConf={saveConf} jobs={jobs} />}
          {view === "sources" && <Sources conf={conf} saveConf={saveConf} jobs={jobs} />}
          {view === "rules" && <Rules conf={conf} jobs={jobs} toggleRule={toggleRule} editRule={editRule}
            saveConf={saveConf} rerun={rerun} />}
          {view === "data" && <Data jobs={jobs} conf={conf} saveJobs={saveJobs} saveConf={saveConf} setToast={setToast} />}
        </main>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ========================= TRIAGE ========================= */
function Triage({ jobs, move, undo }) {
  const [i, setI] = useState(0);
  const job = jobs[i] || jobs[0];

  useEffect(() => { if (i >= jobs.length) setI(Math.max(0, jobs.length - 1)); }, [jobs.length, i]);

  const act = useCallback((status) => { if (job) move(job.id, status); }, [job, move]);

  useEffect(() => {
    const h = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "1") act("queue");
      else if (e.key === "2") act("maybe");
      else if (e.key === "3") act("doubt");
      else if (e.key === "4") act("killed");
      else if (e.key === "u" || e.key === "z") undo();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [act, undo]);

  if (!jobs.length) {
    return (
      <Empty title="Hộp đến trống"
        body="Luật đã xử lý hết, hoặc chưa có tin nào vào. Sang tab Tìm job để kéo đợt mới." />
    );
  }

  return (
    <div className="triage">
      <div className="triageBar">
        <span>Còn <b>{jobs.length}</b> tin chờ phân loại</span>
        <span className="dim">Quyết định bằng một phím. Đừng giải thích lý do — luật lo phần đó.</span>
      </div>

      <article className="card">
        <div className="cardCo">{job.company}</div>
        <h2 className="cardTitle">{job.title}</h2>
        <div className="cardMeta">
          {job.location && <span>{job.location}</span>}
          <span>{job.adLanguage === "fi" ? "tin tiếng Phần Lan" : "tin tiếng Anh"}</span>
          <span>vào {job.found}</span>
        </div>
        <div className="srcLine">
          <span className="srcLbl">Thấy ở</span>
          {channels(job).map((c) => <span key={c} className="chip">{c}</span>)}
          {isEarly(job) && <span className="chip early">chưa lên board — ít cạnh tranh</span>}
        </div>
        {job.note && <p className="cardNote">{job.note}</p>}
        {job.url && <a className="cardLink" href={job.url} target="_blank" rel="noreferrer">Mở tin gốc</a>}
        <p className="cardWarn">Chưa đọc mô tả công việc ở bước này. Đó là việc của Hàng đọc, làm vào đầu buổi.</p>
      </article>

      <div className="keys">
        <Key n="1" label="Chắc chắn liên quan" sub="vào Hàng đọc" tone="go" onClick={() => act("queue")} />
        <Key n="2" label="Có thể liên quan" sub="vào Có thể" tone="mid" onClick={() => act("maybe")} />
        <Key n="3" label="Lăn tăn" sub="vào Ngờ vực" tone="warn" onClick={() => act("doubt")} />
        <Key n="4" label="Loại" sub="vào Đã loại" tone="off" onClick={() => act("killed")} />
      </div>
      <div className="keysHint">Phím <kbd>U</kbd> để hoàn tác. Sai thì sửa sau — không mất gì.</div>
    </div>
  );
}

function Key({ n, label, sub, tone, onClick }) {
  return (
    <button className={"key k-" + tone} onClick={onClick}>
      <kbd>{n}</kbd>
      <span className="keyL">{label}</span>
      <span className="keyS">{sub}</span>
    </button>
  );
}

/* ========================= BIN LIST ========================= */
function BinList({ bin, jobs: all, move, rules }) {
  const meta = BINS.find((b) => b.id === bin);
  const ruleName = (id) => (rules.find((r) => r.id === id) || {}).label || "luật đã xóa";
  const [srcFilter, setSrcFilter] = useState("");

  const allSrc = useMemo(() => {
    const s = new Set();
    all.forEach((j) => channels(j).forEach((c) => s.add(c)));
    return [...s].sort();
  }, [all]);

  const jobs = srcFilter ? all.filter((j) => channels(j).includes(srcFilter)) : all;

  if (!all.length) return <Empty title={`${meta.label} trống`} body="Chưa có tin nào ở đây." />;

  const capped = bin === "queue";

  return (
    <div className="list">
      <div className="listHead">
        <h2>{meta.label}</h2>
        <span className="dim">{jobs.length} tin{srcFilter ? ` / ${all.length}` : ""}</span>
      </div>
      {allSrc.length > 1 && (
        <div className="filterRow">
          <button className={"chipBtn" + (srcFilter ? "" : " on")} onClick={() => setSrcFilter("")}>mọi nguồn</button>
          {allSrc.map((s) => (
            <button key={s} className={"chipBtn" + (srcFilter === s ? " on" : "")}
              onClick={() => setSrcFilter(srcFilter === s ? "" : s)}>{s}</button>
          ))}
        </div>
      )}
      {capped && (
        <p className="advice">
          Đọc tối đa 10 tin mỗi buổi, và đọc ở <b>block đầu tiên</b> lúc còn tỉnh. Hết 10 thì dừng —
          phần còn lại vẫn nằm đây, không mất.
        </p>
      )}
      {jobs.map((j, idx) => (
        <div key={j.id} className={"row" + (capped && idx === 10 ? " cut" : "")}>
          <div className="rowMain">
            <div className="rowTop">
              <b>{j.title}</b>
              <span className="dim">{j.company}</span>
            </div>
            <div className="rowMeta">
              {channels(j).map((c) => <span key={c} className="chip">{c}</span>)}
              {isEarly(j) && <span className="chip early">chưa lên board</span>}
              {j.location && <span>{j.location}</span>}
              {j.adLanguage === "fi" && <span className="tagFi">tiếng Phần Lan</span>}
              <span>{j.found}</span>
              {j.killedBy && <span className="tagRule">luật: {ruleName(j.killedBy)}</span>}
              {j.url && <a href={j.url} target="_blank" rel="noreferrer">tin gốc</a>}
            </div>
          </div>
          <div className="rowActs">
            {bin !== "queue" && <button onClick={() => move(j.id, "queue")}>Đưa vào Hàng đọc</button>}
            {bin === "queue" && <button className="go" onClick={() => move(j.id, "applied")}>Đã nộp</button>}
            {bin !== "killed" && <button className="off" onClick={() => move(j.id, "killed")}>Loại</button>}
            {bin === "killed" && <button onClick={() => move(j.id, "new")}>Trả về Hộp đến</button>}
          </div>
        </div>
      ))}
      {capped && jobs.length > 10 && <div className="cutNote">Dưới vạch này để buổi sau.</div>}
    </div>
  );
}

/* ========================= SWEEP ========================= */
function Sweep({ jobs, move, conf, saveConf, setToast }) {
  const pool = jobs.filter((j) => j.status === "maybe" || j.status === "doubt");
  const days = conf.lastSweep ? daysBetween(conf.lastSweep, today()) : null;

  return (
    <div className="list">
      <div className="listHead">
        <h2>Rà soát</h2>
        <span className="dim">{pool.length} tin</span>
      </div>
      <p className="advice">
        FOMO là một vòng lặp mở không giới hạn. Đóng nó bằng một việc có lịch, không phải bằng
        việc lo lắng. Mỗi thứ Sáu, 20 phút, quét hết chỗ này.
        {days !== null && <> Lần gần nhất: <b>{days} ngày trước</b>.</>}
      </p>
      <button className="primary" onClick={() => { saveConf({ ...conf, lastSweep: today() }); setToast("Đã ghi nhận buổi rà soát hôm nay"); }}>
        Đánh dấu đã rà soát hôm nay
      </button>

      {!pool.length && <Empty title="Không còn gì để rà soát" body="Cả hai thùng Có thể và Ngờ vực đều sạch." />}

      {pool.map((j) => (
        <div key={j.id} className="row">
          <div className="rowMain">
            <div className="rowTop">
              <b>{j.title}</b>
              <span className="dim">{j.company}</span>
              <span className={"pill " + j.status}>{j.status === "doubt" ? "ngờ vực" : "có thể"}</span>
            </div>
            <div className="rowMeta">
              <span>{daysBetween(j.found, today())} ngày trong thùng</span>
              <span>tự lưu trữ sau {conf.maybeTTL} ngày</span>
              {j.url && <a href={j.url} target="_blank" rel="noreferrer">tin gốc</a>}
            </div>
          </div>
          <div className="rowActs">
            <button className="go" onClick={() => move(j.id, "queue")}>Đưa vào Hàng đọc</button>
            <button className="off" onClick={() => move(j.id, "killed")}>Loại hẳn</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ========================= FIND ========================= */
function Find({ conf, saveConf, ingest }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [raw, setRaw] = useState("");
  const [mode, setMode] = useState("auto");
  const [pasteSrc, setPasteSrc] = useState("LinkedIn");

  const pull = async () => {
    setBusy(true); setErr("");
    const prompt = `Search the web for CURRENT job openings.

Roles: ${conf.keywords}
Location: ${conf.place}
Candidate: 3.5 years professional software engineering experience, works in English, based in Finland.

Search across job boards and company career pages. Prefer postings from the last 30 days.

Return ONLY a JSON array. No markdown fences, no preamble, no trailing text.
Each object: {"title","company","location","url","source","adLanguage","note"}
- adLanguage: "fi" if the posting is written in Finnish, otherwise "en"
- note: max 12 words on why it fits
- url: the real posting URL you found. If unsure, use the company careers page.
- Maximum 10 objects.`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      });
      const data = await res.json();
      const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const clean = text.replace(/```json|```/g, "").trim();
      const start = clean.indexOf("[");
      const end = clean.lastIndexOf("]");
      if (start === -1 || end === -1) throw new Error("no-array");
      const arr = JSON.parse(clean.slice(start, end + 1));
      if (!Array.isArray(arr) || !arr.length) throw new Error("empty");
      ingest(arr.map((x) => ({ ...x, source: x.source || "tìm tự động" })));
    } catch (e) {
      setErr("Đợt tìm này không trả về kết quả đọc được. Bấm tìm lại, hoặc dán tay ở dưới.");
    }
    setBusy(false);
  };

  const parsePaste = () => {
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (const l of lines) {
      const parts = l.split(/\s*[|\t]\s*|\s+[-–—]\s+/).filter(Boolean);
      if (parts.length < 2) continue;
      const urlPart = parts.find((p) => /^https?:\/\//.test(p)) || "";
      const rest = parts.filter((p) => p !== urlPart);
      out.push({
        title: rest[0] || "",
        company: rest[1] || "",
        location: rest[2] || "",
        url: urlPart,
        source: pasteSrc,
        adLanguage: /[äöå]/i.test(l) ? "fi" : "en",
      });
    }
    if (!out.length) { setErr("Không tách được dòng nào. Mỗi dòng cần: Chức danh | Công ty | Địa điểm | Link"); return; }
    ingest(out);
    setRaw(""); setErr("");
  };

  return (
    <div className="pane">
      <h2>Tìm job</h2>

      <div className="tabs">
        <button className={mode === "auto" ? "on" : ""} onClick={() => setMode("auto")}>Tự tìm</button>
        <button className={mode === "paste" ? "on" : ""} onClick={() => setMode("paste")}>Dán hàng loạt</button>
      </div>

      {mode === "auto" && (
        <>
          <label className="fld">
            <span>Chức danh săn tìm</span>
            <input value={conf.keywords} onChange={(e) => saveConf({ ...conf, keywords: e.target.value })} />
          </label>
          <label className="fld">
            <span>Khu vực</span>
            <input value={conf.place} onChange={(e) => saveConf({ ...conf, place: e.target.value })} />
          </label>
          <button className="primary" onClick={pull} disabled={busy}>
            {busy ? "Đang tìm…" : "Kéo một đợt mới"}
          </button>
          <p className="advice">
            Mỗi đợt trả tối đa 10 tin, đã lọc trùng và đã chạy qua luật. Độ phủ không bằng alert email
            của board — coi đây là dòng bổ sung, không phải nguồn duy nhất. Luôn mở tin gốc kiểm tra
            trước khi nộp.
          </p>
        </>
      )}

      {mode === "paste" && (
        <>
          <p className="advice">Mỗi dòng một tin: <code>Chức danh | Công ty | Địa điểm | Link</code></p>
          <label className="fld">
            <span>Đợt này lấy từ đâu</span>
            <select value={pasteSrc} onChange={(e) => setPasteSrc(e.target.value)}>
              {["LinkedIn", "Duunitori", "Oikotie", "Työmarkkinatori", "The Hub", "Jobly",
                "Trang công ty", "Talented", "Toughbyte", "Giới thiệu", "không rõ"]
                .map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <textarea rows={10} value={raw} onChange={(e) => setRaw(e.target.value)}
            placeholder={"Backend Engineer | Wolt | Helsinki | https://…\nAI Engineer | Aiven | Helsinki | https://…"} />
          <button className="primary" onClick={parsePaste}>Đưa vào Hộp đến</button>
        </>
      )}

      {err && <p className="err">{err}</p>}
    </div>
  );
}

/* ========================= COMPANIES ========================= */
const TIERS = [["", "chưa xếp"], ["a", "A — rất muốn"], ["b", "B — hợp lý"], ["c", "C — mở"], ["consult", "Consultancy"]];

function Companies({ conf, saveConf, jobs }) {
  const [name, setName] = useState("");
  const list = conf.companies;

  const add = (n, tier = "") => {
    if (!n.trim()) return;
    if (list.some((c) => norm(c.name) === norm(n))) return;
    saveConf({ ...conf, companies: [{ id: uid(), name: n.trim(), tier, url: "", note: "" }, ...list] });
  };

  const seed = () => {
    const have = new Set(list.map((c) => norm(c.name)));
    const add2 = SEED_COMPANIES.filter(([n]) => !have.has(norm(n)))
      .map(([n, t]) => ({ id: uid(), name: n, tier: t, url: "", note: "" }));
    saveConf({ ...conf, companies: [...list, ...add2] });
  };

  const patch = (id, p) => saveConf({ ...conf, companies: list.map((c) => (c.id === id ? { ...c, ...p } : c)) });

  const jobCount = (n) => jobs.filter((j) => norm(j.company) === norm(n)).length;
  const sorted = [...list].sort((a, b) => {
    const o = { a: 0, b: 1, c: 2, consult: 3, "": 4 };
    return (o[a.tier] ?? 4) - (o[b.tier] ?? 4) || a.name.localeCompare(b.name);
  });

  return (
    <div className="pane">
      <h2>Công ty</h2>
      <p className="advice">
        Danh sách này lớn dần, không cần chốt ngay. <b>Hạng chỉ dùng để xếp thứ tự đọc, không bao giờ
        dùng để loại</b> — nên để trống thoải mái khi mày chưa hiểu rõ một công ty.
      </p>
      <div className="addRow">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên công ty"
          onKeyDown={(e) => { if (e.key === "Enter") { add(name); setName(""); } }} />
        <button onClick={() => { add(name); setName(""); }}>Thêm</button>
        {!list.length && <button className="ghost" onClick={seed}>Nạp {SEED_COMPANIES.length} công ty mẫu</button>}
      </div>
      {!!list.length && list.length < SEED_COMPANIES.length && (
        <button className="ghost" onClick={seed}>Bổ sung các công ty mẫu còn thiếu</button>
      )}

      {sorted.map((c) => (
        <div key={c.id} className="row">
          <div className="rowMain">
            <div className="rowTop"><b>{c.name}</b>
              {jobCount(c.name) > 0 && <span className="tagRule">{jobCount(c.name)} tin đã thấy</span>}
            </div>
            <div className="rowMeta">
              <input className="inline" placeholder="link trang tuyển dụng" value={c.url}
                onChange={(e) => patch(c.id, { url: e.target.value })} />
              {c.url && <a href={c.url} target="_blank" rel="noreferrer">mở</a>}
            </div>
          </div>
          <div className="rowActs">
            <select value={c.tier} onChange={(e) => patch(c.id, { tier: e.target.value })}>
              {TIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ========================= SOURCES ========================= */
const KINDS = { board: "Board đa ngành", tech: "Board tech / startup", agent: "Agent & recruiter" };

function Sources({ conf, saveConf, jobs }) {
  const toggle = (id) => saveConf({
    ...conf, sources: conf.sources.map((s) => (s.id === id ? { ...s, alert: !s.alert } : s)),
  });
  const done = conf.sources.filter((s) => s.alert).length;

  const yieldRows = useMemo(() => {
    const m = new Map();
    for (const j of jobs) {
      for (const c of channels(j)) {
        const e = m.get(c) || { name: c, total: 0, kept: 0, applied: 0 };
        e.total++;
        if (["queue", "applied"].includes(j.status)) e.kept++;
        if (j.status === "applied") e.applied++;
        m.set(c, e);
      }
    }
    return [...m.values()].sort((a, b) => b.kept - a.kept || b.total - a.total);
  }, [jobs]);

  return (
    <div className="pane">
      <h2>Nguồn</h2>

      {yieldRows.length > 0 && (
        <>
          <h3 className="grp">Kênh nào thật sự sinh việc</h3>
          <p className="advice">
            Số lượng không phải là giá trị. Một kênh đổ về 200 tin mà mày giữ lại 4 thì nó đang
            ăn thời gian của mày. Sau vài tuần, bảng này cho biết nên tắt alert nào và nên đầu tư
            vào đâu. Dưới 20 tin thì chưa đủ để kết luận.
          </p>
          <table className="yield">
            <thead>
              <tr><th>Kênh</th><th>Tin</th><th>Giữ lại</th><th>Tỉ lệ</th><th>Đã nộp</th></tr>
            </thead>
            <tbody>
              {yieldRows.map((r) => {
                const rate = r.total ? Math.round((r.kept / r.total) * 100) : 0;
                const thin = r.total >= 20 && rate < 5;
                return (
                  <tr key={r.name} className={thin ? "thin" : ""}>
                    <td>{r.name}</td>
                    <td>{r.total}</td>
                    <td>{r.kept}</td>
                    <td>{r.total >= 20 ? `${rate}%` : <span className="dim">chưa đủ mẫu</span>}</td>
                    <td>{r.applied || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h3 className="grp">Bật alert</h3>
        </>
      )}
      <p className="advice">
        Việc một lần: bật saved search + email alert trên từng nguồn. Sau đó mày không mở trang board
        nào nữa — job mới tự rơi vào một folder email, và Hộp đến của mày được nạp từ đó.
        Đã bật <b>{done}/{conf.sources.length}</b>.
      </p>
      {Object.keys(KINDS).map((k) => (
        <div key={k}>
          <h3 className="grp">{KINDS[k]}</h3>
          {conf.sources.filter((s) => s.kind === k).map((s) => (
            <label key={s.id} className="srcRow">
              <input type="checkbox" checked={s.alert} onChange={() => toggle(s.id)} />
              <span className="srcName">{s.name}</span>
              <a href={s.url} target="_blank" rel="noreferrer">{s.url.replace(/^https?:\/\//, "")}</a>
            </label>
          ))}
        </div>
      ))}
      <p className="advice">
        Nhóm agent hoạt động khác: mày làm một buổi trao đổi, sau đó <b>họ đọc mô tả công việc thay mày</b>
        và chỉ đẩy về cái khớp. Với người ngại đọc JD thì đây là kênh có đòn bẩy cao nhất.
      </p>
    </div>
  );
}

/* ========================= RULES ========================= */
function Rules({ conf, jobs, toggleRule, editRule, saveConf, rerun }) {
  const stat = (id) => jobs.filter((j) => j.killedBy === id && !j.manual).length;
  const total = jobs.length || 1;

  const addRule = () => saveConf({
    ...conf,
    rules: [...conf.rules, { id: uid(), label: "Luật mới", field: "title", match: "", action: "doubt", enabled: false, note: "" }],
  });

  return (
    <div className="pane">
      <h2>Luật</h2>
      <p className="advice">
        Mỗi tin bị luật xử lý đều ghi lại <b>luật nào</b> đã xử lý nó. Tắt một luật thì toàn bộ tin nó
        từng xử lý quay về Hộp đến. Vì sai lầm hoàn tác được theo lô, mày có thể viết luật mạnh tay —
        mà luật mạnh tay chính là thứ làm phân loại nhanh.
      </p>
      <button className="ghost" onClick={rerun}>Chạy lại toàn bộ luật</button>

      {conf.rules.map((r) => {
        const n = stat(r.id);
        const heavy = n / total > 0.5 && n > 5;
        return (
          <div key={r.id} className={"ruleCard" + (r.enabled ? "" : " off")}>
            <div className="ruleTop">
              <input className="ruleName" value={r.label} onChange={(e) => editRule(r.id, { label: e.target.value })} />
              <label className="sw">
                <input type="checkbox" checked={r.enabled} onChange={() => toggleRule(r.id)} />
                <span>{r.enabled ? "đang bật" : "đã tắt"}</span>
              </label>
            </div>
            <div className="ruleRow">
              <select value={r.field} onChange={(e) => editRule(r.id, { field: e.target.value })}>
                <option value="title">chức danh</option>
                <option value="company">công ty</option>
                <option value="lang">ngôn ngữ tin</option>
                <option value="any">bất kỳ đâu</option>
              </select>
              <span className="dim">chứa</span>
              <input className="ruleMatch" value={r.match} placeholder="từ khóa, cách nhau bằng dấu phẩy"
                onChange={(e) => editRule(r.id, { match: e.target.value })} />
              <select value={r.action} onChange={(e) => editRule(r.id, { action: e.target.value })}>
                <option value="kill">thì loại</option>
                <option value="doubt">thì đưa vào Ngờ vực</option>
              </select>
            </div>
            {r.note && <p className="ruleNote">{r.note}</p>}
            <div className="ruleStat">
              {n > 0 ? <>Đang xử lý <b>{n}</b> tin. Tắt luật này thì cả {n} tin quay về Hộp đến.</> : "Chưa xử lý tin nào."}
              {heavy && <span className="warn">Luật này đang loại quá nửa số tin. Kiểm tra xem có đang tự bịt mắt không.</span>}
            </div>
          </div>
        );
      })}
      <button className="ghost" onClick={addRule}>Thêm luật</button>
    </div>
  );
}

/* ========================= DATA ========================= */
function Data({ jobs, conf, saveJobs, saveConf, setToast }) {
  const [paste, setPaste] = useState("");
  const dump = JSON.stringify({ jobs, conf, exported: new Date().toISOString() }, null, 2);

  const download = () => {
    const blob = new Blob([dump], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `job-pipeline-${today()}.json`;
    a.click();
  };

  const restore = () => {
    try {
      const d = JSON.parse(paste);
      if (!Array.isArray(d.jobs)) throw new Error();
      saveJobs(d.jobs);
      if (d.conf) saveConf(d.conf);
      setPaste("");
      setToast("Đã nạp lại dữ liệu");
    } catch (e) { setToast("File không đọc được. Cần đúng JSON đã xuất từ app này."); }
  };

  return (
    <div className="pane">
      <h2>Dữ liệu</h2>
      <p className="advice">
        Dữ liệu nằm trong trình duyệt, gắn với app này. Ba tháng là dài — xuất file mỗi thứ Sáu,
        cùng buổi với rà soát. Coi như một thói quen chứ không phải việc phải nhớ.
      </p>
      <div className="stats">
        <div><b>{jobs.length}</b><span>tin đã vào hệ thống</span></div>
        <div><b>{jobs.filter((j) => j.status === "applied").length}</b><span>đã nộp</span></div>
        <div><b>{conf.companies.length}</b><span>công ty theo dõi</span></div>
        <div><b>{conf.sources.filter((s) => s.alert).length}</b><span>nguồn đã bật alert</span></div>
      </div>
      <button className="primary" onClick={download}>Tải file sao lưu</button>
      <h3 className="grp">Nạp lại từ file</h3>
      <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Dán nội dung file JSON đã xuất" />
      <button className="ghost" onClick={restore}>Ghi đè bằng dữ liệu này</button>
    </div>
  );
}

/* ========================= SHARED ========================= */
function Empty({ title, body }) {
  return <div className="empty"><h3>{title}</h3><p>{body}</p></div>;
}

/* ========================= CSS ========================= */
const CSS = `
.jh{--bg:#E4E7E9;--surface:#FBFBFC;--ink:#14191F;--muted:#6A757F;--line:#C9CFD4;
--signal:#0B5FA5;--amber:#B0700C;--dim:#8B949B;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
color:var(--ink);background:var(--bg);min-height:100vh;font-size:15px;line-height:1.5}
.jh *{box-sizing:border-box}
.jh button,.jh input,.jh select,.jh textarea{font:inherit;color:inherit}
.jh :focus-visible{outline:2px solid var(--signal);outline-offset:2px}
.jh a{color:var(--signal);text-decoration:none}
.jh a:hover{text-decoration:underline}
.jh code{background:#DDE1E4;padding:1px 5px;border-radius:3px;font-size:.88em}

.top{display:flex;justify-content:space-between;align-items:center;gap:16px;
padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--line);flex-wrap:wrap}
.topL{display:flex;align-items:center;gap:10px}
.mark{width:11px;height:11px;background:var(--signal);border-radius:2px;transform:rotate(45deg)}
.sep{color:var(--line)}
.dim{color:var(--muted)}
.topR{display:flex;gap:8px;align-items:center}
.sweepBtn{background:none;border:1px solid var(--line);padding:6px 12px;border-radius:5px;cursor:pointer;color:var(--muted)}
.sweepBtn.due{border-color:var(--amber);color:var(--amber);background:#FBF3E4}

.body{display:flex;align-items:flex-start;min-height:calc(100vh - 53px)}
.rail{width:215px;flex:0 0 215px;padding:16px 12px;border-right:1px solid var(--line);
position:sticky;top:0;align-self:stretch}
.railHead{font-size:12px;color:var(--muted);padding:0 8px 8px}
.railHead.sp{padding-top:20px;border-top:1px solid var(--line);margin-top:16px}
.bin,.tool{display:flex;width:100%;align-items:center;justify-content:space-between;gap:8px;
background:none;border:0;padding:7px 9px;border-radius:5px;cursor:pointer;text-align:left}
.bin:hover,.tool:hover{background:#D8DCDF}
.bin.on,.tool.on{background:var(--ink);color:var(--surface)}
.binN{font-variant-numeric:tabular-nums;font-weight:600;font-size:13px}
.binN.zero{color:var(--dim);font-weight:400}
.bin.on .binN.zero{color:#8FA0AE}
.railNote{font-size:12px;color:var(--muted);padding:12px 9px 0;line-height:1.45}

.main{flex:1;min-width:0;padding:26px 30px 60px;max-width:880px}

.triageBar{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px;font-size:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:26px 28px}
.cardCo{color:var(--muted);font-size:14px;margin-bottom:4px}
.cardTitle{margin:0 0 12px;font-size:26px;line-height:1.25;font-weight:600;letter-spacing:-.01em}
.cardMeta{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--muted);margin-bottom:14px}
.cardNote{margin:0 0 14px;max-width:62ch}
.cardLink{font-size:14px}
.cardWarn{margin:18px 0 0;padding-top:14px;border-top:1px solid var(--line);
font-size:13px;color:var(--muted);max-width:62ch}

.keys{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}
.key{display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:12px 13px;
background:var(--surface);border:1px solid var(--line);border-bottom-width:3px;border-radius:6px;cursor:pointer}
.key:hover{background:#fff;transform:translateY(-1px)}
.key:active{transform:translateY(1px);border-bottom-width:1px}
.key kbd{display:inline-grid;place-items:center;width:22px;height:22px;border:1px solid var(--line);
border-radius:4px;font-size:12px;font-weight:600;margin-bottom:4px}
.keyL{font-size:14px;font-weight:600}
.keyS{font-size:12px;color:var(--muted)}
.k-go{border-color:var(--signal)}.k-go kbd{border-color:var(--signal);color:var(--signal)}
.k-warn{border-color:var(--amber)}.k-warn kbd{border-color:var(--amber);color:var(--amber)}
.k-off{color:var(--muted)}
.keysHint{margin-top:10px;font-size:13px;color:var(--muted)}
.keysHint kbd{border:1px solid var(--line);border-radius:3px;padding:0 5px}

.list,.pane{display:flex;flex-direction:column;gap:10px}
.listHead{display:flex;align-items:baseline;gap:12px}
.listHead h2,.pane h2{margin:0;font-size:22px;font-weight:600;letter-spacing:-.01em}
.grp{margin:18px 0 2px;font-size:14px;font-weight:600;color:var(--muted)}
.advice{margin:0;font-size:14px;color:#3E4952;max-width:68ch;background:#DCE0E3;
padding:11px 14px;border-radius:6px;border-left:2px solid var(--muted)}

.row{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;
background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px 14px;flex-wrap:wrap}
.rowMain{flex:1;min-width:220px}
.rowTop{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.rowMeta{display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin-top:4px;align-items:center}
.rowActs{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.rowActs button,.addRow button{background:none;border:1px solid var(--line);padding:5px 10px;
border-radius:5px;cursor:pointer;font-size:13px}
.rowActs button:hover,.addRow button:hover{background:#EDEFF1}
.rowActs .go{border-color:var(--signal);color:var(--signal)}
.rowActs .off{color:var(--muted)}
.row.cut{border-top:2px solid var(--amber)}
.cutNote{font-size:13px;color:var(--amber)}
.tagFi{background:#EAE2F2;padding:1px 6px;border-radius:3px}
.chip{background:#DCE6EE;color:#20486B;padding:1px 8px;border-radius:10px;font-size:12px;white-space:nowrap}
.chip.early{background:#DFEBDC;color:#2C5A36}
.srcLine{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:14px}
.srcLbl{font-size:13px;color:var(--muted)}
.filterRow{display:flex;gap:6px;flex-wrap:wrap}
.chipBtn{background:none;border:1px solid var(--line);color:var(--muted);padding:3px 11px;
border-radius:12px;font-size:12.5px;cursor:pointer}
.chipBtn:hover{background:#EDEFF1}
.chipBtn.on{background:var(--ink);color:var(--surface);border-color:var(--ink)}
.yield{width:100%;border-collapse:collapse;background:var(--surface);
border:1px solid var(--line);border-radius:6px;overflow:hidden;font-size:13.5px}
.yield th{text-align:left;font-weight:600;color:var(--muted);font-size:12.5px;
padding:8px 12px;border-bottom:1px solid var(--line)}
.yield td{padding:7px 12px;border-bottom:1px solid #E7EAEC;font-variant-numeric:tabular-nums}
.yield td:first-child{font-variant-numeric:normal}
.yield tr:last-child td{border-bottom:0}
.yield tr.thin td{color:var(--muted)}
.yield tr.thin td:first-child::after{content:" · đang ăn thời gian";color:var(--amber);font-size:11.5px}
.tagRule{background:#DDE1E4;padding:1px 6px;border-radius:3px}
.pill{font-size:11px;padding:1px 7px;border-radius:10px}
.pill.doubt{background:#FBF3E4;color:var(--amber)}
.pill.maybe{background:#DDE6EE;color:var(--signal)}

.primary{align-self:flex-start;background:var(--ink);color:var(--surface);border:0;
padding:9px 16px;border-radius:5px;cursor:pointer}
.primary:disabled{background:var(--dim);cursor:default}
.ghost{align-self:flex-start;background:none;border:1px solid var(--line);padding:6px 12px;
border-radius:5px;cursor:pointer;color:var(--muted)}
.ghost:disabled{opacity:.4;cursor:default}
.ghost:hover:not(:disabled){background:#EDEFF1;color:var(--ink)}

.tabs{display:flex;gap:6px}
.tabs button{background:none;border:1px solid var(--line);padding:6px 14px;border-radius:5px;cursor:pointer;color:var(--muted)}
.tabs button.on{background:var(--ink);color:var(--surface);border-color:var(--ink)}

.fld{display:flex;flex-direction:column;gap:4px;max-width:560px}
.fld span{font-size:13px;color:var(--muted)}
.jh input,.jh textarea,.jh select{background:var(--surface);border:1px solid var(--line);
border-radius:5px;padding:7px 10px}
.jh textarea{max-width:640px;resize:vertical;line-height:1.5}
.inline{border:0;border-bottom:1px dotted var(--line);border-radius:0;padding:1px 0;
background:none;font-size:12.5px;min-width:230px}
.addRow{display:flex;gap:8px;flex-wrap:wrap}
.addRow input{min-width:240px}
.err{color:#9A2C1E;font-size:14px;margin:0}

.srcRow{display:flex;align-items:center;gap:10px;background:var(--surface);
border:1px solid var(--line);border-radius:6px;padding:9px 12px;cursor:pointer}
.srcName{flex:1;font-weight:500}
.srcRow a{font-size:12.5px;color:var(--muted)}

.ruleCard{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:13px 15px;
display:flex;flex-direction:column;gap:9px}
.ruleCard.off{opacity:.58}
.ruleTop{display:flex;justify-content:space-between;gap:12px;align-items:center}
.ruleName{font-weight:600;flex:1;border:0;background:none;padding:2px 0}
.sw{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);cursor:pointer}
.ruleRow{display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:13px}
.ruleMatch{flex:1;min-width:220px;font-size:13px}
.ruleNote{margin:0;font-size:12.5px;color:var(--muted);max-width:66ch}
.ruleStat{font-size:12.5px;color:var(--muted);display:flex;gap:10px;flex-wrap:wrap}
.ruleStat .warn{color:var(--amber)}

.stats{display:flex;gap:26px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);
border-radius:6px;padding:14px 18px}
.stats div{display:flex;flex-direction:column}
.stats b{font-size:24px;font-variant-numeric:tabular-nums;font-weight:600}
.stats span{font-size:12.5px;color:var(--muted)}

.empty{padding:40px 4px;color:var(--muted)}
.empty h3{margin:0 0 6px;color:var(--ink);font-size:17px;font-weight:600}
.empty p{margin:0;max-width:52ch}

.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink);
color:var(--surface);padding:10px 18px;border-radius:6px;font-size:14px;z-index:50;max-width:90vw}

@media (max-width:760px){
.body{flex-direction:column}
.rail{width:100%;flex:none;border-right:0;border-bottom:1px solid var(--line);position:static;
display:grid;grid-template-columns:repeat(2,1fr);gap:2px}
.railHead,.railNote{grid-column:1/-1}
.railHead.sp{margin-top:8px;padding-top:12px}
.main{padding:18px 16px 50px}
.keys{grid-template-columns:repeat(2,1fr)}
}
@media (prefers-reduced-motion:reduce){.key:hover{transform:none}}
`;
