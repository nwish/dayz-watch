// End-to-end auth tests: run the real server as a child process and talk to it over HTTP.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ADMIN_PW = "correct-horse-battery";
let proc;
let base;
let dataDir;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-srv-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn("node", ["src/server.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: ADMIN_PW },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    proc.stdout.on("data", (d) => String(d).includes("listening") && resolve());
  });
});

after(() => {
  proc.kill();
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
