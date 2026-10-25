import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queryInfo } from "../src/a2s.js";
import { Monitor, formatDuration } from "../src/monitor.js";
import { Stats } from "../src/stats.js";
import { Store, validateServerInput } from "../src/store.js";
import { fakeA2S } from "./fake-a2s.js";

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
      isDayZ: true,
    });
  } finally {
    udp.close();
  }
});

test("queryInfo tells DayZ from other games by app id or folder/game name", async () => {
  const is = async (opts) => {
    const udp = await fakeA2S(() => 1, opts);
    try {
      return (await queryInfo("127.0.0.1", udp.address().port)).isDayZ;
    } finally {
      udp.close();
    }
  };
  assert.equal(await is({ folder: "dayz", game: "game", appId: 0 }), true); // names only
  assert.equal(await is({ folder: "x", game: "DayZ", appId: 0 }), true);
  assert.equal(await is({ folder: "x", game: "y", gameId: 221100n }), true); // the 64-bit game id only
  assert.equal(await is({ folder: "x", game: "y", gameId: 221100n | (1n << 40n) }), true); // upper bits are not part of the app id
  assert.equal(await is({ folder: "csgo", game: "Counter-Strike", appId: 730, gameId: 730n }), false);
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
  m.track(server);
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

test("monitor: reports the latest and average successful query times", async () => {
  let now = 0;
  const delays = [12, 57];
  const m = new Monitor({
    now: () => now,
    query: async () => {
      now += delays.shift();
      return info(4);
    },
    notify: async () => {},
  });
  const server = { id: "s1", host: "h", queryPort: 1, webhookUrl: null };
  m.track(server);
  await m.tick(server);
  await m.tick(server);
  assert.deepEqual(m.status("s1").ping, { lastMs: 57, avgMs: 35 });
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

test("monitor: reports every finished poll to onSample, and a throwing recorder doesn't break polling", async () => {
  const seen = [];
  let next;
  const m = new Monitor({
    query: async () => {
      if (next instanceof Error) throw next;
      return next;
    },
    notify: async () => {},
    onSample: (server, sample) => {
      seen.push([server.id, sample]);
      if (seen.length === 1) throw new Error("disk full");
    },
  });
  const server = { id: "s1", host: "h", queryPort: 1, webhookUrl: null };
  m.track(server);
  const origErr = console.error;
  console.error = () => {};
  try {
    next = info(5);
    await m.tick(server);
    next = new Error("timeout");
    await m.tick(server);
    next = info(6);
    await m.tick(server);
  } finally {
    console.error = origErr;
  }
  assert.deepEqual(seen, [["s1", { players: 5, maxPlayers: 60 }], ["s1", null], ["s1", { players: 6, maxPlayers: 60 }]]);
  assert.equal(m.status("s1").info.players, 6);
  m.stop("s1");
  next = info(7);
  await m.tick(server); // removed servers record nothing
  assert.equal(seen.length, 3);
});

test("monitor: healthy servers occupy stable independent poll slots after their baseline", async () => {
  const scheduled = [];
  const originalSetTimeout = globalThis.setTimeout;
  const m = new Monitor({
    query: async () => info(1),
    notify: async () => {},
    pollMs: 10_000,
    now: () => 0,
  });
  const servers = ["alpha", "beta", "omega"].map((id) => ({ id, host: "h", queryPort: 1, webhookUrl: null }));
  globalThis.setTimeout = (callback, delay) => {
    scheduled.push(delay);
    return { callback, delay };
  };
  try {
    servers.forEach((server) => m.start(server));
    await new Promise(setImmediate);
    assert.deepEqual(scheduled, [9_918, 10_272, 8_401]);
  } finally {
    servers.forEach(({ id }) => m.stop(id));
    globalThis.setTimeout = originalSetTimeout;
  }
});

// Fake-clock harness: every tick() first advances 30 s, like a real poll interval.
function outageHarness({ webhook = "https://default", offlineAfter = 3, rebootWindowMs = 0, pollMs = 30_000, recheckMs = 5_000, notify, onOutage, onSample } = {}) {
  let t = 0;
  let next;
  const posts = [];
  const m = new Monitor({
    query: async () => {
      if (next instanceof Error) throw next;
      return next;
    },
    notify: notify ?? (async (url, content) => posts.push(content)),
    defaultWebhook: webhook,
    offlineAfter,
    rebootWindowMs,
    pollMs,
    recheckMs,
    onSample,
    onOutage,
    now: () => t,
  });
  const server = { id: "s1", host: "h", queryPort: 1, webhookUrl: null };
  m.track(server);
  const tick = async (v, advanceMs = 30_000) => {
    t += advanceMs;
    next = v;
    await m.tick(server);
  };
  return { m, posts, tick, status: () => m.status("s1"), delay: () => m.nextPollDelay("s1") };
}
const down = () => new Error("query timeout");

test("monitor: offline only after N consecutive failures, announced once; recovery is a fresh baseline", async () => {
  const { posts, tick, status } = outageHarness();
  await tick(info(20));
  await tick(down());
  await tick(down());
  assert.deepEqual([posts.length, status().state, status().failures], [0, "online", 2]); // two misses are just a blip
  await tick(down());
  assert.equal(status().state, "offline");
  assert.equal(status().offlineSince, new Date(60_000).toISOString()); // first failed poll, not the third
  assert.equal(posts.length, 1);
  assert.equal(posts[0], "**N** (h:1) is **offline**: no answer for 1m (query timeout)");
  await tick(down());
  await tick(down());
  assert.equal(posts.length, 1); // an ongoing outage doesn't repeat

  await tick(info(0)); // server restarted: must be "back online", not "players 20 -> 0"
  assert.equal(posts.length, 2);
  assert.equal(posts[1], "**N** (m) is **back online** after 2m: 0/60 players");
  assert.deepEqual([status().state, status().failures, status().offlineSince], ["online", 0, null]);
  await tick(info(3));
  assert.match(posts[2], /players 0 → \*\*3\*\*\/60 \(\+3\)/); // counting resumes from the recovery reading
});

test("monitor: a blip below the threshold is silent and keeps the player-count baseline", async () => {
  const { posts, tick, status } = outageHarness();
  await tick(info(5));
  await tick(down());
  await tick(info(7));
  assert.equal(posts.length, 1);
  assert.match(posts[0], /players 5 → \*\*7\*\*/);
  assert.deepEqual([status().state, status().failures], ["online", 0]);
});

test("monitor: a server never seen online shows offline but pings nobody, going or coming", async () => {
  const { posts, tick, status } = outageHarness();
  for (let i = 0; i < 4; i++) await tick(down());
  assert.equal(status().state, "offline");
  assert.equal(status().lastSeenAt, null);
  await tick(info(4));
  assert.equal(status().state, "online");
  assert.deepEqual(posts, []);
});

test("monitor: with no webhook an outage is still tracked, and a failing webhook doesn't undo it or repeat", async () => {
  const quiet = outageHarness({ webhook: null });
  await quiet.tick(info(5));
  for (let i = 0; i < 3; i++) await quiet.tick(down());
  assert.equal(quiet.status().state, "offline");
  assert.equal(quiet.posts.length, 0);

  let calls = 0;
  const broken = outageHarness({ notify: async () => { calls++; throw new Error("webhook 500"); } });
  const origErr = console.error;
  console.error = () => {};
  try {
    await broken.tick(info(5));
    for (let i = 0; i < 5; i++) await broken.tick(down());
  } finally {
    console.error = origErr;
  }
  assert.equal(broken.status().state, "offline");
  assert.equal(calls, 1);
});

test("monitor: outage events fire once at the first failed poll and once at the first answer; a throwing store doesn't stop polling", async () => {
  const events = [];
  const { posts, tick } = outageHarness({
    onOutage: (server, kind, at) => {
      events.push([server.id, kind, at]);
      throw new Error("disk full");
    },
  });
  const origErr = console.error;
  console.error = () => {};
  try {
    await tick(info(5)); // t = 30 s
    await tick(down()); // 60 s: first failure
    await tick(down());
    assert.deepEqual(events, []); // below the threshold
    await tick(down()); // 120 s: declared offline
    await tick(down());
    await tick(info(5)); // 180 s: answers
  } finally {
    console.error = origErr;
  }
  assert.deepEqual(events, [["s1", "start", 60_000], ["s1", "end", 180_000]]); // start = first failed poll, not the 3rd
  assert.equal(posts.length, 2); // and the Discord alerts still went out
});

test("monitor + stats agree on how long an outage lasted (list, 'offline for', and the Discord message)", async () => {
  // The reported bug: the server died partway through a 5-minute window, so a bucket-derived outage
  // missed the start and rounded the rest up to a full window.
  let ms = Date.UTC(2026, 9, 24, 22, 28, 0);
  const stats = new Stats(":memory:", { now: () => ms / 1000 });
  const posts = [];
  let next;
  const m = new Monitor({
    query: async () => {
      if (next instanceof Error) throw next;
      return next;
    },
    notify: async (url, content) => posts.push(content),
    defaultWebhook: "https://default",
    offlineAfter: 3,
    rebootWindowMs: 0, // alert at once, so the Discord duration can be compared with the stats one
    now: () => ms,
    onSample: (s, sample) => stats.record(s.id, sample),
    onOutage: (s, kind, at) => (kind === "start" ? stats.outageStart(s.id, at / 1000) : stats.outageEnd(s.id, at / 1000)),
  });
  const server = { id: "s1", host: "h", queryPort: 1, webhookUrl: null };
  m.track(server);
  const tick = async (v) => {
    ms += 30_000;
    next = v;
    await m.tick(server);
  };
  await tick(info(5)); // 22:28:30, answered
  for (let i = 0; i < 3; i++) await tick(down()); // 22:29:00, 22:29:30, 22:30:00: offline, across a window boundary

  ms = Date.UTC(2026, 9, 24, 22, 33, 0); // three minutes into the 22:30 window
  const ongoing = stats.query("s1", "24h").downtime.intervals.at(-1);
  const offlineSince = Date.parse(m.status("s1").offlineSince);
  assert.deepEqual([ongoing.ongoing, ongoing.from * 1000], [true, offlineSince]);
  assert.equal(ongoing.to * 1000 - ongoing.from * 1000, ms - offlineSince); // "Offline for" and the stats list agree: 4 min, not 5
  assert.equal(ms - offlineSince, 4 * 60_000);

  await tick(info(0)); // 22:33:30 answers again
  const done = stats.query("s1", "24h").downtime.intervals.at(-1);
  assert.equal(done.ongoing, false);
  assert.equal(done.to - done.from, 270);
  assert.equal(done.kind, "reboot"); // 4.5 min is under the stats restart window (the monitor above alerts at once only to compare durations)
  assert.match(posts.at(-1), /back online\*\* after 4m/); // formatDuration(270 s)
});

test("monitor: a restart shorter than the window is silent, and the restarted server is a fresh baseline", async () => {
  const { posts, tick, status } = outageHarness({ rebootWindowMs: 10 * 60e3 });
  await tick(info(20));
  for (let i = 0; i < 4; i++) await tick(down()); // 2 minutes dark
  assert.deepEqual([status().state, status().likelyRestart], ["offline", true]);
  await tick(info(0)); // came back empty
  assert.deepEqual([status().state, status().likelyRestart], ["online", false]);
  assert.deepEqual(posts, []); // no "offline", no "back online", and no "players 20 -> 0"
  await tick(info(3));
  assert.equal(posts.length, 1);
  assert.match(posts[0], /players 0 → \*\*3\*\*\/60 \(\+3\)/);
});

test("monitor: only a server still down after the window is announced, once, with how long it has been down", async () => {
  const { posts, tick, status } = outageHarness({ rebootWindowMs: 10 * 60e3 });
  await tick(info(20));
  for (let i = 0; i < 19; i++) await tick(down()); // failures from 60 s to 600 s: dark for 9m00s at the last one
  assert.deepEqual([posts.length, status().likelyRestart], [0, true]);
  await tick(down()); // 630 s: dark for 9m30s: still inside the window
  assert.deepEqual([posts.length, status().likelyRestart], [0, true]);
  await tick(down()); // 660 s: dark for 10 minutes, no longer just a restart
  assert.equal(posts.length, 1);
  assert.equal(posts[0], "**N** (h:1) is **offline**: no answer for 10m (query timeout)");
  assert.equal(status().likelyRestart, false);
  await tick(down());
  await tick(down());
  assert.equal(posts.length, 1); // not repeated
  await tick(info(0)); // 750 s: 11m30s after the first failure
  assert.equal(posts.length, 2);
  assert.match(posts[1], /back online\*\* after 11m: 0\/60 players/);
});

test("monitor: a server that isn't answering is rechecked quickly, then polled normally once it's clearly an outage", async () => {
  const { tick, delay } = outageHarness({ rebootWindowMs: 10 * 60e3 });
  await tick(info(5));
  assert.equal(delay(), 30_000); // healthy: the normal rate
  await tick(down());
  assert.equal(delay(), 5_000); // one miss: look again soon
  for (let i = 0; i < 18; i++) await tick(down()); // dark for 9 minutes: still inside the restart window
  assert.equal(delay(), 5_000);
  await tick(down());
  await tick(down()); // dark for 10 minutes: an outage, no point polling it every 5 s
  assert.equal(delay(), 30_000);
  await tick(info(5));
  assert.equal(delay(), 30_000);

  const noWindow = outageHarness({ rebootWindowMs: 0 }); // restart window off: quick only until offlineAfter is reached
  await noWindow.tick(info(5));
  await noWindow.tick(down());
  await noWindow.tick(down());
  assert.equal(noWindow.delay(), 5_000);
  await noWindow.tick(down());
  assert.equal(noWindow.delay(), 30_000);
  const slowRecheck = outageHarness({ recheckMs: 60_000 }); // a recheck is never slower than the normal rate
  await slowRecheck.tick(down());
  assert.equal(slowRecheck.delay(), 30_000);
});

test("monitor: a restart shorter than offlineAfter x pollMs is caught, timed from the first failed poll, and doesn't skew the history", async () => {
  const samples = [];
  const events = [];
  const { posts, tick, status } = outageHarness({
    rebootWindowMs: 10 * 60e3,
    onSample: (server, sample) => samples.push(sample),
    onOutage: (server, kind, at, players) => events.push([kind, at, players]),
  });
  await tick(info(20)); // 30 s
  for (let i = 0; i < 3; i++) await tick(down(), 5_000); // 35 s, 40 s, 45 s
  assert.deepEqual([status().state, status().likelyRestart], ["offline", true]); // 10 s of silence is enough: not 3 x 30 s
  for (let i = 0; i < 10; i++) await tick(down(), 5_000); // rechecks every 5 s until 95 s
  await tick(info(0), 5_000); // 100 s: answers again
  assert.deepEqual(events, [["start", 35_000, undefined], ["end", 100_000, 0]]); // a 65 s restart, back empty, to the second (the old rule never saw it)
  assert.deepEqual(samples, [{ players: 20, maxPlayers: 60 }, null, null, null, { players: 0, maxPlayers: 60 }]); // 13 failed polls, 3 recorded
  assert.deepEqual(posts, []); // and it is a restart, so Discord hears nothing
});

test("formatDuration is compact and rounds down to the largest useful unit", () => {
  assert.deepEqual([5_000, 150_000, 3_600_000, 3 * 3_600_000 + 5 * 60_000, 52 * 3_600_000].map(formatDuration), ["5s", "2m", "1h 0m", "3h 5m", "2d 4h"]);
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
