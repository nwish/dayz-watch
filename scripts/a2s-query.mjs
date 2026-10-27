// Prints everything a game server answers to the three Steam server queries: A2S_INFO, A2S_PLAYER and A2S_RULES.
// Handy for checking what a server reports (for instance whether its Steam ID is the same after a restart).
//
//   node scripts/a2s-query.mjs <host> <queryPort>     (DayZ answers on game port + 1)
//
// Needs outbound UDP to the server. No dependencies. INFO is parsed the way the app parses it; PLAYER and RULES are
// best effort (RULES replies can be split over several packets) and a failure there is reported, not fatal.
import dgram from "node:dgram";

const [host, portArg] = process.argv.slice(2);
const port = Number(portArg);
if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("usage: node scripts/a2s-query.mjs <host> <queryPort>");
  process.exit(2);
}

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const TIMEOUT_MS = 4000;
const SPLIT_GRACE_MS = 1200; // after a split packet arrives, wait this long for the rest

// Sends one request and resolves with the first reply (or, with collect, every packet of a split reply).
function ask(payload, { collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const packets = [];
    let timer = setTimeout(() => finish(collect && packets.length ? packets : null), TIMEOUT_MS);
    function finish(result) {
      clearTimeout(timer);
      sock.close();
      result ? resolve(result) : reject(new Error("no answer (timeout)"));
    }
    sock.on("message", (msg) => {
      packets.push(msg);
      const split = msg.readInt32LE(0) === -2;
      if (!collect || !split) return finish(collect ? packets : msg);
      clearTimeout(timer);
      timer = setTimeout(() => finish(packets), SPLIT_GRACE_MS);
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      sock.close();
      reject(e);
    });
    sock.send(payload, port, host, (e) => e && reject(e));
  });
}

// A request that may be answered with a challenge (0x41) first: repeat it with the challenge number.
async function askWithChallenge(type, body = Buffer.alloc(0), opts) {
  const request = (challenge) => Buffer.concat([HEADER, Buffer.from([type]), body, challenge]);
  let res = await ask(request(Buffer.alloc(0)), opts);
  if (!Array.isArray(res) && res[4] === 0x41) res = await ask(request(res.subarray(5, 9)), opts);
  else if (Array.isArray(res) && res[0][4] === 0x41) res = await ask(request(res[0].subarray(5, 9)), opts);
  return res;
}

function reader(buf, offset = 0) {
  let o = offset;
  const need = (n) => {
    if (o + n > buf.length) throw new Error("reply ended early");
  };
  return {
    left: () => buf.length - o,
    u8: () => (need(1), buf[o++]),
    u16: () => (need(2), (o += 2, buf.readUInt16LE(o - 2))),
    i32: () => (need(4), (o += 4, buf.readInt32LE(o - 4))),
    f32: () => (need(4), (o += 4, buf.readFloatLE(o - 4))),
    u64: () => (need(8), (o += 8, buf.readBigUInt64LE(o - 8))),
    str: () => {
      const end = buf.indexOf(0, o);
      if (end < 0) throw new Error("unterminated string");
      const s = buf.toString("utf8", o, end);
      o = end + 1;
      return s;
    },
  };
}

// ---- A2S_INFO ----
async function info() {
  const res = await askWithChallenge(0x54, Buffer.from("Source Engine Query\0"));
  if (res[4] !== 0x49) throw new Error(`unexpected reply type 0x${res[4].toString(16)}`);
  const r = reader(res, 5);
  const out = {
    protocol: r.u8(), name: r.str(), map: r.str(), folder: r.str(), game: r.str(), appId: r.u16(),
    players: r.u8(), maxPlayers: r.u8(), bots: r.u8(), serverType: String.fromCharCode(r.u8()),
    environment: String.fromCharCode(r.u8()), visibility: r.u8() ? "password" : "public", vac: r.u8() ? "secured" : "unsecured",
    version: r.str(),
  };
  if (r.left() > 0) {
    const edf = r.u8();
    out.extraDataFlags = `0x${edf.toString(16)}`;
    if (edf & 0x80) out.gamePort = r.u16();
    if (edf & 0x10) {
      const id = r.u64();
      out.steamId = id.toString();
      out.steamIdHex = `0x${id.toString(16)}`;
    } else {
      out.steamId = null; // the server doesn't send one
    }
    if (edf & 0x40) (out.spectatorPort = r.u16()), (out.spectatorName = r.str());
    if (edf & 0x20) out.keywords = r.str();
    if (edf & 0x01) out.gameId = r.u64().toString(); // the full app id; DayZ's 221100 does not fit the 16-bit appId above
  }
  return out;
}

// ---- A2S_PLAYER ----
async function players() {
  const res = await askWithChallenge(0x55);
  if (res[4] !== 0x44) throw new Error(`unexpected reply type 0x${res[4].toString(16)}`);
  const r = reader(res, 5);
  const count = r.u8();
  const list = [];
  for (let i = 0; i < count; i++) list.push({ index: r.u8(), name: r.str(), score: r.i32(), durationSeconds: Math.round(r.f32()) });
  return { count, list };
}

// ---- A2S_RULES ----
async function rules() {
  const res = await askWithChallenge(0x56, Buffer.alloc(0), { collect: true });
  const packets = Array.isArray(res) ? res : [res];
  let body;
  if (packets[0].readInt32LE(0) === -2) {
    if (packets[0].readUInt32LE(4) & 0x80000000) throw new Error("the reply is compressed (bzip2), which this script doesn't unpack");
    // Split reply: 4 bytes marker, 4 id, 1 total, 1 number, 2 packet size, then the data. Only the first packet carries the 0xFFFFFFFF prefix.
    const parts = packets.map((m) => ({ number: m[9], data: m.subarray(12) })).sort((a, b) => a.number - b.number);
    if (parts.length !== packets[0][8]) throw new Error(`got ${parts.length} of ${packets[0][8]} packets`);
    body = Buffer.concat(parts.map((p) => p.data)).subarray(4);
  } else {
    body = packets[0];
  }
  if (body[0] !== 0x45) throw new Error(`unexpected reply type 0x${body[0].toString(16)}`);
  const r = reader(body, 1);
  const count = r.u16();
  const out = {};
  for (let i = 0; i < count; i++) {
    try {
      out[r.str()] = r.str();
    } catch {
      break; // a truncated tail still leaves the rules before it
    }
  }
  return { declared: count, rules: out };
}

let failed = false;
for (const [title, run] of [["A2S_INFO", info], ["A2S_PLAYER", players], ["A2S_RULES", rules]]) {
  try {
    const result = await run();
    console.log(`=== ${title} ===`);
    console.log(JSON.stringify(result, null, 2));
    if (title === "A2S_INFO" && result.keywords) console.log("keywords split:", JSON.stringify(result.keywords.split(",")));
  } catch (e) {
    console.log(`=== ${title} failed: ${e.message} ===`);
    if (title === "A2S_INFO") failed = true; // nothing else is worth trying against a server that doesn't answer INFO
  }
  console.log();
  if (failed) break;
}
process.exit(failed ? 1 : 0);
