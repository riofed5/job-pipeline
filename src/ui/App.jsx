import React, { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "./api.js";
import { norm } from "../core/dedupe.js";
import { SEED_COMPANIES } from "../core/seed.js";
import { summarize } from "../ingest/summary.js";
import { SORTS, sortJobs } from "./sort.js";

/* ============================================================
   Bàn phân loại — job pipeline (bản local)
   Port từ reference/job-pipeline.jsx. Lưu trữ đi qua REST thay cho window.storage;
   luật, lọc trùng, hoàn tác chạy ở server (src/core).
   Nguyên tắc: không có gì bị xóa. Loại = ẩn, không phải mất.
   ============================================================ */

const BINS = [
  { id: "new", label: "Hộp đến", hint: "chờ phân loại" },
  { id: "queue", label: "Hàng đọc", hint: "chắc chắn liên quan" },
  { id: "maybe", label: "Có thể", hint: "rà soát định kỳ" },
  { id: "doubt", label: "Ngờ vực", hint: "loại nhưng chưa chắc" },
  { id: "applied", label: "Đã nộp", hint: "" },
  { id: "killed", label: "Đã loại", hint: "" },
  { id: "archived", label: "Lưu trữ", hint: "quá hạn" },
];

const channels = (j) => j.channels || [];
/* Chỉ thấy ở trang tuyển dụng của công ty = tin chưa lên board = ít cạnh tranh hơn. */
const isEarly = (j) => { const c = channels(j); return c.length === 1 && c[0] === "Trang công ty"; };

/* Ngày theo giờ máy, YYYY-MM-DD. */
const ymd = (d) => new Date(d).toLocaleDateString("sv-SE");
const today = () => ymd(Date.now());
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const ageDays = (iso) => daysBetween(ymd(iso), today());
/* Phát hiện nguồn chết (SPEC §4): đã bật/đã kéo mà 7 ngày không có tin MỚI. Nhiều khả năng parser gãy,
   không phải thị trường im. Chưa từng có tin mới thì tính từ lần kéo đầu. */
const DEAD_DAYS = 7;
const deadFor = (x) => {
  if (!x.lastPull) return null;
  const since = x.lastNewAt || x.firstPull || x.lastPull;
  const d = ageDays(since);
  return d >= DEAD_DAYS ? d : null;
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) : null);

