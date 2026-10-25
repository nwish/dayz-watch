// End-to-end auth tests: run the real server as a child process and talk to it over HTTP.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { fakeA2S } from "./fake-a2s.js";

const ADMIN_PW = "correct-horse-battery";
let proc;
let base;
let dataDir;
let dayz; // a fake DayZ server on loopback: servers can only be added if they answer
let dayzPort;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  dayz = await fakeA2S(() => 3);
  dayzPort = dayz.address().port;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-srv-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn("node", ["src/server.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: ADMIN_PW, ALLOW_PRIVATE_ADDRESSES: "true" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    proc.stdout.on("data", (d) => String(d).includes("listening") && resolve());
  });
});

after(async () => {
  dayz.close();
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  proc.kill();
  await exited; // the server holds stats.db open; Windows can't delete it until the process is gone
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Minimal cookie-jar client.
function client() {
  let cookie = "";
  const call = async (method, url, body, extra = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect: "manual",
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dw_session="));
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, set, text, json };
  };
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

async function loginAs(username, password) {
  const c = client();
  const r = await c.call("POST", "/api/login", { username, password });
  assert.equal(r.status, 200, `login ${username}: ${r.text}`);
  return c;
}

test("unauthenticated: pages redirect to /login, API is 401, /login and /healthz are open", async () => {
  const c = client();
  const root = await c.call("GET", "/");
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/login");
  assert.equal((await c.call("GET", "/api/servers")).status, 401);
  assert.equal((await c.call("GET", "/api/users")).status, 401);
  const login = await c.call("GET", "/login");
  assert.equal(login.status, 200);
  assert.match(login.text, /Sign in/);
  assert.equal((await c.call("GET", "/healthz")).status, 200);
});

test("login: bad password and unknown user are indistinguishable; success sets a hardened cookie", async () => {
  const c = client();
  const wrong = await c.call("POST", "/api/login", { username: "admin", password: "nope-nope-nope" });
  const ghost = await c.call("POST", "/api/login", { username: "ghost", password: "nope-nope-nope" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, ghost.json);
  assert.equal(ghost.status, 401);

  const ok = await c.call("POST", "/api/login", { username: "Admin", password: ADMIN_PW });
  assert.equal(ok.status, 200);
  assert.match(ok.set, /HttpOnly/);
  assert.match(ok.set, /SameSite=Strict/);
  assert.deepEqual((await c.call("GET", "/api/me")).json, { username: "admin", role: "admin" });
  assert.equal((await c.call("GET", "/")).status, 200);
  assert.equal((await c.call("GET", "/login")).status, 302); // already signed in
});

test("requests that aren't same-origin JSON are rejected", async () => {
  const admin = await loginAs("admin", ADMIN_PW);
  const cross = await admin.call("POST", "/api/users", { username: "evil", password: "long enough pw!" }, { origin: "http://evil.example" });
  assert.equal(cross.status, 403);
  const form = await fetch(base + "/api/servers", {
    method: "POST",
    headers: { cookie: admin.cookie, "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(form.status, 415);
  assert.equal((await admin.call("GET", "/api/users")).json.users.some((u) => u.username === "evil"), false);
});

test("roles: users manage servers but not users; admins cannot lock themselves out", async () => {
  const admin = await loginAs("admin", ADMIN_PW);
  assert.equal((await admin.call("POST", "/api/users", { username: "bob", password: "bobs long password", role: "user" })).status, 201);
  assert.equal((await admin.call("POST", "/api/users", { username: "bob", password: "bobs long password" })).status, 409);
  assert.equal((await admin.call("POST", "/api/users", { username: "weak", password: "short" })).status, 400);

  const bob = await loginAs("bob", "bobs long password");
  assert.equal((await bob.call("GET", "/api/servers")).status, 200);
  for (const [m, u, b] of [["GET", "/api/users"], ["POST", "/api/users", { username: "x1x", password: "long enough pw!" }], ["PATCH", "/api/users/admin", { role: "user" }], ["DELETE", "/api/users/admin"]]) {
    assert.equal((await bob.call(m, u, b)).status, 403, `${m} ${u}`);
  }
  assert.equal((await admin.call("DELETE", "/api/users/admin")).status, 400);
  assert.equal((await admin.call("PATCH", "/api/users/admin", { role: "user" })).status, 400);
  assert.equal((await admin.call("PATCH", "/api/users/nobody", { role: "user" })).status, 404);
  // a bad password in a combined PATCH must not apply the role change
  assert.equal((await admin.call("PATCH", "/api/users/bob", { role: "admin", password: "short" })).status, 400);
  assert.equal((await admin.call("GET", "/api/users")).json.users.find((u) => u.username === "bob").role, "user");
});

test("admin reset password and delete revoke that user's sessions immediately", async () => {
  const admin = await loginAs("admin", ADMIN_PW);
  await admin.call("POST", "/api/users", { username: "dave", password: "daves long password" });
  const dave = await loginAs("dave", "daves long password");
  assert.equal((await dave.call("GET", "/api/me")).status, 200);

  assert.equal((await admin.call("PATCH", "/api/users/dave", { password: "a reset password" })).status, 200);
  assert.equal((await dave.call("GET", "/api/me")).status, 401);
  assert.equal((await client().call("POST", "/api/login", { username: "dave", password: "daves long password" })).status, 401);
  const dave2 = await loginAs("dave", "a reset password");

  assert.equal((await admin.call("DELETE", "/api/users/dave")).status, 200);
  assert.equal((await dave2.call("GET", "/api/me")).status, 401);
  assert.equal((await client().call("POST", "/api/login", { username: "dave", password: "a reset password" })).status, 401);
});

test("change own password: needs current password, signs out other sessions, keeps this one", async () => {
  const admin = await loginAs("admin", ADMIN_PW);
  await admin.call("POST", "/api/users", { username: "erin", password: "erins long password" });
  const here = await loginAs("erin", "erins long password");
  const elsewhere = await loginAs("erin", "erins long password");

  const bad = await here.call("POST", "/api/me/password", { currentPassword: "not my password", newPassword: "a fresh password" });
  assert.equal(bad.status, 403);
  assert.equal((await here.call("POST", "/api/me/password", { currentPassword: "erins long password", newPassword: "tiny" })).status, 400);
  assert.equal((await here.call("POST", "/api/me/password", { currentPassword: "erins long password", newPassword: "a fresh password" })).status, 200);

  assert.equal((await here.call("GET", "/api/me")).status, 200);
  assert.equal((await elsewhere.call("GET", "/api/me")).status, 401);
  assert.equal((await client().call("POST", "/api/login", { username: "erin", password: "erins long password" })).status, 401);
  await loginAs("erin", "a fresh password");
});

test("logout invalidates the session server-side, not just the cookie", async () => {
  const c = await loginAs("admin", ADMIN_PW);
  const stolen = c.cookie;
  assert.equal((await c.call("POST", "/api/logout")).status, 200);
  const replay = client();
  replay.cookie = stolen;
  assert.equal((await replay.call("GET", "/api/me")).status, 401);
});

test("rate limit: repeated failures lock the account, even against the correct password", async () => {
  const admin = await loginAs("admin", ADMIN_PW);
  await admin.call("POST", "/api/users", { username: "frank", password: "franks long password" });
  const c = client();
  for (let i = 0; i < 10; i++) {
    assert.equal((await c.call("POST", "/api/login", { username: "frank", password: `wrong password ${i}` })).status, 401);
  }
  const locked = await c.call("POST", "/api/login", { username: "frank", password: "franks long password" });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  assert.match(locked.json.error, /too many/);
  // other accounts are unaffected
  await loginAs("admin", ADMIN_PW);
});

test("stats: API and page require login, validate input, 404 unknown servers, and are removed with the server", async () => {
  const anon = client();
  assert.equal((await anon.call("GET", "/api/servers/x/stats")).status, 401);
  assert.equal((await anon.call("GET", "/servers/x")).status, 302);

  const c = await loginAs("admin", ADMIN_PW);
  const added = await c.call("POST", "/api/servers", { host: "127.0.0.1", queryPort: dayzPort });
  assert.equal(added.status, 201);
  const id = added.json.id;

  const ok = await c.call("GET", `/api/servers/${id}/stats?range=7d&tz=120`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.range, "7d");
  assert.equal(ok.json.server.id, id);
  assert.deepEqual(Object.keys(ok.json.summary).sort(), ["avg", "busiest", "capacity", "max", "min", "peakAt", "polls", "since", "uptime"]);
  assert.ok(Array.isArray(ok.json.series) && Array.isArray(ok.json.daily) && Array.isArray(ok.json.heatmap));
  assert.equal(ok.json.downtime.rebootSeconds, 600);
  assert.deepEqual([ok.json.downtime.intervals, ok.json.downtime.outages.count, ok.json.downtime.reboots.count], [[], 0, 0]);
  const listed = await c.call("GET", "/api/servers");
  assert.equal(listed.json.offlineAfter, 3);
  assert.deepEqual([listed.json.pollSeconds, listed.json.recheckSeconds, listed.json.rebootWindowMinutes], [30, 5, 10]); // the defaults
  const view = listed.json.servers.find((s) => s.id === id);
  assert.ok(["unknown", "online", "offline"].includes(view.state) && Number.isInteger(view.failures));
  assert.equal("ping" in view, false);
  assert.equal((await c.call("GET", `/api/servers/${id}/stats`)).json.range, "7d"); // default
  assert.equal((await c.call("GET", `/api/servers/${id}/stats?range=1h`)).json.range, "1h");
  assert.equal((await c.call("GET", `/api/servers/${id}/stats?range=12h`)).json.range, "12h");
  assert.equal((await c.call("GET", `/api/servers/${id}/stats?range=1y`)).status, 400);
  assert.equal((await c.call("GET", `/api/servers/${id}/stats?tz=garbage`)).status, 200); // bad tz falls back to UTC
  assert.equal((await c.call("GET", "/api/servers/nope/stats")).status, 404);

  const page = await c.call("GET", `/servers/${id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Players over time/);
  assert.equal((await c.call("GET", "/servers/nope")).headers.get("location"), "/");

  assert.equal((await c.call("DELETE", `/api/servers/${id}`)).status, 200);
  assert.equal((await c.call("GET", `/api/servers/${id}/stats`)).status, 404);
});

test("admin: page and overview API are admin-only and never leak credentials", async () => {
  const anon = client();
  assert.equal((await anon.call("GET", "/api/admin/overview")).status, 401);
  const anonPage = await anon.call("GET", "/admin");
  assert.equal(anonPage.status, 302);
  assert.equal(anonPage.headers.get("location"), "/login");

  const admin = await loginAs("admin", ADMIN_PW);
  assert.equal((await admin.call("POST", "/api/users", { username: "gina", password: "ginas long password", role: "user" })).status, 201);
  const gina = await loginAs("gina", "ginas long password");
  assert.equal((await gina.call("GET", "/api/admin/overview")).status, 403);
  const denied = await gina.call("GET", "/admin");
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get("location"), "/");

  const added = await admin.call("POST", "/api/servers", { host: "127.0.0.1", queryPort: dayzPort, webhookUrl: "" });
  const o = await admin.call("GET", "/api/admin/overview");
  assert.equal(o.status, 200);
  assert.match(o.json.runtime.node, /^v\d+/);
  assert.ok(o.json.counts.users >= 2 && o.json.counts.admins >= 1 && o.json.counts.activeSessions >= 2);
  assert.equal(o.json.db.retentionDays, 90);
  assert.ok(o.json.db.pageSize > 0);
  const row = o.json.db.perServer.find((s) => s.serverId === added.json.id);
  assert.equal(row.address, `127.0.0.1:${dayzPort}`);
  assert.equal(row.deleted, false);
  assert.ok(row.ping === null || typeof row.ping.avgMs === "number"); // null until the first poll lands
  assert.doesNotMatch(o.text, /scrypt|ginas long password/);
  assert.equal((await admin.call("DELETE", `/api/servers/${added.json.id}`)).status, 200);

  const page = await admin.call("GET", "/admin");
  assert.equal(page.status, 200);
  assert.match(page.text, /Database/);
});

test("adding a server: it must answer and be a DayZ server", async () => {
  const admin = await loginAs("admin", ADMIN_PW);
  const add = (port) => admin.call("POST", "/api/servers", { host: "127.0.0.1", queryPort: port });

  const silent = dgram.createSocket("udp4"); // bound, never answers
  await new Promise((r) => silent.bind(0, "127.0.0.1", r));
  const other = await fakeA2S(() => 5, { folder: "csgo", game: "Counter-Strike", appId: 730 });
  try {
    const none = await add(silent.address().port);
    assert.equal(none.status, 400);
    assert.match(none.json.error, /no answer from 127\.0\.0\.1:\d+ .*query port \(game port \+ 1\)/);
    const wrong = await add(other.address().port);
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /isn't a DayZ server/);
    assert.equal((await admin.call("GET", "/api/servers")).json.servers.filter((s) => s.queryPort === silent.address().port || s.queryPort === other.address().port).length, 0);
    const ok = await add(dayzPort);
    assert.equal(ok.status, 201);
    assert.equal((await add(dayzPort)).status, 400); // already added
    assert.equal((await admin.call("DELETE", `/api/servers/${ok.json.id}`)).status, 200);
  } finally {
    silent.close();
    other.close();
  }
}, { timeout: 30_000 });

test("account: the change-password page needs a session", async () => {
  const anon = client();
  const anonPage = await anon.call("GET", "/account");
  assert.deepEqual([anonPage.status, anonPage.headers.get("location")], [302, "/login"]);
  const admin = await loginAs("admin", ADMIN_PW);
  const page = await admin.call("GET", "/account");
  assert.equal(page.status, 200);
  assert.match(page.text, /Change password/);
});

test("AUTH_DISABLED bypasses login with an implicit local admin without weakening origin checks", async () => {
  const disabledDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-no-auth-"));
  const port = await freePort();
  const disabledBase = `http://127.0.0.1:${port}`;
  const disabled = spawn("node", ["src/server.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: disabledDataDir, AUTH_DISABLED: "true", ALLOW_PRIVATE_ADDRESSES: "true" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise((resolve, reject) => {
      disabled.on("exit", (c) => reject(new Error(`disabled-auth server exited ${c}`)));
      disabled.stdout.on("data", (d) => String(d).includes("listening") && resolve());
    });
    const call = (method, url, body, headers = {}) => fetch(disabledBase + url, {
      method,
      redirect: "manual",
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

    const root = await call("GET", "/");
    assert.equal(root.status, 200);

    const login = await call("GET", "/login");
    assert.deepEqual([login.status, login.headers.get("location")], [302, "/"]);
    assert.equal((await call("POST", "/api/login", { username: "admin", password: ADMIN_PW })).status, 409);

    const me = await call("GET", "/api/me");
    assert.deepEqual(await me.json(), { username: "local", role: "admin", authDisabled: true });
    assert.deepEqual(me.headers.getSetCookie(), []);
    assert.equal((await call("GET", "/admin")).status, 200);
    const account = await call("GET", "/account");
    assert.deepEqual([account.status, account.headers.get("location")], [302, "/"]); // nothing to log in to, so no password to change
    assert.equal((await call("GET", "/api/users")).status, 200);
    assert.equal((await call("GET", "/api/admin/overview")).status, 200);
    assert.equal((await call("POST", "/api/servers", { host: "127.0.0.1", queryPort: dayzPort }, { origin: "http://evil.example" })).status, 403);

    const added = await call("POST", "/api/servers", { host: "127.0.0.1", queryPort: dayzPort });
    assert.equal(added.status, 201);
    assert.equal((await call("DELETE", `/api/servers/${(await added.clone().json()).id}`)).status, 200);
  } finally {
    const exited = new Promise((resolve) => disabled.once("exit", resolve));
    disabled.kill();
    await exited;
    fs.rmSync(disabledDataDir, { recursive: true, force: true });
  }
});

test("theme.css needs no login (the login page uses it), is served as CSS, and revalidates by ETag", async () => {
  const first = await fetch(`${base}/theme.css`);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-type"), /^text\/css/);
  assert.equal(first.headers.get("cache-control"), "no-cache");
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const same = await fetch(`${base}/theme.css`, { headers: { "if-none-match": etag } });
  assert.equal(same.status, 304);
  assert.equal((await same.text()), "");
  assert.equal((await fetch(`${base}/theme.css`, { headers: { "if-none-match": '"something-else"' } })).status, 200);
  assert.match(first.headers.get("content-security-policy"), /style-src 'self'/); // the stylesheet is same-origin, so the page may load it
});

// Keep last: it locks this machine's IP out of /api/login for 15 minutes.
test("rate limit: one IP guessing many usernames gets locked out too", async () => {
  const c = client();
  let status;
  let tries = 0;
  do {
    status = (await c.call("POST", "/api/login", { username: `guess${tries}`, password: "wrong password!!" })).status;
    tries++;
  } while (status === 401 && tries < 40);
  assert.equal(status, 429, "IP limiter engaged before 40 attempts");
  assert.equal((await c.call("POST", "/api/login", { username: "admin", password: ADMIN_PW })).status, 429);
});
