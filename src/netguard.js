// Keeps the watcher from being aimed at the machine's own network. Anyone who can add a server picks the
// address every poll is sent to, so by default only publicly routable IPv4 addresses are allowed.
import dns from "node:dns/promises";
import net from "node:net";

// [network, prefix length] blocks that are never a public game server.
const BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([ip, bits]) => [toInt(ip), bits]);

function toInt(ip) {
  return ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}

export function isPrivateAddress(ip) {
  if (!net.isIPv4(ip)) return true; // the watcher only speaks IPv4; anything else is refused
  const n = toInt(ip);
  return BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

// The IPv4 address to send to. Throws if the host resolves somewhere private (unless allowPrivate).
// Resolving here, at poll time, also covers a name that changes its answer after it was added.
export async function resolveHost(host, { allowPrivate = false } = {}) {
  const ip = net.isIPv4(host) ? host : (await dns.lookup(host, { family: 4 })).address;
  if (!allowPrivate && isPrivateAddress(ip)) throw new Error(`${host} is a private address, which is not allowed`);
  return ip;
}
