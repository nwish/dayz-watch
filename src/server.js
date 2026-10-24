import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryInfo } from "./a2s.js";
import { Directory, DEFAULT_DIRECTORY_URL } from "./directory.js";
import { Stats } from "./stats.js";
import { Store } from "./store.js";
import { Monitor } from "./monitor.js";
import { AuthError, FailureLimiter, SessionStore, UserStore, bootstrapAdmin, validatePassword } from "./auth.js";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const POLL_MS = Math.max(5, Number(process.env.POLL_SECONDS ?? 30)) * 1000;
const OFFLINE_AFTER = Math.max(1, Math.floor(Number(process.env.OFFLINE_AFTER)) || 3); // consecutive failed polls before a server counts as offline
const DEFAULT_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;
const directory = new Directory({ url: process.env.DIRECTORY_URL || DEFAULT_DIRECTORY_URL });
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const COOKIE_NAME = "dw_session";
const page = (name) => fs.readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)));
const INDEX_HTML = page("index.html");
const LOGIN_HTML = page("login.html");
const FAVICON = page("favicon.svg");
const STATS_HTML = page("stats.html");
const ADMIN_HTML = page("admin.html");

const FIFTEEN_MIN = 15 * 60e3;
const store = new Store(DATA_DIR);
const users = new UserStore(DATA_DIR);
const sessions = new SessionStore();
const ipLimiter = new FailureLimiter({ max: 20, windowMs: FIFTEEN_MIN, lockMs: FIFTEEN_MIN });
const userLimiter = new FailureLimiter({ max: 10, windowMs: FIFTEEN_MIN, lockMs: FIFTEEN_MIN });
setInterval(() => {
  sessions.sweep();
  ipLimiter.sweep();
  userLimiter.sweep();
}, 60_000).unref();

const generated = await bootstrapAdmin(users, {
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
});
if (generated) {
  console.log("================================================================");
  console.log(" No users existed: created admin account.");
  console.log(`   username: ${process.env.ADMIN_USERNAME || "admin"}`);
  console.log(`   password: ${generated}`);
  console.log(" This is shown once. Change it after logging in.");
  console.log("================================================================");
}

const stats = new Stats(path.join(DATA_DIR, "stats.db"));
stats.closeOpenOutages(); // an outage left open by the previous run can't be followed while we were down
stats.prune();
setInterval(() => stats.prune(), 60 * 60e3).unref(); // keep 90 days
const monitor = new Monitor({
  query: queryInfo,
  defaultWebhook: DEFAULT_WEBHOOK,
  pollMs: POLL_MS,
  offlineAfter: OFFLINE_AFTER,
  onSample: (s, sample) => stats.record(s.id, sample),
  onOutage: (s, kind, atMs) => (kind === "start" ? stats.outageStart(s.id, atMs / 1000) : stats.outageEnd(s.id, atMs / 1000)),
});
store.list().forEach((s) => monitor.start(s));

// ---- helpers ----

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",");
    const last = xff[xff.length - 1].trim(); // the hop our proxy appended; earlier entries are client-supplied
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionCookie(req, token, maxAgeSec) {
  const secure = COOKIE_SECURE || (TRUST_PROXY && req.headers["x-forwarded-proto"] === "https");
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

// Mutating requests from another origin are refused (SameSite=Strict on the cookie is the primary defence).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = (TRUST_PROXY && req.headers["x-forwarded-host"]) || req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return reject(new AuthError("content-type must be application/json", 415));
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 10_000) {
        reject(new AuthError("body too large", 413));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(body);
        if (v === null || typeof v !== "object") throw new Error();
        resolve(v);
      } catch {
        reject(new AuthError("invalid JSON", 400));
      }
    });
  });
}

