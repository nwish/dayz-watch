import test from "node:test";
import assert from "node:assert/strict";
import { postWebhook } from "../src/monitor.js";

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
