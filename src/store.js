// JSON-file persistence for the watched-server list. Atomic write via tmp + rename.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export function validateServerInput({ host, queryPort, webhookUrl }) {
  if (typeof host !== "string" || !HOST_RE.test(host.trim())) throw new Error("invalid host");
  const port = Number(queryPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid query port");
  let webhook = null;
  if (webhookUrl != null && webhookUrl !== "") {
    if (typeof webhookUrl !== "string" || !WEBHOOK_RE.test(webhookUrl.trim())) {
      throw new Error("webhook must be a https://discord.com/api/webhooks/... URL");
    }
    webhook = webhookUrl.trim();
  }
  return { host: host.trim().toLowerCase(), queryPort: port, webhookUrl: webhook };
}

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, "servers.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this.servers = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")).servers : [];
  }

  list() {
    return this.servers;
  }

  get(id) {
    return this.servers.find((s) => s.id === id);
  }

  add(input) {
    const v = validateServerInput(input);
    if (this.servers.some((s) => s.host === v.host && s.queryPort === v.queryPort)) {
      throw new Error("server already added");
    }
    const server = { id: crypto.randomUUID(), ...v };
    this.servers.push(server);
    this.#save();
    return server;
  }

  // Change a server's Discord webhook. { webhookUrl } replaces it, or removes it when null or ""; the URL gets the
  // same check as when a server is added. { enabled: false } mutes every message for this server but keeps the URL;
  // true unmutes it. Anything invalid is rejected before anything is changed. Returns the server, or null when there is no such id.
  updateWebhook(id, { webhookUrl, enabled } = {}) {
    const server = this.get(id);
    if (!server) return null;
    const url = webhookUrl === undefined ? undefined : validateServerInput({ host: server.host, queryPort: server.queryPort, webhookUrl }).webhookUrl;
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("invalid request: enabled must be true or false");
    if (url !== undefined) server.webhookUrl = url;
    if (enabled === false) server.webhookEnabled = false;
    else if (enabled === true) delete server.webhookEnabled; // on is the default, so servers.json only records the exception
    this.#save();
    return server;
  }

  // The monitor's offline clock, kept so "offline for N days" survives a restart of this app. sinceMs: when the
  // server went dark (unix ms), or null once it answers again. name: what it called itself, to recognise it in the
  // parked list after a restart. Written only when it changes, which is on an outage starting or ending.
  setOffline(id, sinceMs, name = null) {
    const server = this.get(id);
    if (!server) return;
    if (sinceMs == null) {
      if (server.offlineSince === undefined && server.lastName === undefined) return;
      delete server.offlineSince;
      delete server.lastName;
    } else {
      if (server.offlineSince === sinceMs && (name == null || server.lastName === name)) return;
      server.offlineSince = sinceMs;
      if (name != null) server.lastName = name;
    }
    this.#save();
  }

  // Point a server at a new address. Its id stays, so its history and webhook stay attached, and the offline
  // clock is cleared because the new address is a fresh start.
  changeAddress(id, input) {
    const server = this.get(id);
    if (!server) throw new Error("server not found");
    const { host, queryPort } = validateServerInput(input);
    if (this.servers.some((s) => s.id !== id && s.host === host && s.queryPort === queryPort)) throw new Error("server already added");
    server.host = host;
    server.queryPort = queryPort;
    delete server.offlineSince;
    delete server.lastName;
    this.#save();
    return server;
  }

  remove(id) {
    const i = this.servers.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.servers.splice(i, 1);
    this.#save();
    return true;
  }

  #save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ servers: this.servers }, null, 2), { mode: 0o600 }); // holds Discord webhook URLs
    fs.renameSync(tmp, this.file);
  }
}