/* ============================= APP ============================= */
export default function App() {
  const [jobs, setJobs] = useState([]);
  const [conf, setConf] = useState(null);
  const [view, setView] = useState("new");
  const [ready, setReady] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [toast, setToast] = useState("");
  const [pull, setPull] = useState(null);
  const [sort, setSort] = useState("newest"); // dùng chung cho mọi thùng, đổi thùng không mất

  const reload = useCallback(async () => {
    const [j, rules, companies, sources, settings] = await Promise.all([
      api.jobs(), api.rules(), api.companies(), api.sources(), api.settings(),
    ]);
    setJobs(j);
    setConf({ rules, companies, sources, ...settings });
    return settings;
  }, []);

  /* Lệnh ghi lỗi: báo, rồi đọc lại từ server để bỏ phần cập nhật lạc quan. */
  const fail = useCallback((e) => {
    setToast(`Không lưu được: ${e.message}`);
    reload().catch(() => {});
  }, [reload]);

  /* ---------- load ---------- */
  useEffect(() => {
    (async () => {
      try {
        // auto-archive: Có thể / Ngờ vực nằm trong thùng quá hạn
        const { moved } = await api.archiveStale();
        const s = await reload();
        setReady(true);
        // Tự kéo nếu lần gần nhất quá 12 tiếng — cùng cơ chế với sao lưu, server quyết, không có lịch.
        const p = await api.pullIfStale();
        setPull(p);
        const notes = [];
        if (moved) notes.push(`${moved} tin nằm trong thùng quá ${s.maybeTTL} ngày đã chuyển sang Lưu trữ`);
        if (s.backupError) notes.push(`Sao lưu thất bại: ${s.backupError}`);
        if (p.started) notes.push("Quá 12 tiếng chưa kéo — đang kéo nguồn ở nền");
        if (notes.length) setToast(notes.join(" · "));
      } catch (e) {
        setLoadErr("Không kết nối được server. Chạy npm run ui rồi tải lại trang.");
      }
    })();
  }, [reload]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  /* Đang kéo: hỏi server mỗi 2 giây và tải lại tin, nên Hộp đến đầy dần. Xong thì dừng hỏi và toast.
     Vòng hỏi chỉ sống khi đang kéo — không phải scheduler. */
  useEffect(() => {
    if (!pull?.running) return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const p = await api.pullStatus();
        if (!alive) return;
        setPull(p);
        await reload();
        if (!p.running) setToast(`Kéo xong: ${summarize(p.results || [])}`);
      } catch (e) { if (alive) setToast(`Mất liên lạc khi kéo: ${e.message}`); }
    }, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [pull?.running, reload]);

  const startPull = useCallback(async () => {
    try {
      const p = await api.pull();
      setPull(p);
      if (!p.started) setToast("Đang kéo rồi, chờ xong.");
    } catch (e) { fail(e); }
  }, [fail]);

  const detectAts = useCallback(async (id) => {
    const r = await api.detectAts(id);
    setConf((c) => ({ ...c, companies: c.companies.map((x) => (x.id === id ? r.company : x)) }));
    return r.result;
  }, []);

  const resolveCandidate = useCallback((id, accept) => {
    api.resolveCandidate(id, accept)
      .then((company) => setConf((c) => ({ ...c, companies: c.companies.map((x) => (x.id === id ? company : x)) })))
      .catch(fail);
  }, [fail]);

  const counts = useMemo(() => {
    const m = {};
    for (const b of BINS) m[b.id] = 0;
    for (const j of jobs) m[j.status] = (m[j.status] || 0) + 1;
    return m;
  }, [jobs]);

  /* ---------- actions ---------- */
  const move = useCallback((id, status) => {
    setJobs((js) => js.map((x) => (x.id === id ? { ...x, status, decidedBy: "human" } : x)));
    api.decide(id, status)
      .then(({ job, canUndo }) => {
        setJobs((js) => js.map((x) => (x.id === id ? job : x)));
        setConf((c) => ({ ...c, canUndo }));
      })
      .catch(fail);
  }, [fail]);

  const undo = useCallback(() => {
    api.undo()
      .then((r) => {
        setConf((c) => ({ ...c, canUndo: r.canUndo }));
        if (r.nothing) { setToast("Không còn gì để hoàn tác"); return; }
        setJobs((js) => js.map((x) => (x.id === r.job.id ? r.job : x)));
        const bin = BINS.find((b) => b.id === r.job.status);
        const why = r.ruleOff ? " (luật cũ đã tắt)" : "";
        setToast(`Đã hoàn tác: ${r.job.title} · ${r.job.company} → ${bin ? bin.label : r.job.status}${why}`);
      })
      .catch(fail);
  }, [fail]);

  const ingest = useCallback(async (source, items) => {
    const r = await api.ingest(source, items);
    await reload();
    const skipped = r.skipped ? ` · ${r.skipped} dòng thiếu chức danh hoặc công ty` : "";
    setToast(`Thêm ${r.added} tin · ${r.auto} bị luật xử lý · ${r.dup} trùng đã gộp nguồn${skipped}`);
    return r.added;
  }, [reload]);

  /* ---------- rule toggle → hồi sinh ---------- */
  const toggleRule = useCallback(async (ruleId) => {
    try {
      const { enabled, revived } = await api.toggleRule(ruleId);
      await reload();
      if (enabled) return;
      const parts = [];
      if (revived.new) parts.push(`${revived.new} tin bị luật này xử lý đã quay về Hộp đến`);
      if (revived.maybe) parts.push(`${revived.maybe} tin đã lưu trữ về Có thể`);
      setToast(parts.length ? parts.join(" · ") : "Đã tắt luật. Không có tin nào cần hồi sinh.");
    } catch (e) { fail(e); }
  }, [reload, fail]);

  const editRule = useCallback((ruleId, patch) => {
    setConf((c) => ({ ...c, rules: c.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)) }));
    api.patchRule(ruleId, patch)
      .then((rule) => setConf((c) => ({
        ...c, rules: c.rules.map((r) => (r.id === ruleId ? { ...r, needsRerun: rule.needsRerun } : r)),
      })))
      .catch(fail);
  }, [fail]);

  const addRule = useCallback(() => {
    api.createRule().then((rule) => setConf((c) => ({ ...c, rules: [...c.rules, rule] }))).catch(fail);
  }, [fail]);

  const rerun = useCallback(async () => {
    try {
      const { touched } = await api.rerun();
      await reload();
      setToast(`Chạy lại luật: ${touched} tin đổi trạng thái`);
    } catch (e) { fail(e); }
  }, [reload, fail]);

  const markSweep = useCallback(() => {
    api.sweep()
      .then((s) => { setConf((c) => ({ ...c, lastSweep: s.lastSweep })); setToast("Đã ghi nhận buổi rà soát hôm nay"); })
      .catch(fail);
  }, [fail]);

  const addCompany = useCallback((name, tier = "") => {
    if (!name.trim()) return;
    api.addCompany(name, tier)
      .then(() => api.companies())
      .then((companies) => setConf((c) => ({ ...c, companies })))
      .catch(fail);
  }, [fail]);

  const seedCompanies = useCallback(() => {
    api.seedCompanies()
      .then(() => api.companies())
      .then((companies) => setConf((c) => ({ ...c, companies })))
      .catch(fail);
  }, [fail]);

  const patchCompany = useCallback((id, patch) => {
    setConf((c) => ({ ...c, companies: c.companies.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
    api.patchCompany(id, patch).catch(fail);
  }, [fail]);

  const toggleSource = useCallback((id, alert) => {
    setConf((c) => ({ ...c, sources: c.sources.map((x) => (x.id === id ? { ...x, alert } : x)) }));
    api.patchSource(id, { alert }).catch(fail);
  }, [fail]);

  if (!ready || !conf) {
    return <div style={{ padding: 40, fontFamily: "system-ui", color: "#6A757F" }}>{loadErr || "Đang mở bàn làm việc…"}</div>;
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
          <button className="ghost" onClick={undo} disabled={!conf.canUndo}>Hoàn tác</button>
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
              rules={conf.rules} sort={sort} setSort={setSort} />
          )}
          {view === "sweep" && <Sweep jobs={jobs} move={move} conf={conf} markSweep={markSweep} />}
          {view === "find" && <Find ingest={ingest} pull={pull} startPull={startPull} conf={conf} />}
          {view === "companies" && <Companies list={conf.companies} jobs={jobs} add={addCompany}
            seed={seedCompanies} patch={patchCompany} detect={detectAts} resolve={resolveCandidate} setToast={setToast} />}
          {view === "sources" && <Sources sources={conf.sources} toggle={toggleSource} jobs={jobs} />}
          {view === "rules" && <Rules rules={conf.rules} jobs={jobs} toggleRule={toggleRule} editRule={editRule}
            addRule={addRule} rerun={rerun} />}
          {view === "data" && <Data jobs={jobs} conf={conf} setToast={setToast} />}
        </main>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ========================= TRIAGE ========================= */
/* Không hiện mô tả công việc ở đây — ràng buộc thiết kế, không phải thiếu sót. */
function Triage({ jobs, move, undo }) {
  const [i, setI] = useState(0);
  const job = jobs[i] || jobs[0];

  useEffect(() => { if (i >= jobs.length) setI(Math.max(0, jobs.length - 1)); }, [jobs.length, i]);

  const act = useCallback((status) => { if (job) move(job.id, status); }, [job, move]);

  useEffect(() => {
    const h = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      // Cmd+1..4 là phím chuyển tab của trình duyệt — không được phân loại nhầm tin.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
        body="Luật đã xử lý hết, hoặc chưa có tin nào vào. Sang tab Tìm job để dán đợt mới." />
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
          <span>vào {ymd(job.foundAt)}</span>
        </div>
        <div className="srcLine">
          <span className="srcLbl">Thấy ở</span>
          {channels(job).map((c) => <span key={c} className="chip">{c}</span>)}
          {isEarly(job) && <span className="chip early">chưa lên board — ít cạnh tranh</span>}
          {job.closedAt && <span className="chip closed">đã đóng {ymd(job.closedAt)}</span>}
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
function BinList({ bin, jobs: unsorted, move, rules, sort, setSort }) {
  const all = useMemo(() => sortJobs(unsorted, sort), [unsorted, sort]);
  const meta = BINS.find((b) => b.id === bin);
  const ruleName = (id) => (rules.find((r) => r.id === id) || {}).label || "luật không rõ";
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
      <div className="filterRow">
        <span className="dim small">xếp theo</span>
        {SORTS.map((s) => (
          <button key={s.id} className={"chipBtn" + (sort === s.id ? " on" : "")} onClick={() => setSort(s.id)}>{s.label}</button>
        ))}
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
              {j.closedAt && <span className="chip closed">đã đóng {ymd(j.closedAt)}</span>}
              {j.deadline && <span className={"tagDl" + (j.deadline < today() ? " past" : "")}>hạn {j.deadline}</span>}
              {j.location && <span>{j.location}</span>}
              {j.adLanguage === "fi" && <span className="tagFi">tiếng Phần Lan</span>}
              <span>{ymd(j.foundAt)}</span>
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
function Sweep({ jobs, move, conf, markSweep }) {
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
      <button className="primary" onClick={markSweep}>
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
              {/* Hai tuổi khác nhau: tin hồi sinh có thể 51 ngày tuổi mà mới nằm trong thùng 3 ngày. */}
              <span>{ageDays(j.statusAt)} ngày trong thùng</span>
              <span>tin {ageDays(j.foundAt)} ngày tuổi</span>
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
/* Kéo nguồn đã cấu hình (ATS của công ty, email alert) + dán tay.
   Chế độ "Tự tìm" bằng web search của bản artifact vẫn chưa làm. */
function Find({ ingest, pull, startPull, conf }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [raw, setRaw] = useState("");
  const [pasteSrc, setPasteSrc] = useState("LinkedIn");

  const parsePaste = async () => {
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
        adLanguage: /[äöå]/i.test(l) ? "fi" : "en",
      });
    }
    if (!out.length) { setErr("Không tách được dòng nào. Mỗi dòng cần: Chức danh | Công ty | Địa điểm | Link"); return; }
    setBusy(true);
    try {
      await ingest(pasteSrc, out);
      setRaw(""); setErr("");
    } catch (e) {
      setErr(`Không nạp được: ${e.message}`);
    }
    setBusy(false);
  };

  const atsCount = conf.companies.filter((c) => c.ats && c.ats !== "manual").length;
  const results = pull?.results || [];

  return (
    <div className="pane">
      <h2>Tìm job</h2>

      <div className="pullBox">
        <div className="pullHead">
          <button className="primary" onClick={startPull} disabled={!!pull?.running}>
            {pull?.running ? "Đang kéo…" : "Kéo ngay"}
          </button>
          <span className="dim">
            {pull?.lastPull ? <>Kéo gần nhất: <b>{fmtTime(pull.lastPull)}</b></> : "Chưa kéo lần nào"}
            {" · "}{atsCount} công ty có ATS
          </span>
        </div>
        {pull?.error && <p className="err">Lần kéo gần nhất hỏng: {pull.error}</p>}
        {!atsCount && (
          <p className="advice">
            Chưa có công ty nào dò được ATS. Sang tab Công ty, điền link trang tuyển dụng rồi bấm “Dò ATS”.
            Mở app quá 12 tiếng kể từ lần kéo trước thì app tự kéo, không cần nhớ.
          </p>
        )}
        {results.length > 0 && (
          <table className="yield">
            <thead>
              <tr><th>Nguồn</th><th>Feed</th><th>Giữ</th><th>Ngoài phạm vi</th><th>Mới</th><th>Luật</th><th>Trùng</th><th>Đóng</th></tr>
            </thead>
            <tbody>
              {results.map((r, i) => {
                const blind = r.kind === "ats" && !r.error && r.total > 0 && r.kept === 0;
                return (
                  <tr key={i} className={r.error ? "bad" : blind ? "blind" : ""}>
                    <td>{r.name}{r.platform ? <span className="dim"> · {r.platform}</span> : ""}
                      {r.error && <div className="errSm">{r.error}</div>}
                      {blind && <div className="errSm">0 giữ trên {r.total} tin — xem chuỗi địa điểm trong feed: có thể định dạng không khớp danh sách lọc, hoặc họ không có việc ở Phần Lan lúc này.</div>}
                    </td>
                    <td>{r.kind === "ats" ? r.total : ""}{r.notModified ? <span className="dim"> ={""}</span> : ""}</td>
                    <td>{r.kind === "ats" ? r.kept : ""}</td>
                    <td>{r.kind === "ats" ? r.dropped : ""}</td>
                    <td>{r.added}</td>
                    <td>{r.auto}</td>
                    <td>{r.dup}</td>
                    <td>{r.closed || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {results.length > 0 && (
          <p className="dim small">
            Lọc địa điểm theo: <code>{conf.pullLocations}</code>. Đây là chỗ duy nhất tin bị bỏ trước khi vào DB, nên số “ngoài phạm vi” luôn hiện ở đây.
            “=” nghĩa là feed không đổi từ lần trước.
          </p>
        )}
      </div>

      <h3 className="grp">Dán hàng loạt</h3>
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
      <button className="primary" onClick={parsePaste} disabled={busy}>Đưa vào Hộp đến</button>
      {err && <p className="err">{err}</p>}
    </div>
  );
}

/* ========================= COMPANIES ========================= */
const TIERS = [["", "chưa xếp"], ["a", "A — rất muốn"], ["b", "B — hợp lý"], ["c", "C — mở"], ["consult", "Consultancy"]];

const ATS_LABEL = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", recruitee: "Recruitee", smartrecruiters: "SmartRecruiters", workable: "Workable", personio: "Personio", teamtailor: "Teamtailor" };

function Companies({ list, jobs, add, seed, patch, detect, resolve, setToast }) {
  const [name, setName] = useState("");
  const [detecting, setDetecting] = useState(null);

  const runDetect = async (c) => {
    setDetecting(c.id);
    try {
      const r = await detect(c.id);
      setToast(r.platform === "manual"
        ? `${c.name}: không dò ra ATS (${r.error}). Để email alert lo.`
        : `${c.name}: ${ATS_LABEL[r.platform] || r.platform} · ${r.total} tin trong feed${r.guessed ? " (đoán từ tên, đã xác nhận)" : ""}`);
    } catch (e) { setToast(`Dò ATS thất bại: ${e.message}`); }
    setDetecting(null);
  };

  const seen = useMemo(() => {
    const m = new Map();
    for (const j of jobs) { const k = norm(j.company); m.set(k, (m.get(k) || 0) + 1); }
    return m;
  }, [jobs]);
  const jobCount = (n) => seen.get(norm(n)) || 0;

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
            <div className="rowMeta">
              {!c.ats && <span className="dim">chưa dò ATS</span>}
              {c.ats === "manual" && <span className="tagRule">không có ATS · email alert lo</span>}
              {c.ats && c.ats !== "manual" && <span className="chip">{ATS_LABEL[c.ats] || c.ats} · {c.atsToken}</span>}
              {c.lastPull && <span>kéo {fmtTime(c.lastPull)}</span>}
              {c.pullTotal != null && <span>{c.pullTotal} tin · {c.pullCount} giữ</span>}
              {c.lastNewAt && <span>tin mới gần nhất {ymd(c.lastNewAt)}</span>}
              {c.lastError && <span className="errSm">lỗi: {c.lastError}</span>}
              {c.ats && c.ats !== "manual" && deadFor(c) && (
                <span className="warnLine">{deadFor(c)} ngày không có tin mới từ feed. Bấm “Dò lại ATS” để chắc token còn đúng.</span>
              )}
            </div>
            {c.atsCandidate && (
              <div className="candidate">
                <span className="candLbl">Ứng viên (link do máy đoán, chưa dùng):</span>
                {c.atsCandidate.platform === "manual"
                  ? <span>không dò ra ATS{c.atsCandidate.error ? ` · ${c.atsCandidate.error}` : ""}</span>
                  : <span className="chip">{ATS_LABEL[c.atsCandidate.platform] || c.atsCandidate.platform} · {c.atsCandidate.token} · {c.atsCandidate.total} tin</span>}
                {c.atsCandidate.url && <a href={c.atsCandidate.url} target="_blank" rel="noreferrer">{c.atsCandidate.url.replace(/^https?:\/\//, "")}</a>}
                <button className="go" onClick={() => resolve(c.id, true)}>Xác nhận</button>
                <button className="off" onClick={() => resolve(c.id, false)}>Sai</button>
              </div>
            )}
          </div>
          <div className="rowActs">
            <button onClick={() => runDetect(c)} disabled={detecting === c.id || !c.url}
              title={c.url ? "" : "Điền link trang tuyển dụng trước"}>
              {detecting === c.id ? "Đang dò…" : c.ats ? "Dò lại ATS" : "Dò ATS"}
            </button>
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

function Sources({ sources, toggle, jobs }) {
  const done = sources.filter((s) => s.alert).length;
  const dead = sources.filter((s) => s.alert && deadFor(s));

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

      {dead.length > 0 && (
        <p className="advice warnBox">
          <b>{dead.length} nguồn đang bật alert mà {DEAD_DAYS} ngày không ra tin mới:</b> {dead.map((s) => s.name).join(", ")}.
          Đây là kiểu hỏng nguy hiểm nhất — hệ thống trông vẫn chạy trong khi đã mù một mắt.
        </p>
      )}

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
        Đã bật <b>{done}/{sources.length}</b>.
      </p>
      {Object.keys(KINDS).map((k) => (
        <div key={k}>
          <h3 className="grp">{KINDS[k]}</h3>
          {sources.filter((s) => s.kind === k).map((s) => {
            const dead = s.alert ? deadFor(s) : null;
            return (
              <label key={s.id} className={"srcRow" + (dead ? " dead" : "")}>
                <input type="checkbox" checked={s.alert} onChange={() => toggle(s.id, !s.alert)} />
                <span className="srcName">{s.name}
                  {s.lastPull && <span className="srcMeta">
                    {" · "}kéo {fmtTime(s.lastPull)}
                    {s.lastNewAt ? ` · tin mới gần nhất ${ymd(s.lastNewAt)}` : " · chưa có tin mới nào"}
                  </span>}
                  {dead && <span className="warnLine">{dead} ngày không có tin mới. Alert của {s.name} có thể đã tắt, mail lọt filter, hoặc parser gãy — kiểm hộp thư trước khi tin là thị trường im.</span>}
                  {s.lastError && <span className="errSm">lỗi: {s.lastError}</span>}
                </span>
                <a href={s.url} target="_blank" rel="noreferrer">{s.url.replace(/^https?:\/\//, "")}</a>
              </label>
            );
          })}
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
function Rules({ rules, jobs, toggleRule, editRule, addRule, rerun }) {
  // Cùng điều kiện với hồi sinh ở server: số hiện ra = số tin quay về khi tắt luật.
  const stat = (id) => jobs.filter((j) => j.killedBy === id && j.decidedBy === "rule").length;
  const total = jobs.length || 1;

  return (
    <div className="pane">
      <h2>Luật</h2>
      <p className="advice">
        Mỗi tin bị luật xử lý đều ghi lại <b>luật nào</b> đã xử lý nó. Tắt một luật thì toàn bộ tin nó
        từng xử lý quay về Hộp đến. Vì sai lầm hoàn tác được theo lô, mày có thể viết luật mạnh tay —
        mà luật mạnh tay chính là thứ làm phân loại nhanh.
      </p>
      <p className="advice">
        Từ khóa khớp nguyên từ: <code>ux</code> không dính <code>Linux</code>. Thêm <code>*</code> ở đầu
        hoặc cuối để khớp một phần từ — cần cho từ ghép và biến cách tiếng Phần Lan:
        <code>myynti*</code>, <code>*kehittäjä*</code>.
      </p>
      <button className="ghost" onClick={rerun}>Chạy lại toàn bộ luật</button>

      {rules.map((r) => {
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
                <option value="location">địa điểm</option>
                <option value="lang">ngôn ngữ tin</option>
                <option value="any">bất kỳ đâu</option>
              </select>
              <span className="dim">chứa</span>
              <input className="ruleMatch" value={r.match} placeholder="từ khóa, cách nhau bằng dấu phẩy · *từ* khớp một phần từ"
                onChange={(e) => editRule(r.id, { match: e.target.value })} />
              <select value={r.action} onChange={(e) => editRule(r.id, { action: e.target.value })}>
                <option value="kill">thì loại</option>
                <option value="doubt">thì đưa vào Ngờ vực</option>
              </select>
            </div>
            {r.note && <p className="ruleNote">{r.note}</p>}
            <div className="ruleStat">
              {n > 0 ? <>Đang xử lý <b>{n}</b> tin. Tắt luật này thì cả {n} tin quay về Hộp đến.</> : "Chưa xử lý tin nào."}
              {r.enabled && r.needsRerun && (
                <span className="warn">Chưa chạy trên tin cũ — tin mới nạp đã áp dụng. Bấm “Chạy lại toàn bộ luật”.</span>
              )}
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
/* Không có "Ghi đè bằng dữ liệu này" như bản artifact: ghi đè nghĩa là xóa tin. */
function Data({ jobs, conf, setToast }) {
  const download = async () => {
    try {
      const dump = await api.exportAll();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `job-pipeline-${today()}.json`;
      a.click();
    } catch (e) {
      setToast(`Không xuất được: ${e.message}`);
    }
  };

  const lastBackup = conf.lastBackupAt
    ? new Date(conf.lastBackupAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })
    : null;

  return (
    <div className="pane">
      <h2>Dữ liệu</h2>
      <p className="advice">
        Dữ liệu nằm ở <code>data/jobs.db</code>. App tự sao lưu vào <code>data/backups/</code> khi bản gần
        nhất cũ quá 24 giờ, giữ 30 bản — không cần nhớ làm gì.
        {lastBackup && <> Sao lưu gần nhất: <b>{lastBackup}</b>.</>}
      </p>
      {conf.backupError && <p className="err">Sao lưu thất bại: {conf.backupError}</p>}
      <div className="stats">
        <div><b>{jobs.length}</b><span>tin đã vào hệ thống</span></div>
        <div><b>{jobs.filter((j) => j.status === "applied").length}</b><span>đã nộp</span></div>
        <div><b>{conf.companies.length}</b><span>công ty theo dõi</span></div>
        <div><b>{conf.sources.filter((s) => s.alert).length}</b><span>nguồn đã bật alert</span></div>
      </div>
      <button className="primary" onClick={download}>Tải file sao lưu</button>
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
.chip.closed{background:#EADADA;color:#7A2E2E}
.pullBox{display:flex;flex-direction:column;gap:10px;background:var(--surface);border:1px solid var(--line);
border-radius:6px;padding:14px 16px}
.pullHead{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.pullHead .primary{align-self:center}
.errSm{color:#9A2C1E;font-size:12px}
.candidate{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;margin-top:6px;
padding:6px 10px;background:#FBF3E4;border-radius:5px;border-left:2px solid var(--amber)}
.candLbl{color:var(--amber)}
.candidate button{background:none;border:1px solid var(--line);padding:3px 9px;border-radius:5px;cursor:pointer;font-size:12.5px}
.candidate button.go{border-color:var(--signal);color:var(--signal)}
.candidate button.off{color:var(--muted)}
.small{font-size:12.5px;margin:0}
.yield tr.bad td{color:#9A2C1E}
.yield tr.blind td{color:var(--amber)}
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
.tagDl{background:#DDE6EE;color:var(--signal);padding:1px 6px;border-radius:3px}
.tagDl.past{background:#EADADA;color:#7A2E2E}
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
.srcRow.dead{border-color:var(--amber)}
.srcMeta{font-weight:400;font-size:12.5px;color:var(--muted)}
.warnLine{display:block;font-weight:400;font-size:12.5px;color:var(--amber);margin-top:2px}
.advice.warnBox{border-left-color:var(--amber);background:#FBF3E4}

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
