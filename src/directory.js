// Searchable directory of public DayZ servers, used to autocomplete the "add server" form.
// Source: the DZSA Launcher's public list (no API key). BattleMetrics and the Steam Web API both
// need paid/keyed access now. The list is ~13 MB of JSON (~10k servers), so it is fetched lazily,
// trimmed to what the form needs, and cached in memory.
export const DEFAULT_DIRECTORY_URL = "https://dayzsalauncher.com/api/v2/launcher/servers/dayz";

const MIN_QUERY = 2;
const MAX_LIMIT = 25;

function trim(raw) {
  if (!Array.isArray(raw)) throw new Error("unexpected directory response");
  const out = [];
  for (const s of raw) {
    const host = s?.endpoint?.ip;
    const queryPort = s?.endpoint?.port;
    if (typeof host !== "string" || !Number.isInteger(queryPort) || typeof s.name !== "string") continue;
    const gamePort = Number.isInteger(s.gamePort) ? s.gamePort : null;
    const name = s.name.trim();
    const map = typeof s.map === "string" ? s.map : "";
    out.push({
      name,
      host,
      queryPort,
      gamePort,
      map,
      players: Number(s.players) || 0,
      maxPlayers: Number(s.maxPlayers) || 0,
      password: Boolean(s.password),
      lcName: name.toLowerCase(),
      // Everything a user might type: name, map, and either port with the IP.
      hay: `${name} ${map} ${host}:${queryPort} ${host}:${gamePort ?? ""}`.toLowerCase(),
    });
  }
  return out;
}

const TOP_MAPS = 8;

// What the admin page shows about a loaded list.
function summarize(servers) {
  const maps = new Map();
  const hosts = new Set();
  let populated = 0, players = 0, passworded = 0;
  for (const s of servers) {
    hosts.add(s.host);
    if (s.players > 0) populated++;
    players += s.players;
    if (s.password) passworded++;
    const m = s.map.toLowerCase() || "(none)";
    maps.set(m, (maps.get(m) ?? 0) + 1);
  }
  const topMaps = [...maps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_MAPS).map(([map, servers]) => ({ map, servers }));
  return { servers: servers.length, hosts: hosts.size, populated, players, passworded, maps: maps.size, topMaps };
}

export class Directory {
  #servers = [];
  #stats = null;
  #builtAt = null; // when the upstream says it built the list (its `created` field)
  #fetchedAt = null; // when we last downloaded it
  #freshUntil = 0; // search refreshes the list once this passes (pushed out a minute after a failed refresh)
  #lastError = null;
  #inflight = null;

  constructor({ url = DEFAULT_DIRECTORY_URL, ttlMs = 10 * 60e3, timeoutMs = 30e3, fetchFn = fetch, now = Date.now } = {}) {
    this.url = url;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
    this.now = now;
  }

  // One shared download at a time; a failure keeps the previous list and is remembered for status().
  #download() {
    this.#inflight ??= this.#refresh()
      .catch((e) => {
        this.#lastError = { message: e.message, at: this.now() };
        throw e;
      })
      .finally(() => (this.#inflight = null));
    return this.#inflight;
  }

  // Refresh when stale. If a refresh fails the previous list keeps being served, and only a cold start
  // with no list surfaces the error.
  async #ensure() {
    if (this.#fetchedAt !== null && this.now() < this.#freshUntil) return;
    try {
      await this.#download();
    } catch (e) {
      if (this.#fetchedAt === null) {
        const err = new Error(`server directory unavailable (${e.message})`);
        err.status = 502;
        throw err;
      }
      console.warn(`directory refresh failed, serving stale list: ${e.message}`);
      this.#freshUntil = this.now() + 60e3; // back off a minute before retrying
    }
  }

  async #refresh() {
    const res = await this.fetchFn(this.url, {
      headers: { "user-agent": "dayz-watch", accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const servers = trim(body?.result);
    const built = Date.parse(body?.created);
    this.#servers = servers;
    this.#stats = summarize(servers);
    this.#builtAt = Number.isFinite(built) ? built : null;
    this.#fetchedAt = this.now();
    this.#freshUntil = this.#fetchedAt + this.ttlMs;
    this.#lastError = null;
  }

  // Download now, whatever the TTL. Rejects (status 502) if the download fails; the previous list stays in use.
  async refresh() {
    try {
      await this.#download();
    } catch (e) {
      const err = new Error(`server directory unavailable (${e.message})`);
      err.status = 502;
      throw err;
    }
    return this.status();
  }

  // What is loaded, for the admin page. Never downloads: a list nobody has searched yet reports loaded: false.
  status() {
    return {
      loaded: this.#fetchedAt !== null,
      builtAt: this.#builtAt,
      fetchedAt: this.#fetchedAt,
      ttlSeconds: Math.round(this.ttlMs / 1000),
      refreshing: this.#inflight !== null,
      lastError: this.#lastError,
      stats: this.#stats,
    };
  }

  // Every whitespace-separated term must appear in the name, map, or ip:port. Name-prefix hits rank
  // first, then name substring hits, then the rest; busier servers win ties.
  async search(query, limit = 10) {
    const q = String(query ?? "").trim().toLowerCase();
    if (q.length < MIN_QUERY) return [];
    await this.#ensure();
    const terms = q.split(/\s+/);
    const max = Math.min(Math.max(Math.trunc(limit) || 10, 1), MAX_LIMIT);
    const hits = [];
    for (const s of this.#servers) {
      if (!terms.every((t) => s.hay.includes(t))) continue;
      const rank = s.lcName.startsWith(q) ? 0 : s.lcName.includes(q) ? 1 : 2;
      hits.push({ s, rank });
    }
    hits.sort((a, b) => a.rank - b.rank || b.s.players - a.s.players || a.s.name.localeCompare(b.s.name));
    return hits.slice(0, max).map(({ s: { name, host, queryPort, gamePort, map, players, maxPlayers, password } }) => ({
      name, host, queryPort, gamePort, map, players, maxPlayers, password,
    }));
  }
}
