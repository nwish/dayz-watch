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
