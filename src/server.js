import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { queryInfo } from "./a2s.js";
import { Store } from "./store.js";
import { Monitor } from "./monitor.js";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const POLL_MS = Math.max(5, Number(process.env.POLL_SECONDS ?? 30)) * 1000;
const DEFAULT_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const INDEX_HTML = fs.readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)));

const store = new Store(DATA_DIR);
const monitor = new Monitor({ query: queryInfo, defaultWebhook: DEFAULT_WEBHOOK, pollMs: POLL_MS });
store.list().forEach((s) => monitor.start(s));

function authorized(req) {
  if (!ADMIN_PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const given = Buffer.from(m[1], "base64").toString("utf8").split(":").slice(1).join(":");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function view(s) {
  return {
    id: s.id,
    host: s.host,
    queryPort: s.queryPort,
    hasWebhook: Boolean(s.webhookUrl), // never echo the webhook URL back
    ...monitor.status(s.id),
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return reject(Object.assign(new Error("content-type must be application/json"), { status: 415 }));
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 10_000) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
  });
}

function reply(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") return reply(res, 200, { ok: true });
    if (!authorized(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="dayz-watch"' });
      return res.end();
    }
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/") return reply(res, 200, INDEX_HTML, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/servers") {
      return reply(res, 200, { defaultWebhook: Boolean(DEFAULT_WEBHOOK), servers: store.list().map(view) });
    }
    if (req.method === "POST" && url.pathname === "/api/servers") {
      const input = await readJson(req);
      if (!input.webhookUrl && !DEFAULT_WEBHOOK) {
        return reply(res, 400, { error: "webhook URL required (no DISCORD_WEBHOOK_URL default configured)" });
      }
      const s = store.add(input);
      monitor.start(s);
      return reply(res, 201, view(s));
    }
    const del = req.method === "DELETE" && /^\/api\/servers\/([\w-]+)$/.exec(url.pathname);
    if (del) {
      if (!store.remove(del[1])) return reply(res, 404, { error: "not found" });
      monitor.stop(del[1]);
      return reply(res, 200, { ok: true });
    }
    reply(res, 404, { error: "not found" });
  } catch (e) {
    const status = e.status ?? (/^(invalid|webhook|server already)/.test(e.message) ? 400 : 500);
    if (status === 500) console.error(e);
    reply(res, status, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`dayz-watch listening on :${PORT}, ${store.list().length} server(s), poll ${POLL_MS / 1000}s`);
  if (!ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD not set: web UI is unauthenticated");
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
