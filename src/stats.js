// 90-day player-count history. Every poll is folded into a 5-minute bucket per server
// (poll count, successful polls, sum/min/max players), so a server costs ~26k small rows at the
// retention limit regardless of pollSeconds. Queries aggregate those buckets to whatever
// resolution the chart needs. Uses the built-in node:sqlite: no dependencies.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

export const BUCKET_S = 300;
export const RETENTION_S = 90 * 86400;

// span: how far back; step: chart resolution (a multiple of BUCKET_S, ~300 points per chart).
export const RANGES = {
  "1h": { span: 3600, step: 300 },
  "12h": { span: 12 * 3600, step: 300 },
  "24h": { span: 86400, step: 300 },
  "7d": { span: 7 * 86400, step: 1800 },
  "30d": { span: 30 * 86400, step: 7200 },
  "90d": { span: 90 * 86400, step: 21600 },
};

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const avg = (sum, ok) => (ok > 0 ? round1(sum / ok) : null);

// Schema versions live in the database's PRAGMA user_version. MIGRATIONS[n] upgrades version n to n + 1, so a
// future change is a new entry here (never an edit to an old one) and every existing database follows it.
// Version 0 is a database from before versioning existed as well as a brand-new file, which is why step 0 is
// idempotent and also adds the one column that used to be patched in separately.
const MIGRATIONS = [
  (db) => {
    db.exec(`
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
      -- Exact outage intervals from the monitor's own clock (first failed poll .. first answered poll).
      CREATE TABLE IF NOT EXISTS outages (
        server_id TEXT NOT NULL,
        started   INTEGER NOT NULL,  -- unix seconds
        ended     INTEGER,           -- NULL while the outage is still going on
        players_after INTEGER,       -- players on the first answered poll; NULL while ongoing (and for rows from before this column)
        PRIMARY KEY (server_id, started)
      ) WITHOUT ROWID;
    `);
    if (!db.prepare("PRAGMA table_info(outages)").all().some((c) => c.name === "players_after")) {
      db.exec("ALTER TABLE outages ADD COLUMN players_after INTEGER");
    }
  },
];
export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db) {
  const found = db.prepare("PRAGMA user_version").get().user_version;
  if (found > SCHEMA_VERSION) {
    throw new Error(`stats database is schema version ${found}, newer than this app understands (${SCHEMA_VERSION}); upgrade dayz-watch instead of downgrading it`);
  }
  for (let v = found; v < SCHEMA_VERSION; v++) {
    db.exec("BEGIN");
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`); // not parameterizable; v is our own integer
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export class Stats {
  // file: path to the database, or ":memory:". now(): seconds, injectable for tests.
  // rebootSeconds: a downtime shorter than this is a normal restart, anything longer an outage.
  constructor(file, { now = () => Date.now() / 1000, rebootSeconds = 600 } = {}) {
    this.file = file;
    this.rebootSeconds = rebootSeconds;
    this.now = now;
    this.db = new DatabaseSync(file);
    try {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      migrate(this.db);
    } catch (e) {
      this.db.close(); // don't leave the file (and its -wal/-shm) locked behind a failed start
      throw e;
    }
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
    this.db.prepare("DELETE FROM outages WHERE server_id = ?").run(serverId);
  }

  prune() {
    const cutoff = Math.floor((this.now() - RETENTION_S) / BUCKET_S) * BUCKET_S;
    this.db.prepare("DELETE FROM outages WHERE ended IS NOT NULL AND ended < ?").run(cutoff);
    return Number(this.db.prepare("DELETE FROM samples WHERE bucket < ?").run(cutoff).changes);
  }

  // The monitor declares a server offline / answering again. `at` is unix seconds.
  outageStart(serverId, at) {
    this.db
      .prepare("INSERT INTO outages (server_id, started) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM outages WHERE server_id = ?1 AND ended IS NULL)")
      .run(serverId, Math.floor(at));
  }

  // players: the count on the first poll that answered. A restarted server is empty (nobody can rejoin yet),
  // so coming back with players means the server never went down: the monitor just couldn't reach it.
  outageEnd(serverId, at, players = null) {
    this.db.prepare("UPDATE outages SET ended = MAX(started, ?2), players_after = ?3 WHERE server_id = ?1 AND ended IS NULL").run(serverId, Math.floor(at), players);
  }

  // Call once at startup, before polling resumes. An outage still open from the previous run can't be
  // followed while the app was down, so it ends at the last moment we know we were watching — except for
  // servers in keepIds, which polling resumes watching right away: their interval stays open and the
  // resumed monitor ends it when the server answers, so an app restart never splits one outage in two.
  closeOpenOutages(keepIds = new Set()) {
    const now = Math.floor(this.now());
    for (const o of this.db.prepare("SELECT server_id AS id, started FROM outages WHERE ended IS NULL").all()) {
      if (keepIds.has(o.id)) continue;
      const last = this.db.prepare("SELECT MAX(bucket) AS b FROM samples WHERE server_id = ?").get(o.id).b;
      const watchedUntil = last == null ? o.started : last + BUCKET_S; // end of the last window we have samples for
      const end = Math.max(o.started, Math.min(now, watchedUntil));
      this.db.prepare("UPDATE outages SET ended = ? WHERE server_id = ? AND started = ?").run(end, o.id, o.started);
    }
  }

  // Admin view of the database itself: totals, per-server coverage, page/file sizes.
  dbStats() {
    const one = (sql) => this.db.prepare(sql).get();
    const t = one("SELECT COUNT(*) AS rows, COALESCE(SUM(n), 0) AS polls, COALESCE(SUM(ok), 0) AS ok, MIN(bucket) AS oldest, MAX(bucket) AS newest FROM samples");
    const perServer = this.db
      .prepare("SELECT server_id AS serverId, COUNT(*) AS buckets, SUM(n) AS polls, SUM(ok) AS ok, MIN(bucket) AS first, MAX(bucket) AS last FROM samples GROUP BY server_id ORDER BY buckets DESC")
      .all();
    const size = (p) => {
      try {
        return fs.statSync(p).size;
      } catch {
        return null; // :memory:, or the -wal/-shm file doesn't exist right now
      }
    };
    return {
      rows: t.rows,
      polls: t.polls,
      answered: t.ok,
      oldest: t.oldest,
      newest: t.newest,
      pageSize: one("PRAGMA page_size").page_size,
      pageCount: one("PRAGMA page_count").page_count,
      freePages: one("PRAGMA freelist_count").freelist_count,
      files: { db: size(this.file), wal: size(`${this.file}-wal`), shm: size(`${this.file}-shm`) },
      retentionDays: RETENTION_S / 86400,
      perServer: perServer.map((s) => ({ ...s })),
    };
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

    // Downtime comes from the monitor's exact timestamps, so it matches "Offline for ..." and the Discord
    // messages, and is classified by length: shorter than the restart window is a normal restart, anything
    // longer an outage. Classifying on read means changing rebootWindowMinutes re-sorts the history.
    // An ongoing interval runs to now (and turns from restart into outage once it outlasts the window).
    // A short one that ended with players already online wasn't a restart (a restarted server comes back
    // empty) but isn't an outage either: the server stayed up and only the monitor lost contact, a "blip".
    // Unknown (still ongoing, or recorded before players_after) is judged on length alone.
    const now = Math.floor(this.now());
    const intervals = all("SELECT started, ended, players_after FROM outages WHERE server_id = ?1 AND (ended IS NULL OR ended >= ?2) ORDER BY started", serverId, from).map((o) => {
      const to = o.ended ?? now;
      const short = to - o.started < this.rebootSeconds;
      const kind = !short ? "outage" : o.players_after > 0 ? "blip" : "reboot";
      return { from: o.started, to, ongoing: o.ended === null, kind };
    });
    const clipped = (i) => Math.max(0, i.to - Math.max(i.from, from)); // totals count only the part inside the range
    const outs = intervals.filter((i) => i.kind === "outage");
    const boots = intervals.filter((i) => i.kind === "reboot");
    // Local hours of day at which restarts usually begin: only hours that recur (at least twice, and at
    // least half as often as the busiest one) so a one-off doesn't look like a schedule.
    const perHour = new Map();
    for (const i of boots) {
      const hr = Math.floor(((i.from + off) % 86400) / 3600);
      perHour.set(hr, (perHour.get(hr) ?? 0) + 1);
    }
    const topCount = Math.max(0, ...perHour.values());
    const hours = [...perHour]
      .filter(([, n]) => n >= Math.max(2, Math.ceil(topCount / 2)))
      .map(([hr]) => hr)
      .sort((a, b) => a - b)
      .slice(0, 8);
    const downtime = {
      rebootSeconds: this.rebootSeconds,
      intervals, // oldest first; { from, to, ongoing, kind: "reboot" | "outage" | "blip" }; blips are in neither count below
      outages: {
        count: outs.length,
        totalSeconds: Math.round(outs.reduce((a, i) => a + clipped(i), 0)),
        longestSeconds: Math.round(Math.max(0, ...outs.map(clipped))),
      },
      reboots: {
        count: boots.length,
        totalSeconds: Math.round(boots.reduce((a, i) => a + clipped(i), 0)),
        avgSeconds: boots.length ? Math.round(boots.reduce((a, i) => a + i.to - i.from, 0) / boots.length) : 0,
        hours,
      },
    };

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
      series, daily, heatmap, downtime,
    };
  }
}
