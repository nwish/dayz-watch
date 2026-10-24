import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queryInfo } from "../src/a2s.js";
import { Monitor } from "../src/monitor.js";
import { Store, validateServerInput } from "../src/store.js";

const cs = (s) => Buffer.from(`${s}\0`);

// Fake A2S server that demands a challenge before answering, like real DayZ servers.
const KEYWORDS = "battleye,no3rd,shard000,lqs0,etm3.290000,entm3.290000,isDLC4,06:07";
function fakeA2S(getPlayers) {
  return new Promise((resolve) => {
    const udp = dgram.createSocket("udp4");
    udp.on("message", (m, r) => {
      if (m.length === 25) return udp.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4]), r.port, r.address);
      assert.deepEqual([...m.subarray(25)], [1, 2, 3, 4]);
      const port = Buffer.alloc(2);
      port.writeUInt16LE(11300);
      const body = Buffer.concat([
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
        cs("TestSrv"), cs("nasdara"), cs("dayz"), cs("game"),
        Buffer.from([0, 0, getPlayers(), 60, 0, 0x64, 0x77, 0, 0]), // appid, players, max, bots, dedicated, windows, public, no VAC
        cs("1.30.164200"),
        Buffer.from([0xa0]), port, cs(KEYWORDS), // EDF: game port + keywords
      ]);
      udp.send(body, r.port, r.address);
    });
    udp.bind(0, "127.0.0.1", () => resolve(udp));
  });
}

test("queryInfo completes challenge handshake and parses info and DayZ keyword flags", async () => {
  const udp = await fakeA2S(() => 7);
  try {
    const info = await queryInfo("127.0.0.1", udp.address().port);
    assert.deepEqual(info, {
      name: "TestSrv",
      map: "nasdara",
      players: 7,
      maxPlayers: 60,
      version: "1.30.164200",
      platform: "Windows",
      passwordProtected: false,
      gamePort: 11300,
      battleye: true,
      thirdPerson: false,
      gameTime: "06:07",
    });
  } finally {
    udp.close();
  }
});

test("queryInfo rejects on timeout", async () => {
  const udp = dgram.createSocket("udp4"); // never answers
  await new Promise((r) => udp.bind(0, "127.0.0.1", r));
  try {
    await assert.rejects(queryInfo("127.0.0.1", udp.address().port, { timeoutMs: 200 }), /timeout/);
  } finally {
    udp.close();
  }
});

function monitorHarness(defaultWebhook = "https://default") {
  let next;
  const posts = [];
  const m = new Monitor({
    query: async () => {
      const r = next;
      if (r instanceof Error) throw r;
      return r;
    },
    notify: async (url, content) => posts.push({ url, content }),
    defaultWebhook,
  });
  const server = { id: "s1", host: "h", queryPort: 1, webhookUrl: null };
  m.state.set("s1", { info: null, lastPlayers: null, error: null, checkedAt: null, timer: null, stopped: false });
  const tick = async (v) => {
    next = v;
    await m.tick(server);
  };
  return { m, server, posts, tick };
}

const info = (players) => ({ name: "N", map: "m", players, maxPlayers: 60 });

test("monitor: no post on baseline or unchanged; posts on change", async () => {
  const { posts, tick } = monitorHarness();
  await tick(info(4));
  await tick(info(4));
  assert.equal(posts.length, 0);
  await tick(info(6));
  assert.equal(posts.length, 1);
  assert.match(posts[0].content, /4 → \*\*6\*\*\/60 \(\+2\)/);
  await tick(info(1));
  assert.match(posts[1].content, /6 → \*\*1\*\*\/60 \(-5\)/);
});

test("monitor: failed query keeps last count and is not a change", async () => {
  const { m, posts, tick } = monitorHarness();
  await tick(info(4));
  await tick(new Error("query timeout"));
  assert.equal(m.status("s1").error, "query timeout");
  await tick(info(4)); // recovered at same count
  assert.equal(posts.length, 0);
  assert.equal(m.status("s1").error, null);
});

test("monitor: per-server webhook overrides default", async () => {
  const { server, posts, tick } = monitorHarness();
  server.webhookUrl = "https://own";
  await tick(info(1));
  await tick(info(2));
  assert.equal(posts[0].url, "https://own");
});

test("monitor: without any webhook, changes are tracked but nothing is posted and no error is set", async () => {
  const { m, posts, tick } = monitorHarness(null);
  await tick(info(1));
  await tick(info(3));
  assert.equal(posts.length, 0);
  assert.equal(m.status("s1").error, null);
  assert.equal(m.status("s1").info.players, 3);
});

test("monitor: notify failure does not break polling or lose the new baseline", async () => {
  const { m, tick } = monitorHarness();
  m.notify = async () => {
    throw new Error("webhook 500");
  };
  await tick(info(1));
  await tick(info(2));
  assert.match(m.status("s1").error, /notify failed/);
  assert.equal(m.state.get("s1").lastPlayers, 2);
});

test("store: validation rejects bad host, port, and non-Discord webhook", () => {
  const ok = { host: "Example.com", queryPort: "11301" };
  assert.deepEqual(validateServerInput(ok), { host: "example.com", queryPort: 11301, webhookUrl: null });
  assert.throws(() => validateServerInput({ ...ok, host: "a b" }), /invalid host/);
  assert.throws(() => validateServerInput({ ...ok, host: "http://x" }), /invalid host/);
  assert.throws(() => validateServerInput({ ...ok, queryPort: 70000 }), /invalid query port/);
  assert.throws(() => validateServerInput({ ...ok, webhookUrl: "http://169.254.169.254/" }), /webhook/);
  assert.throws(() => validateServerInput({ ...ok, webhookUrl: "https://discord.com.evil.io/api/webhooks/1/a" }), /webhook/);
  validateServerInput({ ...ok, webhookUrl: "https://discord.com/api/webhooks/123/abc-DEF_1" });
});

test("store: persists across reload, rejects duplicates, removes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-"));
  try {
    const a = new Store(dir);
    const s = a.add({ host: "1.2.3.4", queryPort: 11301 });
    assert.throws(() => a.add({ host: "1.2.3.4", queryPort: 11301 }), /already added/);
    const b = new Store(dir);
    assert.equal(b.list().length, 1);
    assert.equal(b.list()[0].id, s.id);
    assert.equal(b.remove(s.id), true);
    assert.equal(new Store(dir).list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
