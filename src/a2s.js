// Minimal Steam A2S_INFO client (UDP). DayZ answers on game port + 1.
import dgram from "node:dgram";
import { resolveHost } from "./netguard.js";

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const A2S_INFO = Buffer.concat([HEADER, Buffer.from([0x54]), Buffer.from("Source Engine Query\0")]);

function send(host, port, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const done = (fn, val) => {
      clearTimeout(timer);
      sock.close();
      fn(val);
    };
    const timer = setTimeout(() => done(reject, new Error("query timeout")), timeoutMs);
    sock.once("message", (msg) => done(resolve, msg));
    sock.once("error", (err) => done(reject, err));
    sock.send(payload, port, host, (err) => {
      if (err) done(reject, err);
    });
  });
}

const PLATFORMS = { w: "Windows", l: "Linux", m: "Mac" };

export function parseInfo(res) {
  if (res.length < 7 || res[4] !== 0x49) {
    throw new Error(`unexpected A2S response (header 0x${(res[4] ?? 0).toString(16)})`);
  }
  let o = 6; // 4-byte split marker + header byte + protocol byte
  const malformed = () => new Error("malformed A2S response");
  const u8 = () => {
    if (o >= res.length) throw malformed();
    return res[o++];
  };
  const u16 = () => {
    if (o + 2 > res.length) throw malformed();
    o += 2;
    return res.readUInt16LE(o - 2);
  };
  const str = () => {
    const end = res.indexOf(0, o);
    if (end < 0) throw malformed();
    const s = res.toString("utf8", o, end);
    o = end + 1;
    return s;
  };

  const name = str();
  const map = str();
  str(); // folder
  str(); // game
  u16(); // app id
  const players = u8();
  const maxPlayers = u8();
  u8(); // bots
  u8(); // server type
  const platform = String.fromCharCode(u8());
  const visibility = u8();
  u8(); // VAC
  const version = str();

  let gamePort = null;
  let keywords = "";
  if (o < res.length) {
    const edf = u8(); // optional extra-data flags
    if (edf & 0x80) gamePort = u16();
    if (edf & 0x10) {
      if (o + 8 > res.length) throw malformed();
      o += 8; // server steam id
    }
    if (edf & 0x40) {
      u16(); // spectator port
      str(); // spectator name
    }
    if (edf & 0x20) keywords = str();
  }

  // DayZ packs its server flags into the keywords string, e.g. "battleye,no3rd,...,06:07".
  const kw = keywords.split(",");
  return {
    name,
    map,
    players,
    maxPlayers,
    version,
    platform: PLATFORMS[platform] ?? platform,
    passwordProtected: visibility === 1,
    gamePort,
    battleye: kw.includes("battleye"),
    thirdPerson: !kw.includes("no3rd"),
    gameTime: kw.find((k) => /^\d{2}:\d{2}$/.test(k)) ?? null,
  };
}

// allowPrivate: also query loopback / LAN / link-local addresses (the app turns this off unless told otherwise).
export async function queryInfo(host, port, { timeoutMs = 3000, allowPrivate = true } = {}) {
  const ip = await resolveHost(host, { allowPrivate });
  let res = await send(ip, port, A2S_INFO, timeoutMs);
  if (res[4] === 0x41) {
    // Server demands a challenge: resend with the 4 challenge bytes appended.
    res = await send(ip, port, Buffer.concat([A2S_INFO, res.subarray(5, 9)]), timeoutMs);
  }
  return parseInfo(res);
}
