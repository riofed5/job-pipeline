import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer as createVite } from "vite";
import { openDb, createBackups, exportAll } from "../core/db.js";
import * as jobs from "../core/jobs.js";
import * as config from "../core/config.js";
import { manualSource } from "../ingest/normalize.js";

/* Route mỏng: không có SQL ở đây, mọi thứ đi qua core/. Không có route xóa. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.PORT) || 5173;
const DATA = process.env.DATA_DIR || path.join(ROOT, "data");

const db = openDb(path.join(DATA, "jobs.db"));
const backups = createBackups(db, path.join(DATA, "backups"));
backups.runIfStale(); // sao lưu trước khi phục vụ

const app = express();
app.use(express.json({ limit: "2mb" }));

// Mỗi request ghi: bản sao lưu gần nhất quá 24 giờ thì sao lưu trước. Server có thể chạy nhiều ngày liền.
app.use("/api", (req, res, next) => {
  if (req.method !== "GET") backups.runIfStale();
  next();
});

/* ---------- đọc ---------- */
app.get("/api/jobs", (req, res) => res.json(jobs.listJobs(db)));
app.get("/api/rules", (req, res) => res.json(config.listRules(db)));
app.get("/api/companies", (req, res) => res.json(config.listCompanies(db)));
app.get("/api/sources", (req, res) => res.json(config.listSources(db)));
app.get("/api/settings", (req, res) =>
  res.json({ ...config.getSettings(db), canUndo: jobs.canUndo(db), ...backups.status() }));
app.get("/api/export", (req, res) => res.json(exportAll(db)));

/* ---------- tin ---------- */
app.post("/api/ingest", (req, res) => {
  const { source, items } = req.body ?? {};
  res.json(jobs.ingest(db, items, manualSource(source)));
});
app.post("/api/jobs/:id/status", (req, res) =>
  res.json({ job: jobs.decide(db, req.params.id, req.body?.status), canUndo: jobs.canUndo(db) }));
app.post("/api/undo", (req, res) => res.json({ ...jobs.undo(db), canUndo: jobs.canUndo(db) }));
app.post("/api/archive-stale", (req, res) => res.json(jobs.archiveStale(db)));

/* ---------- luật ---------- */
app.post("/api/rules", (req, res) => res.json(config.createRule(db)));
app.patch("/api/rules/:id", (req, res) => res.json(config.patchRule(db, req.params.id, req.body)));
app.post("/api/rules/:id/toggle", (req, res) => res.json(jobs.toggleRule(db, req.params.id)));
app.post("/api/rules/rerun", (req, res) => res.json(jobs.rerunRules(db)));

/* ---------- công ty, nguồn, rà soát ---------- */
app.post("/api/companies", (req, res) => res.json(config.addCompany(db, req.body)));
app.post("/api/companies/seed", (req, res) => res.json(config.seedCompanies(db)));
app.patch("/api/companies/:id", (req, res) => res.json(config.patchCompany(db, req.params.id, req.body)));
app.patch("/api/sources/:id", (req, res) => res.json(config.patchSource(db, req.params.id, req.body)));
app.post("/api/sweep", (req, res) => res.json(config.markSweep(db)));

app.use("/api", (req, res) => res.status(404).json({ error: "không có route này" }));
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

/* ---------- UI ---------- */
const server = http.createServer(app);
const vite = await createVite({
  configFile: path.join(ROOT, "vite.config.js"),
  server: { middlewareMode: true, hmr: { server } },
  appType: "spa",
});
app.use(vite.middlewares);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Bàn phân loại: http://127.0.0.1:${PORT}`);
});
