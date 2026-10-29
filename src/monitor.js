// Polls each watched server, posts to Discord when its player count changes, and tracks whether
// it is reachable at all (online / offline) so an outage is one alert, not a stream of errors.
const ts = () => new Date().toISOString();

export function formatChange(info, prev) {
  const delta = info.players - prev;
  return `**${info.name}** (${info.map}): players ${prev} → **${info.players}**/${info.maxPlayers} (${delta > 0 ? "+" : ""}${delta})`;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatOffline(name, address, downMs, error) {
  return `**${name}** (${address}) is **offline**: no answer for ${formatDuration(downMs)} (${error})`;
}

export function formatBackOnline(info, downMs) {
  return `**${info.name}** (${info.map}) is **back online** after ${formatDuration(downMs)}: ${info.players}/${info.maxPlayers} players`;
}

export async function postWebhook(url, content) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Server names come from the game server, so they must never be able to ping @everyone or a role.
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`webhook ${r.status} ${await r.text()}`);
}

function pollSlot(id, pollMs) {
  let hash = 0;
  for (const char of id) hash = Math.imul(hash, 31) + char.charCodeAt(0) | 0;
  return (hash >>> 0) % pollMs;
}

export class Monitor {
  // query(host, port) -> {name,map,players,maxPlayers}; notify(url, content) -> Promise
  // onSample(server, {players,maxPlayers} | null): called once per finished poll (null = it failed).
  // offlineAfter: consecutive failed polls before a server counts as offline. now(): ms, injectable for tests.
  // recheckMs: while a server isn't answering it is polled this often instead of every pollMs (see nextPollDelay).
  // rebootWindowMs: a normal restart takes a few minutes, so Discord is only told about a server that is still
  // down after this long (0 = tell it as soon as the server counts as offline).
  // onOutage(server, "start" | "end", atMs, players): an outage began (first failed poll) or ended (first answered
  // poll, with the player count it reported).
  constructor({ query, notify = postWebhook, defaultWebhook = null, pollMs = 30_000, recheckMs = 5_000, onSample = null, onOutage = null, offlineAfter = 3, rebootWindowMs = 10 * 60e3, now = Date.now }) {
    this.query = query;
    this.notify = notify;
    this.defaultWebhook = defaultWebhook;
    this.pollMs = pollMs;
    this.recheckMs = recheckMs;
    this.onSample = onSample;
    this.offlineAfter = offlineAfter;
    this.rebootWindowMs = rebootWindowMs;
    this.now = now;
    this.onOutage = onOutage;
    this.state = new Map(); // id -> per-server polling state, see track()
  }

