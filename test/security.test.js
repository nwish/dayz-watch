import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { postWebhook } from "../src/monitor.js";
import { Store } from "../src/store.js";

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
