import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { isPrivateAddress, resolveHost } from "../src/netguard.js";
import { queryInfo } from "../src/a2s.js";
import { hashPassword } from "../src/auth.js";
import { postWebhook } from "../src/monitor.js";
import { Store } from "../src/store.js";

test("netguard: loopback, LAN, link-local and reserved IPv4 are private; public ones are not", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.255.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "224.0.0.1", "255.255.255.255", "::1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "85.190.157.254", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("netguard: a host that resolves to a private address is refused, however it is spelled", async () => {
  for (const host of ["127.0.0.1", "192.168.0.10", "localhost", "2130706433"]) {
    await assert.rejects(resolveHost(host), /private address/, host);
  }
  assert.equal(await resolveHost("8.8.8.8"), "8.8.8.8");
  assert.equal(await resolveHost("127.0.0.1", { allowPrivate: true }), "127.0.0.1");
  await assert.rejects(queryInfo("127.0.0.1", 9, { allowPrivate: false }), /private address/); // refused before any packet is sent
});

test("webhook posts carry allowed_mentions so a server name can't ping @everyone", async () => {
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => ((sent = JSON.parse(init.body)), { ok: true });
  try {
    await postWebhook("https://discord.com/api/webhooks/1/x", "**@everyone** (map): players 1 → 2");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent.allowed_mentions, { parse: [] });
  assert.match(sent.content, /@everyone/);
});

test("servers.json (it holds webhook URLs) is written readable by the owner only", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-store-"));
  try {
    const store = new Store(dir);
    store.add({ host: "example.com", queryPort: 2303, webhookUrl: "https://discord.com/api/webhooks/1/x" });
    store.add({ host: "example.org", queryPort: 2303 }); // a second save replaces the file; it must keep the mode
    assert.equal(fs.statSync(path.join(dir, "servers.json")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("password hashing: a flood is capped and queued, extra requests get 503, and it recovers", async () => {
  const attempts = await Promise.allSettled(Array.from({ length: 40 }, () => hashPassword("some long password")));
  const busy = attempts.filter((r) => r.status === "rejected");
  assert.equal(attempts.length - busy.length, 18); // 2 running + 16 queued
  assert.ok(busy.every((r) => r.reason.status === 503));
  assert.match(await hashPassword("after the flood"), /^scrypt\$/); // the slots were all handed back
});

test("server: private addresses can't be added unless ALLOW_PRIVATE_ADDRESSES is set", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-guard-"));
  fs.writeFileSync(
    path.join(dataDir, "users.json"),
    JSON.stringify({ users: [{ username: "admin", role: "admin", passwordHash: await hashPassword("correct-horse-battery"), createdAt: new Date().toISOString(), lastLoginAt: null }] }),
  );
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const proc = spawn("node", ["src/server.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ALLOW_PRIVATE_ADDRESSES: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise((resolve, reject) => {
      proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
      proc.stdout.on("data", (d) => String(d).includes("listening") && resolve());
    });
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "correct-horse-battery" }) });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    const add = (host) => fetch(`${base}/api/servers`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ host, queryPort: 9 }) });
    for (const host of ["127.0.0.1", "10.0.0.5", "localhost"]) {
      const r = await add(host);
      assert.equal(r.status, 400, host);
      assert.match((await r.json()).error, /private address/);
    }
  } finally {
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill();
    await exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