  // Same rule as #sample: a history-store failure must never stop the polling loop.
  #outage(server, kind, atMs, players) {
    try {
      this.onOutage?.(server, kind, atMs, players);
    } catch (e) {
      console.error(`${ts()} recording outage ${kind} for ${server.host}:${server.queryPort} failed: ${e.message}`);
    }
  }

  // A history-store failure must never stop the polling loop.
  #sample(server, sample) {
    try {
      this.onSample?.(server, sample);
    } catch (e) {
      console.error(`${ts()} recording sample for ${server.host}:${server.queryPort} failed: ${e.message}`);
    }
  }

  // Register a server without starting its loop.
  track(server) {
    const st = {
      info: null,
      lastPlayers: null,
      lastPingMs: null,
      pingTotalMs: 0,
      pingSamples: 0,
      error: null,
      checkedAt: null,
      timer: null,
      stopped: false,
      state: "unknown", // unknown (no answer yet) | online | offline
      failures: 0, // consecutive failed polls
      firstFailureAt: null,
      lastSeenAt: null, // last successful poll since this process started
      offlineSince: null,
      offlineNotified: false, // an "offline" alert went out, so a "back online" one is owed
      lastFailSampleAt: 0, // when a failed poll was last written to the history (rechecks are throttled)
      waiting: false, // a poll timer is pending (as opposed to a tick running), see start()
      reschedule: null,
      pollSlotMs: pollSlot(server.id, this.pollMs), // keeps healthy servers from querying in lockstep
    };
    this.state.set(server.id, st);
    return st;
  }

  // Healthy servers use a stable slot in the normal poll interval. This spreads queries and lets each
  // server's UI pill animate when that specific server has refreshed. Failures bypass the slot for fast rechecks.
  #healthyPollDelay(st) {
    const now = this.now();
    let next = Math.floor(now / this.pollMs) * this.pollMs + st.pollSlotMs;
    if (next <= now + Math.min(1_000, this.pollMs / 2)) next += this.pollMs;
    return next - now;
  }

  start(server) {
    const st = this.track(server);
    const delay = () => (st.failures === 0 ? this.#healthyPollDelay(st) : this.nextPollDelay(server.id));
    const loop = async () => {
      st.waiting = false;
      await this.tick(server);
      if (!st.stopped) {
        st.waiting = true;
        st.timer = setTimeout(loop, delay());
      }
    };
    // Called by configure(): a pending wait was computed from the old timings, so redo it. A running tick
    // needs nothing, it schedules its next poll from the new values once it finishes.
    st.reschedule = () => {
      if (!st.waiting || st.stopped) return;
      clearTimeout(st.timer);
      st.timer = setTimeout(loop, delay());
    };
    loop();
  }

  // Change the timings of a running monitor (the admin panel does this). The new values apply to every server
  // at once, including ones that are already waiting out a long poll interval.
  configure({ pollMs = this.pollMs, recheckMs = this.recheckMs, offlineAfter = this.offlineAfter, rebootWindowMs = this.rebootWindowMs }) {
    const changed = pollMs !== this.pollMs || recheckMs !== this.recheckMs || offlineAfter !== this.offlineAfter || rebootWindowMs !== this.rebootWindowMs;
    if (!changed) return;
    Object.assign(this, { pollMs, recheckMs, offlineAfter, rebootWindowMs });
    for (const [id, st] of this.state) {
      st.pollSlotMs = pollSlot(id, pollMs);
      st.reschedule?.();
    }
  }

  stop(id) {
    const st = this.state.get(id);
    if (!st) return;
    st.stopped = true;
    clearTimeout(st.timer);
    this.state.delete(id);
  }

  // Delay before the next poll. While a server isn't answering it is re-polled every recheckMs, so a restart
  // is noticed within seconds and its length is measured to about that precision, instead of being rounded
  // to the poll interval (a restart shorter than offlineAfter x pollMs would otherwise never be seen). The
  // quick cadence only lasts while the downtime could still be a restart, or hasn't reached offlineAfter yet;
  // after that a dead server is polled at the normal rate again.
  nextPollDelay(id) {
    const st = this.state.get(id);
    if (!st || st.failures === 0) return this.pollMs;
    const fast = st.failures < this.offlineAfter || this.now() - st.firstFailureAt < this.rebootWindowMs;
    return fast ? Math.min(this.recheckMs, this.pollMs) : this.pollMs;
  }

  status(id) {
    const st = this.state.get(id);
    if (!st) return { info: null, ping: null, error: null, checkedAt: null, state: "unknown", failures: 0, offlineSince: null, lastSeenAt: null, likelyRestart: false };
    const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
    return {
      info: st.info,
      ping: st.pingSamples === 0 ? null : {
        lastMs: st.lastPingMs,
        avgMs: Math.round(st.pingTotalMs / st.pingSamples),
      },
      error: st.error,
      checkedAt: st.checkedAt,
      state: st.state,
      failures: st.failures,
      offlineSince: iso(st.offlineSince),
      lastSeenAt: iso(st.lastSeenAt),
      // Offline, but not for long enough yet to be anything other than a normal restart.
      likelyRestart: st.state === "offline" && this.now() - st.offlineSince < this.rebootWindowMs,
    };
  }

  async tick(server) {
    const st = this.state.get(server.id);
    if (!st) return;
    const address = `${server.host}:${server.queryPort}`;
    const startedAt = this.now();
    let info;
    try {
      info = await this.query(server.host, server.queryPort);
    } catch (e) {
      if (st.stopped) return;
      st.error = e.message; // a failed query is not a player change; keep last known count
      st.checkedAt = ts();
      st.failures++;
      st.firstFailureAt ??= this.now();
      // Quick rechecks would weigh dark time several times heavier than normal time in the history (and in
      // its "answered polls" share), so after the first failure only one failed poll per pollMs is recorded.
      if (st.failures === 1 || this.now() - st.lastFailSampleAt >= this.pollMs) {
        st.lastFailSampleAt = this.now();
        this.#sample(server, null);
      }
      if (st.failures >= this.offlineAfter) {
        if (st.state !== "offline") {
          st.state = "offline";
          st.offlineSince = st.firstFailureAt;
          st.lastPlayers = null; // coming back is a fresh baseline, not a "20 -> 0" change
          this.#outage(server, "start", st.offlineSince);
          console.log(`${ts()} ${address} offline: ${e.message}`);
        }
        // Restarts are routine, so only a server still down after the restart window is announced. One we
        // have never seen up since this process started (a mistyped address) shows as offline in the UI
        // but never pings the channel.
        const downMs = this.now() - st.offlineSince;
        if (!st.offlineNotified && st.lastSeenAt !== null && downMs >= this.rebootWindowMs) {
          st.offlineNotified = true;
          await this.#send(server, st, formatOffline(st.info?.name ?? address, address, downMs, e.message));
        }
      }
      return;
    }
    if (st.stopped) return;

    const wasOffline = st.state === "offline";
    const announceBack = wasOffline && st.offlineNotified;
    const downMs = st.offlineSince === null ? 0 : this.now() - st.offlineSince;
    st.error = null;
    const pingMs = Math.max(0, Math.round(this.now() - startedAt));
    st.lastPingMs = pingMs;
    st.pingTotalMs += pingMs;
    st.pingSamples++;

    st.checkedAt = ts();
    st.info = info;
    st.state = "online";
    st.failures = 0;
    st.firstFailureAt = null;
    st.offlineSince = null;
    st.offlineNotified = false;
    st.lastSeenAt = this.now();
    this.#sample(server, { players: info.players, maxPlayers: info.maxPlayers });
    if (wasOffline) this.#outage(server, "end", this.now(), info.players);
    if (wasOffline && !announceBack) console.log(`${ts()} ${address} answering again after ${formatDuration(downMs)}, not announced`);

    if (announceBack) {
      st.lastPlayers = info.players;
      const msg = formatBackOnline(info, downMs);
      console.log(`${ts()} ${address} ${msg}`);
      return this.#send(server, st, msg);
    }
    const prev = st.lastPlayers;
    st.lastPlayers = info.players;
    if (prev === null || prev === info.players) return; // baseline or unchanged
    const msg = formatChange(info, prev);
    console.log(`${ts()} ${address} ${msg}`);
    return this.#send(server, st, msg);
  }

  async #send(server, st, msg) {
    if (server.webhookEnabled === false) return; // muted from the Webhook dialog: nothing goes out, whichever webhook it would use
    const url = server.webhookUrl ?? this.defaultWebhook;
    if (!url) return; // no webhook configured: monitor only, no notification
    try {
      await this.notify(url, msg);
    } catch (e) {
      console.error(`${ts()} notify failed for ${server.host}:${server.queryPort}: ${e.message}`);
      st.error = `notify failed: ${e.message}`;
    }
  }
}
