// Polls each watched server and posts to Discord when its player count changes.
const ts = () => new Date().toISOString();

export function formatChange(info, prev) {
  const delta = info.players - prev;
  return `**${info.name}** (${info.map}): players ${prev} → **${info.players}**/${info.maxPlayers} (${delta > 0 ? "+" : ""}${delta})`;
}

export async function postWebhook(url, content) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`webhook ${r.status} ${await r.text()}`);
}

export class Monitor {
  // query(host, port) -> {name,map,players,maxPlayers}; notify(url, content) -> Promise
  // onSample(server, {players,maxPlayers} | null): called once per finished poll (null = it failed).
  constructor({ query, notify = postWebhook, defaultWebhook = null, pollMs = 30_000, onSample = null }) {
    this.query = query;
    this.notify = notify;
    this.defaultWebhook = defaultWebhook;
    this.pollMs = pollMs;
    this.onSample = onSample;
    this.state = new Map(); // id -> {info, lastPlayers, error, checkedAt, timer}
  }

  // A history-store failure must never stop the polling loop.
  #sample(server, sample) {
    try {
      this.onSample?.(server, sample);
    } catch (e) {
      console.error(`${ts()} recording sample for ${server.host}:${server.queryPort} failed: ${e.message}`);
    }
  }

  start(server) {
    const st = { info: null, lastPlayers: null, error: null, checkedAt: null, timer: null, stopped: false };
    this.state.set(server.id, st);
    const loop = async () => {
      await this.tick(server);
      if (!st.stopped) st.timer = setTimeout(loop, this.pollMs);
    };
    loop();
  }

  stop(id) {
    const st = this.state.get(id);
    if (!st) return;
    st.stopped = true;
    clearTimeout(st.timer);
    this.state.delete(id);
  }

  status(id) {
    const st = this.state.get(id);
    if (!st) return { info: null, error: null, checkedAt: null };
    return { info: st.info, error: st.error, checkedAt: st.checkedAt };
  }

  async tick(server) {
    const st = this.state.get(server.id);
    if (!st) return;
    let info;
    try {
      info = await this.query(server.host, server.queryPort);
    } catch (e) {
      if (st.stopped) return;
      st.error = e.message; // a failed query is not a player change; keep last known count
      st.checkedAt = ts();
      this.#sample(server, null);
      return;
    }
    if (st.stopped) return;
    st.error = null;
    st.checkedAt = ts();
    st.info = info;
    this.#sample(server, { players: info.players, maxPlayers: info.maxPlayers });
    const prev = st.lastPlayers;
    st.lastPlayers = info.players;
    if (prev === null || prev === info.players) return; // baseline or unchanged
    const msg = formatChange(info, prev);
    console.log(`${ts()} ${server.host}:${server.queryPort} ${msg}`);
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
