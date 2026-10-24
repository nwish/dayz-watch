import test from "node:test";
import assert from "node:assert/strict";
import { Stats, RETENTION_S } from "../src/stats.js";

const T0 = Date.UTC(2026, 9, 24, 12, 0, 0) / 1000; // a Saturday, 12:00 UTC
const up = (players, maxPlayers = 60) => ({ players, maxPlayers });

function harness() {
  let t = T0;
  const s = new Stats(":memory:", { now: () => t });
  return { s, at: (sec) => (t = sec) };
}

test("a bucket folds polls into avg/min/max and counts failures against uptime", () => {
  const { s } = harness();
  s.record("a", up(10));
  s.record("a", up(20));
  s.record("a", up(30));
  s.record("a", null); // failed poll, same bucket
  const q = s.query("a", "24h");
  assert.equal(q.series.length, 1);
  assert.deepEqual(q.series[0], { t: T0, avg: 20, lo: 10, hi: 30, up: 75 });
  assert.deepEqual({ ...q.summary, busiest: undefined }, {
    polls: 4, uptime: 75, avg: 20, min: 10, max: 30, peakAt: T0, capacity: 60, since: T0, busiest: undefined,
  });
});

test("a window with only failed polls is a gap in the average, not a zero", () => {
  const { s, at } = harness();
  s.record("a", up(8));
  at(T0 + 300);
  s.record("a", null);
  const [first, down] = s.query("a", "24h").series;
  assert.equal(first.avg, 8);
  assert.deepEqual(down, { t: T0 + 300, avg: null, lo: null, hi: null, up: 0 });
  assert.equal(s.query("a", "24h").summary.min, 8); // failures must not drag min to 0/NULL
});

test("a failed poll before a good one in the same window doesn't lose min/max", () => {
  const { s } = harness();
  s.record("a", null);
  s.record("a", up(5));
  s.record("a", up(9));
  const p = s.query("a", "24h").series[0];
  assert.deepEqual([p.lo, p.hi, p.avg, p.up], [5, 9, 7, 66.7]);
});

test("servers are isolated, and remove() deletes only that server's history", () => {
  const { s } = harness();
  s.record("a", up(1));
  s.record("b", up(2));
  s.remove("a");
  assert.equal(s.query("a", "24h").summary.polls, 0);
  assert.equal(s.query("a", "24h").summary.avg, null);
  assert.equal(s.query("b", "24h").summary.avg, 2);
});

test("ranges select only data inside their window and coarsen resolution", () => {
  const { s, at } = harness();
  at(T0 - 3 * 86400);
  s.record("a", up(50));
  at(T0 - 3600);
  s.record("a", up(10));
  at(T0);
  assert.equal(s.query("a", "24h").summary.max, 10);
  assert.equal(s.query("a", "7d").summary.max, 50);
  assert.equal(s.query("a", "7d").series.length, 2);
  // 90d groups into 6h steps: both points land on 6h-aligned timestamps
  for (const p of s.query("a", "90d").series) assert.equal(p.t % 21600, 0);
  assert.equal(s.query("a", "7d").summary.peakAt, Math.floor((T0 - 3 * 86400) / 300) * 300);
  assert.throws(() => s.query("a", "1y"), (e) => e.status === 400);
});

test("daily buckets, weekday and hour follow the viewer's timezone offset", () => {
  const { s, at } = harness();
  at(Date.UTC(2026, 9, 24, 23, 30) / 1000); // Sat 23:30 UTC
  s.record("a", up(40));
  at(Date.UTC(2026, 9, 24, 23, 59) / 1000 + 120);
  const utc = s.query("a", "7d", 0);
  assert.deepEqual(utc.daily.map((d) => [d.date, d.avg, d.peak]), [["2026-10-24", 40, 40]]);
  assert.deepEqual(utc.heatmap, [{ dow: 6, hr: 23, avg: 40 }]);
  assert.deepEqual(utc.summary.busiest, { dow: 6, hr: 23, avg: 40 });

  const berlin = s.query("a", "7d", 120); // UTC+2: already Sunday 01:30
  assert.deepEqual(berlin.daily.map((d) => d.date), ["2026-10-25"]);
  assert.deepEqual(berlin.heatmap, [{ dow: 0, hr: 1, avg: 40 }]);

  const la = s.query("a", "7d", -420); // UTC-7: Saturday 16:30
  assert.deepEqual(la.heatmap, [{ dow: 6, hr: 16, avg: 40 }]);
});

test("prune drops history older than 90 days and keeps the rest", () => {
  const { s, at } = harness();
  at(T0 - RETENTION_S - 3600);
  s.record("a", up(1));
  at(T0 - RETENTION_S + 3600);
  s.record("a", up(2));
  at(T0);
  s.record("a", up(3));
  assert.equal(s.prune(), 1);
  const q = s.query("a", "90d");
  assert.equal(q.summary.polls, 2);
  assert.equal(q.summary.min, 2);
});

test("dbStats reports totals, per-server coverage and page/file sizes", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-db-"));
  let t = T0;
  const s = new Stats(path.join(dir, "stats.db"), { now: () => t });
  try {
    s.record("a", up(10));
    s.record("a", null);
    t = T0 + 600;
    s.record("a", up(20));
    s.record("b", up(5));
    const d = s.dbStats();
    assert.equal(d.rows, 3); // a: two buckets, b: one
    assert.equal(d.polls, 4);
    assert.equal(d.answered, 3);
    assert.equal(d.oldest, T0);
    assert.equal(d.newest, T0 + 600);
    assert.equal(d.retentionDays, 90);
    assert.deepEqual(d.perServer.find((x) => x.serverId === "a"), { serverId: "a", buckets: 2, polls: 3, ok: 2, first: T0, last: T0 + 600 });
    assert.ok(d.pageSize > 0 && d.pageCount > 0 && d.freePages >= 0);
    assert.ok(d.files.db > 0);
    s.remove("a");
    assert.deepEqual(s.dbStats().perServer.map((x) => x.serverId), ["b"]);
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const mem = new Stats(":memory:").dbStats();
  assert.deepEqual([mem.rows, mem.oldest, mem.newest, mem.perServer.length], [0, null, null, 0]);
  assert.deepEqual(mem.files, { db: null, wal: null, shm: null });
});
