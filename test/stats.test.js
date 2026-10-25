import test from "node:test";
import assert from "node:assert/strict";
import { Stats, RETENTION_S } from "../src/stats.js";

const T0 = Date.UTC(2026, 9, 24, 12, 0, 0) / 1000; // a Saturday, 12:00 UTC
const up = (players, maxPlayers = 60) => ({ players, maxPlayers });

function harness(opts = {}) {
  let t = T0;
  const s = new Stats(":memory:", { now: () => t, ...opts });
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

test("short ranges include only their matching window at five-minute resolution", () => {
  const { s, at } = harness();
  at(T0 - 13 * 3600);
  s.record("a", up(50));
  at(T0 - 11 * 3600);
  s.record("a", up(40));
  at(T0 - 3300);
  s.record("a", up(10));
  at(T0);
  s.record("a", up(20));

  const oneHour = s.query("a", "1h");
  assert.deepEqual([oneHour.step, oneHour.series.length, oneHour.summary.max], [300, 2, 20]);
  const twelveHours = s.query("a", "12h");
  assert.deepEqual([twelveHours.step, twelveHours.series.length, twelveHours.summary.max], [300, 3, 40]);
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

test("downtime keeps the monitor's exact times, splits restarts from outages by length, and clips totals to the range", () => {
  const { s, at } = harness({ rebootSeconds: 300 });
  s.outageStart("a", T0 - 5 * 86400); // finished long before the 24 h window
  s.outageEnd("a", T0 - 5 * 86400 + 60);
  s.outageStart("a", T0 - 7200 + 17); // not aligned to a 5-minute window on purpose
  s.outageEnd("a", T0 - 7200 + 17 + 600);
  s.outageStart("a", T0 - 100);
  s.outageStart("a", T0 - 50); // already open: ignored, the outage keeps its real start
  const d = s.query("a", "24h").downtime;
  assert.deepEqual(d.intervals, [
    { from: T0 - 7200 + 17, to: T0 - 7200 + 17 + 600, ongoing: false, kind: "outage" }, // 10 min >= 5 min window
    { from: T0 - 100, to: T0, ongoing: true, kind: "reboot" }, // dark for 100 s so far: could still be a restart
  ]);
  assert.deepEqual(d.outages, { count: 1, totalSeconds: 600, longestSeconds: 600 });
  assert.deepEqual(d.reboots, { count: 1, totalSeconds: 100, avgSeconds: 100, hours: [] }); // one restart is not a schedule
  assert.equal(s.query("a", "7d").downtime.intervals.length, 3);

  s.outageStart("b", T0 - 90000); // began 25 h ago, ended 1 h ago: listed with its real start, counted only from the window start
  s.outageEnd("b", T0 - 3600);
  const b = s.query("b", "24h").downtime;
  assert.deepEqual([b.intervals[0].from, b.outages.count, b.outages.totalSeconds], [T0 - 90000, 1, 82500]);

  at(T0 + 300); // the ongoing one has now outlasted the window: it was an outage after all
  assert.equal(s.query("a", "24h").downtime.intervals.at(-1).kind, "outage");
  assert.deepEqual(s.query("zzz", "24h").downtime, {
    rebootSeconds: 300,
    intervals: [],
    outages: { count: 0, totalSeconds: 0, longestSeconds: 0 },
    reboots: { count: 0, totalSeconds: 0, avgSeconds: 0, hours: [] },
  });
});

test("a short downtime that ends with players online is an outage, not a restart (a restarted server comes back empty)", () => {
  const { s } = harness({ rebootSeconds: 300 });
  s.outageStart("a", T0 - 3000);
  s.outageEnd("a", T0 - 2900, 0); // back empty: a restart
  s.outageStart("a", T0 - 2000);
  s.outageEnd("a", T0 - 1900, 12); // back with 12 players: only the monitor lost contact
  s.outageStart("a", T0 - 1000);
  s.outageEnd("a", T0 - 900); // players unknown (older row): judged on length alone
  const d = s.query("a", "24h").downtime;
  assert.deepEqual(d.intervals.map((i) => i.kind), ["reboot", "outage", "reboot"]);
  assert.deepEqual([d.reboots.count, d.outages.count], [2, 1]);
});

test("an existing database without outages.players_after is upgraded in place", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-"));
  const file = path.join(dir, "old.db");
  try {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE outages (server_id TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER, PRIMARY KEY (server_id, started)) WITHOUT ROWID; INSERT INTO outages VALUES ('a', 100, 200);");
    old.close();
    const s = new Stats(file, { now: () => T0 });
    assert.equal(s.db.prepare("SELECT players_after FROM outages").get().players_after, null);
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recurring restarts are summarised as the local hours they usually begin; a one-off is not a schedule", () => {
  const { s } = harness();
  const at = (d, h, m = 0) => Date.UTC(2026, 9, d, h, m) / 1000;
  for (const start of [at(21, 22), at(22, 22), at(23, 22), at(24, 10, 5)]) {
    s.outageStart("a", start);
    s.outageEnd("a", start + 200); // three and a bit minutes: a restart
  }
  s.outageStart("a", at(22, 3));
  s.outageEnd("a", at(22, 3) + 7200); // two hours: an outage, so not part of the restart pattern
  const r = (tz) => s.query("a", "7d", tz).downtime.reboots;
  assert.deepEqual([r(0).count, r(0).avgSeconds, r(0).hours], [4, 200, [22]]);
  assert.deepEqual(r(120).hours, [0]); // UTC+2: 22:00 UTC is midnight
  assert.deepEqual(r(-420).hours, [15]); // UTC-7
  assert.equal(s.query("a", "7d").downtime.outages.count, 1);
});

test("closeOpenOutages ends an outage left open by a previous run at the last moment we were watching", () => {
  const { s, at } = harness();
  s.record("a", null); // last sample in the bucket starting at T0
  s.outageStart("a", T0 - 60);
  s.outageStart("noSamples", T0 - 60);
  at(T0 + 3600); // the app was down for an hour
  s.closeOpenOutages();
  const a = s.query("a", "24h").downtime.intervals[0];
  assert.deepEqual([a.from, a.to, a.ongoing], [T0 - 60, T0 + 300, false]); // not "still going for an hour"
  const n = s.query("noSamples", "24h").downtime.intervals[0];
  assert.deepEqual([n.from, n.to, n.ongoing], [T0 - 60, T0 - 60, false]);
});

test("downtime is deleted with its server, and pruning keeps open outages", () => {
  const { s, at } = harness();
  s.outageStart("a", T0 - RETENTION_S - 7200);
  s.outageEnd("a", T0 - RETENTION_S - 3600); // ended before the retention cutoff
  s.outageStart("a", T0 - RETENTION_S - 1000); // still open (monitoring never saw it recover)
  s.outageStart("b", T0 - 600);
  s.outageEnd("b", T0 - 300);
  s.prune();
  at(T0);
  assert.equal(s.query("a", "90d").downtime.intervals.length, 1);
  s.remove("b");
  assert.equal(s.query("b", "90d").downtime.intervals.length, 0);
});
