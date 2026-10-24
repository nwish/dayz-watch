// Minimal Steam A2S_INFO client (UDP). DayZ answers on game port + 1.
import dgram from "node:dgram";

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

function cstr(buf, off) {
  const end = buf.indexOf(0, off);
  if (end < 0) throw new Error("malformed A2S response");
  return [buf.toString("utf8", off, end), end + 1];
}

export function parseInfo(res) {
  if (res.length < 7 || res[4] !== 0x49) {
    throw new Error(`unexpected A2S response (header 0x${(res[4] ?? 0).toString(16)})`);
  }
  let o = 6; // 4-byte split marker + header byte + protocol byte
  let name, map;
  [name, o] = cstr(res, o);
  [map, o] = cstr(res, o);
  [, o] = cstr(res, o); // folder
  [, o] = cstr(res, o); // game
  o += 2; // app id
  if (o + 2 > res.length) throw new Error("malformed A2S response");
  return { name, map, players: res[o], maxPlayers: res[o + 1] };
}

export async function queryInfo(host, port, { timeoutMs = 3000 } = {}) {
  let res = await send(host, port, A2S_INFO, timeoutMs);
  if (res[4] === 0x41) {
    // Server demands a challenge: resend with the 4 challenge bytes appended.
    res = await send(host, port, Buffer.concat([A2S_INFO, res.subarray(5, 9)]), timeoutMs);
  }
  return parseInfo(res);
}