function reply(res, status, body, type = "application/json", headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function redirect(res, location) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

// Everything the admin page shows besides the user list: runtime, file sizes, and the history DB.
function adminOverview() {
  const db = stats.dbStats();
  const known = new Map(store.list().map((s) => [s.id, s]));
  const rows = new Map(db.perServer.map((r) => [r.serverId, r]));
  const perServer = [...known.values()].map((s) => ({
    serverId: s.id,
    name: monitor.status(s.id).info?.name ?? null,
    address: `${s.host}:${s.queryPort}`,
    deleted: false,
    ...(rows.get(s.id) ?? { buckets: 0, polls: 0, ok: 0, first: null, last: null }),
  }));
  for (const r of db.perServer) if (!known.has(r.serverId)) perServer.push({ name: null, address: null, deleted: true, ...r }); // history for a server that no longer exists
  const size = (name) => {
    try {
      return fs.statSync(path.join(DATA_DIR, name)).size;
    } catch {
      return null;
    }
  };
  const mem = process.memoryUsage();
  const list = users.list();
  return {
    runtime: { node: process.version, uptimeSec: Math.round(process.uptime()), rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, pollSeconds: POLL_MS / 1000, dataDir: path.resolve(DATA_DIR) },
    counts: { servers: known.size, users: list.length, admins: list.filter((u) => u.role === "admin").length, activeSessions: sessions.count() },
    files: { serversJson: size("servers.json"), usersJson: size("users.json") },
    db: { ...db, perServer },
  };
}

function serverView(s) {
  return {
    id: s.id,
    host: s.host,
    queryPort: s.queryPort,
    hasWebhook: Boolean(s.webhookUrl), // never echo the webhook URL back
    ...monitor.status(s.id),
  };
}

// ---- routes ----

async function login(req, res) {
  const { username, password } = await readJson(req);
  const name = typeof username === "string" ? username.trim().toLowerCase().slice(0, 64) : "";
  const ip = clientIp(req);
  // Locked keys are refused before the password is even checked, so a lockout reveals nothing.
  const wait = Math.max(ipLimiter.retryAfter(ip), userLimiter.retryAfter(name));
  if (wait > 0) {
    return reply(res, 429, { error: `too many failed attempts, try again in ${Math.ceil(wait / 60)} min`, retryAfter: wait }, "application/json", {
      "retry-after": String(wait),
    });
  }
  const user = await users.verify(name, password);
  if (!user) {
    ipLimiter.fail(ip);
    userLimiter.fail(name);
    console.warn(`${new Date().toISOString()} failed login for "${name}" from ${ip}`);
    return reply(res, 401, { error: "invalid username or password" });
  }
  userLimiter.reset(name);
  users.touchLogin(user.username);
  const token = sessions.create(user.username);
  return reply(res, 200, { username: user.username, role: user.role }, "application/json", {
    "set-cookie": sessionCookie(req, token, sessions.maxMs / 1000),
  });
}

async function api(req, res, url, session) {
  const me = session.user;
  const { pathname } = url;
  const method = req.method;
  const requireAdmin = () => {
    if (me.role !== "admin") throw new AuthError("admin only", 403);
  };

  if (method === "GET" && pathname === "/api/me") return reply(res, 200, { username: me.username, role: me.role });

  if (method === "POST" && pathname === "/api/logout") {
    sessions.destroy(session.token);
    return reply(res, 200, { ok: true }, "application/json", { "set-cookie": sessionCookie(req, "", 0) });
  }

  if (method === "POST" && pathname === "/api/me/password") {
    const { currentPassword, newPassword } = await readJson(req);
    const key = `pw:${me.username}`;
    const wait = userLimiter.retryAfter(key);
    if (wait > 0) throw new AuthError(`too many failed attempts, try again in ${Math.ceil(wait / 60)} min`, 429);
    if (!(await users.verify(me.username, currentPassword))) {
      userLimiter.fail(key);
      throw new AuthError("current password is incorrect", 403);
    }
    userLimiter.reset(key);
    await users.setPassword(me.username, newPassword);
    sessions.destroyUser(me.username, session.token); // log out everywhere else
    return reply(res, 200, { ok: true });
  }

  // ---- servers (any signed-in user) ----
  if (method === "GET" && pathname === "/api/servers") {
    return reply(res, 200, { defaultWebhook: Boolean(DEFAULT_WEBHOOK), offlineAfter: OFFLINE_AFTER, servers: store.list().map(serverView) });
  }
  const statsReq = method === "GET" && /^\/api\/servers\/([\w-]+)\/stats$/.exec(pathname);
  if (statsReq) {
    const s = store.get(statsReq[1]);
    if (!s) return reply(res, 404, { error: "not found" });
    const tz = Number(url.searchParams.get("tz") ?? 0);
    const offset = Number.isFinite(tz) ? Math.max(-840, Math.min(840, tz)) : 0;
    return reply(res, 200, { server: serverView(s), ...stats.query(s.id, url.searchParams.get("range") ?? "7d", offset) });
  }
  if (method === "GET" && pathname === "/api/directory") {
    return reply(res, 200, { servers: await directory.search(url.searchParams.get("q"), Number(url.searchParams.get("limit"))) });
  }
  if (method === "POST" && pathname === "/api/servers") {
    const s = store.add(await readJson(req));
    monitor.start(s);
    return reply(res, 201, serverView(s));
  }
  const delServer = method === "DELETE" && /^\/api\/servers\/([\w-]+)$/.exec(pathname);
  if (delServer) {
    if (!store.remove(delServer[1])) return reply(res, 404, { error: "not found" });
    monitor.stop(delServer[1]);
    stats.remove(delServer[1]);
    return reply(res, 200, { ok: true });
  }

  // ---- admin overview (admin) ----
  if (method === "GET" && pathname === "/api/admin/overview") {
    requireAdmin();
    return reply(res, 200, adminOverview());
  }

  // ---- user management (admin) ----
  if (pathname === "/api/users" || pathname.startsWith("/api/users/")) {
    requireAdmin();
    if (method === "GET" && pathname === "/api/users") return reply(res, 200, { users: users.list() });
    if (method === "POST" && pathname === "/api/users") {
      const created = await users.create(await readJson(req));
      console.log(`${new Date().toISOString()} ${me.username} created user ${created.username} (${created.role})`);
      return reply(res, 201, created);
    }
    const target = /^\/api\/users\/([a-z0-9._-]+)$/.exec(pathname)?.[1];
    if (target && method === "PATCH") {
      const { role, password } = await readJson(req);
      if (role === undefined && password === undefined) throw new AuthError("nothing to change");
      if (target === me.username) throw new AuthError("use Account > change password, and you can't change your own role");
      if (!users.get(target)) throw new AuthError("user not found", 404);
      if (password !== undefined) validatePassword(password); // validate everything before applying anything
      if (role !== undefined) users.setRole(target, role);
      if (password !== undefined) {
        await users.setPassword(target, password);
        sessions.destroyUser(target);
      }
      console.log(`${new Date().toISOString()} ${me.username} updated user ${target}`);
      return reply(res, 200, users.get(target));
    }
    if (target && method === "DELETE") {
      if (target === me.username) throw new AuthError("you can't delete your own account");
      users.remove(target);
      sessions.destroyUser(target);
      console.log(`${new Date().toISOString()} ${me.username} deleted user ${target}`);
      return reply(res, 200, { ok: true });
    }
  }

  return reply(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    const url = new URL(req.url, "http://x");
    const { pathname } = url;
    if (pathname === "/healthz") return reply(res, 200, { ok: true });
    if (req.method === "GET" && pathname === "/favicon.svg") {
      return reply(res, 200, FAVICON, "image/svg+xml", { "cache-control": "public, max-age=86400" });
    }
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
      return reply(res, 403, { error: "cross-origin request blocked" });
    }
    if (req.method === "POST" && pathname === "/api/login") return await login(req, res);

    const token = parseCookies(req)[COOKIE_NAME];
    const s = sessions.get(token);
    const user = s && users.get(s.username);
    const session = user ? { token, user } : null;

    if (req.method === "GET" && pathname === "/login") {
      return session ? redirect(res, "/") : reply(res, 200, LOGIN_HTML, "text/html; charset=utf-8");
    }
    if (!session) {
      return pathname.startsWith("/api/") ? reply(res, 401, { error: "authentication required" }) : redirect(res, "/login");
    }
    if (req.method === "GET" && pathname === "/") return reply(res, 200, INDEX_HTML, "text/html; charset=utf-8");
    if (req.method === "GET" && pathname === "/admin") {
      return session.user.role === "admin" ? reply(res, 200, ADMIN_HTML, "text/html; charset=utf-8") : redirect(res, "/");
    }
    const statsPage = req.method === "GET" && /^\/servers\/([\w-]+)$/.exec(pathname);
    if (statsPage) return store.get(statsPage[1]) ? reply(res, 200, STATS_HTML, "text/html; charset=utf-8") : redirect(res, "/");
    if (pathname.startsWith("/api/")) return await api(req, res, url, session);
    reply(res, 404, { error: "not found" });
  } catch (e) {
    const status = e.status ?? (/^(invalid|webhook|server already)/.test(e.message) ? 400 : 500);
    if (status === 500) console.error(e);
    if (!res.headersSent) reply(res, status, { error: status === 500 ? "internal error" : e.message });
  }
});

server.listen(PORT, () => {
  console.log(`dayz-watch listening on :${PORT}, ${store.list().length} server(s), ${users.count()} user(s), poll ${POLL_MS / 1000}s`);
  if (!COOKIE_SECURE && !TRUST_PROXY) console.warn("Session cookie is not marked Secure (set COOKIE_SECURE=true when serving over HTTPS)");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stats.close(); // checkpoints the WAL so a container stop leaves a clean stats.db
    process.exit(0);
  });
}
