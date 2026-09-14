import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer as createVite } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.PORT) || 5173;

const app = express();
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);
const vite = await createVite({
  configFile: path.join(ROOT, "vite.config.js"),
  server: { middlewareMode: true, hmr: { server } },
  appType: "spa",
});
app.use(vite.middlewares);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Bàn phân loại: http://127.0.0.1:${PORT}`);
});
