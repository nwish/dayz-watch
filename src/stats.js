// 90-day player-count history. Every poll is folded into a 5-minute bucket per server
// (poll count, successful polls, sum/min/max players), so a server costs ~26k small rows at the
// retention limit regardless of POLL_SECONDS. Queries aggregate those buckets to whatever
// resolution the chart needs. Uses the built-in node:sqlite: no dependencies.
import { DatabaseSync } from "node:sqlite";

export const BUCKET_S = 300;
export const RETENTION_S = 90 * 86400;

// span: how far back; step: chart resolution (a multiple of BUCKET_S, ~300 points per chart).
export const RANGES = {
  "24h": { span: 86400, step: 300 },
  "7d": { span: 7 * 86400, step: 1800 },
  "30d": { span: 30 * 86400, step: 7200 },
  "90d": { span: 90 * 86400, step: 21600 },
};

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const avg = (sum, ok) => (ok > 0 ? round1(sum / ok) : null);

export class Stats {
  // file: path to the database, or ":memory:". now(): seconds, injectable for tests.
  constructor(file, { now = () => Date.now() / 1000 } = {}) {
    this.now = now;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS samples (
        server_id TEXT NOT NULL,
        bucket    INTEGER NOT NULL,  -- start of the 5-minute window, unix seconds
        n         INTEGER NOT NULL,  -- polls in the window
        ok        INTEGER NOT NULL,  -- polls that got an answer
        sum       INTEGER NOT NULL,  -- sum of player counts over ok polls
        lo        INTEGER,           -- min / max players seen (NULL while ok = 0)
        hi        INTEGER,
        cap       INTEGER,           -- last reported max players
        PRIMARY KEY (server_id, bucket)
      ) WITHOUT ROWID;
    `);
    this.insert = this.db.prepare(`
      INSERT INTO samples (server_id, bucket, n, ok, sum, lo, hi, cap) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?5, ?6)
      ON CONFLICT (server_id, bucket) DO UPDATE SET
        n   = n + 1,
        ok  = ok + excluded.ok,
        sum = sum + excluded.sum,
        lo  = CASE WHEN excluded.lo IS NULL THEN lo WHEN lo IS NULL THEN excluded.lo ELSE MIN(lo, excluded.lo) END,
        hi  = CASE WHEN excluded.hi IS NULL THEN hi WHEN hi IS NULL THEN excluded.hi ELSE MAX(hi, excluded.hi) END,
        cap = COALESCE(excluded.cap, cap)
    `);
  }

  // sample: { players, maxPlayers } for a poll that answered, or null for one that failed.
  record(serverId, sample) {
    const bucket = Math.floor(this.now() / BUCKET_S) * BUCKET_S;
    if (sample) this.insert.run(serverId, bucket, 1, sample.players, sample.players, sample.maxPlayers ?? null);
    else this.insert.run(serverId, bucket, 0, 0, null, null);
  }

  remove(serverId) {
    this.db.prepare("DELETE FROM samples WHERE server_id = ?").run(serverId);
  }

  prune() {
    const cutoff = Math.floor((this.now() - RETENTION_S) / BUCKET_S) * BUCKET_S;
    return Number(this.db.prepare("DELETE FROM samples WHERE bucket < ?").run(cutoff).changes);
  }

  close() {
    this.db.close();
  }

  // tzOffsetMin: minutes east of UTC, so days and the weekday/hour heatmap follow the viewer's clock.
  // (One fixed offset is applied to the whole range, so across a DST change buckets shift by an hour.)
  query(serverId, range, tzOffsetMin = 0) {
    const r = RANGES[range];
    if (!r) throw Object.assign(new Error("invalid range"), { status: 400 });
    const off = Math.round(tzOffsetMin) * 60;
    const to = Math.floor(this.now() / BUCKET_S) * BUCKET_S + BUCKET_S;
    const from = Math.floor((to - r.span) / r.step) * r.step;
    // node:sqlite binds JS numbers as REAL, which turns SQL's `/` into float division: step and
    // offset parameters are CAST to INTEGER wherever they take part in bucket arithmetic.
    const all = (sql, ...args) => this.db.prepare(sql).all(...args);
    const one = (sql, ...args) => this.db.prepare(sql).get(...args);

    const series = all(
      `SELECT (bucket / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS t, SUM(n) AS n, SUM(ok) AS ok, SUM(sum) AS sum, MIN(lo) AS lo, MAX(hi) AS hi
         FROM samples WHERE server_id = ?2 AND bucket >= ?3 GROUP BY t ORDER BY t`,
      r.step, serverId, from,
    ).map((p) => ({ t: p.t, avg: avg(p.sum, p.ok), lo: p.lo, hi: p.hi, up: p.n ? round1((100 * p.ok) / p.n) : null }));

    const tot = one(
      `SELECT COALESCE(SUM(n), 0) AS n, COALESCE(SUM(ok), 0) AS ok, COALESCE(SUM(sum), 0) AS sum, MIN(lo) AS lo, MAX(hi) AS hi,
              (SELECT cap FROM samples WHERE server_id = ?1 AND cap IS NOT NULL ORDER BY bucket DESC LIMIT 1) AS cap,
              (SELECT MIN(bucket) FROM samples WHERE server_id = ?1) AS since
         FROM samples WHERE server_id = ?1 AND bucket >= ?2`,
      serverId, from,
    );
    const peak = one(
      "SELECT bucket, hi FROM samples WHERE server_id = ? AND bucket >= ? AND hi IS NOT NULL ORDER BY hi DESC, bucket DESC LIMIT 1",
      serverId, from,
    );

    const daily = all(
      `SELECT (bucket + CAST(?1 AS INTEGER)) / 86400 AS d, SUM(n) AS n, SUM(ok) AS ok, SUM(sum) AS sum, MAX(hi) AS hi
         FROM samples WHERE server_id = ?2 AND bucket >= ?3 GROUP BY d ORDER BY d`,
      off, serverId, from,
    ).map((d) => ({
      date: new Date(d.d * 86400e3).toISOString().slice(0, 10),
      avg: avg(d.sum, d.ok),
      peak: d.hi,
      up: d.n ? round1((100 * d.ok) / d.n) : null,
    }));

    // dow: 0 = Sunday (1970-01-01 was a Thursday = 4), hr: 0-23 in the viewer's timezone.
    const heatmap = all(
      `SELECT ((local / 86400 + 4) % 7) AS dow, ((local % 86400) / 3600) AS hr, SUM(ok) AS ok, SUM(sum) AS sum
         FROM (SELECT bucket + CAST(?1 AS INTEGER) AS local, ok, sum FROM samples WHERE server_id = ?2 AND bucket >= ?3)
        GROUP BY dow, hr HAVING SUM(ok) > 0`,
      off, serverId, from,
    ).map((c) => ({ dow: c.dow, hr: c.hr, avg: avg(c.sum, c.ok) }));
    const busiest = heatmap.reduce((b, c) => (!b || c.avg > b.avg ? c : b), null);

    return {
      range, from, to, step: r.step,
      summary: {
        polls: tot.n,
        uptime: tot.n ? round1((100 * tot.ok) / tot.n) : null,
        avg: avg(tot.sum, tot.ok),
        min: tot.lo,
        max: tot.hi,
        peakAt: peak ? peak.bucket : null,
        capacity: tot.cap,
        since: tot.since,
        busiest,
      },
      series, daily, heatmap,
    };
  }
}
