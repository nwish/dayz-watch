import test from "node:test";
import assert from "node:assert/strict";
import { Directory } from "../src/directory.js";

const srv = (name, ip, port, extra = {}) => ({ name, endpoint: { ip, port }, gamePort: port - 1, map: "chernarusplus", players: 0, maxPlayers: 60, password: false, ...extra });

const LIST = [
  srv("Quiet Cherno", "10.0.0.1", 2303),
  srv("Cherno Prefix", "10.0.0.5", 2503),
  srv("Busy Cherno", "10.0.0.2", 2303, { players: 55 }),
  srv("2305 | EUROPE - DE", "5.101.164.205", 10501, { map: "nasdara", players: 23 }),
  srv("The Cherno Club", "10.0.0.3", 27016, { password: true }),
  { name: "no endpoint" },
  srv("Namalsk Frost", "10.0.0.4", 2403, { map: "namalsk" }),
];

function dir(over = {}) {
  const calls = { n: 0 };
  const d = new Directory({
    url: "http://x/list",
    now: () => calls.t ?? 0,
    fetchFn: async () => {
      calls.n++;
      return { ok: true, status: 200, json: async () => ({ result: LIST }) };
    },
    ...over,
  });
  return { d, calls };
}

test("search ranks name-prefix first, then substring, busier servers win ties; malformed entries are skipped", async () => {
  const { d } = dir();
  assert.deepEqual((await d.search("cherno")).map((s) => s.name), ["Cherno Prefix", "Busy Cherno", "Quiet Cherno", "The Cherno Club"]);
  assert.equal((await d.search("no endpoint")).length, 0);
  assert.equal((await d.search("cherno", 2)).length, 2);
  const prefix = await d.search("the cherno");
  assert.equal(prefix[0].name, "The Cherno Club");
  assert.deepEqual(prefix[0], { name: "The Cherno Club", host: "10.0.0.3", queryPort: 27016, gamePort: 27015, map: "chernarusplus", players: 0, maxPlayers: 60, password: true });
});

test("search matches server numbers, IPs, ip:port and maps; all terms must match; short queries return nothing", async () => {
  const { d } = dir();
  assert.equal((await d.search("2305"))[0].name, "2305 | EUROPE - DE");
  assert.equal((await d.search("5.101.164.205:10501"))[0].host, "5.101.164.205");
  assert.equal((await d.search("10.0.0.4"))[0].name, "Namalsk Frost");
  assert.equal((await d.search("frost namalsk")).length, 1);
  assert.equal((await d.search("frost nasdara")).length, 0);
  assert.deepEqual(await d.search("c"), []);
  assert.deepEqual(await d.search("   "), []);
});

test("list is cached until the TTL, downloads are shared, and a failed refresh keeps serving the old list", async () => {
  const state = { t: 0, n: 0, fail: false };
  const d = new Directory({
    ttlMs: 1000,
    now: () => state.t,
    fetchFn: async () => {
      state.n++;
      if (state.fail) return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => ({ result: LIST }) };
    },
  });
  await Promise.all([d.search("cherno"), d.search("namalsk"), d.search("europe")]);
  assert.equal(state.n, 1);
  state.t = 999;
  await d.search("cherno");
  assert.equal(state.n, 1);
  state.t = 1001;
  state.fail = true;
  assert.ok((await d.search("cherno")).length > 0);
  assert.equal(state.n, 2);
  await d.search("cherno"); // backed off, no hammering the upstream
  assert.equal(state.n, 2);
});

test("cold-start failure surfaces as a 502 and the next search retries", async () => {
  let n = 0;
  const d = new Directory({
    fetchFn: async () => {
      n++;
      if (n === 1) return { ok: false, status: 503 };
      return { ok: true, status: 200, json: async () => ({ result: LIST }) };
    },
  });
  await assert.rejects(d.search("cherno"), (e) => e.status === 502 && /unavailable/.test(e.message));
  assert.ok((await d.search("cherno")).length > 0);
});

test("status reports the upstream build time and list stats without downloading; refresh() bypasses the TTL and a failure keeps the list", async () => {
  const state = { t: 5000, n: 0, fail: false };
  const d = new Directory({
    ttlMs: 60_000,
    now: () => state.t,
    fetchFn: async () => {
      state.n++;
      if (state.fail) return { ok: false, status: 503 };
      return { ok: true, status: 200, json: async () => ({ created: "2026-10-29T16:29:45.826Z", result: LIST }) };
    },
  });
  assert.deepEqual(d.status(), { loaded: false, builtAt: null, fetchedAt: null, ttlSeconds: 60, refreshing: false, lastError: null, stats: null });
  assert.equal(state.n, 0);

  const loaded = await d.refresh();
  assert.equal(loaded.builtAt, Date.parse("2026-10-29T16:29:45.826Z"));
  assert.equal(loaded.fetchedAt, 5000);
  // 6 valid entries (the one without an endpoint is dropped): Busy Cherno has 55 players, the Europe one 23, the Cherno Club has a password.
  assert.deepEqual(loaded.stats, {
    servers: 6, hosts: 6, populated: 2, players: 78, passworded: 1, maps: 3,
    topMaps: [{ map: "chernarusplus", servers: 4 }, { map: "namalsk", servers: 1 }, { map: "nasdara", servers: 1 }],
  });

  state.t = 6000; // well inside the TTL: a search would reuse the list, refresh() must not
  await d.refresh();
  assert.equal(state.n, 2);

  state.fail = true;
  state.t = 7000;
  await assert.rejects(d.refresh(), (e) => e.status === 502 && /HTTP 503/.test(e.message));
  const after = d.status();
  assert.equal(after.stats.servers, 6);
  assert.equal(after.fetchedAt, 6000); // still the last good download, not the failed attempt
  assert.deepEqual(after.lastError, { message: "HTTP 503", at: 7000 });
  assert.ok((await d.search("cherno")).length > 0);

  state.fail = false;
  state.t = 8000;
  assert.equal((await d.refresh()).lastError, null);
});
