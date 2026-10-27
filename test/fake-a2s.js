// Fake A2S server for tests: demands a challenge before answering, like real DayZ servers.
import dgram from "node:dgram";

const cs = (s) => Buffer.from(`${s}\0`);
export const KEYWORDS = "battleye,no3rd,shard000,lqs0,etm3.290000,entm3.290000,isDLC4,06:07";

// folder / game / appId / gameId: what the server claims to be (the defaults look like DayZ). gameId is the
// 64-bit Steam app id sent in the extra data, where ids above 65535 have to go. steamId is the server's own Steam ID.
export function fakeA2S(getPlayers, { folder = "dayz", game = "game", appId = 0, gameId = null, steamId = null } = {}) {
  return new Promise((resolve) => {
    const udp = dgram.createSocket("udp4");
    udp.on("message", (m, r) => {
      if (m.length === 25) return udp.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4]), r.port, r.address);
      const port = Buffer.alloc(2);
      port.writeUInt16LE(11300);
      const id = Buffer.alloc(2);
      id.writeUInt16LE(appId);
      const body = Buffer.concat([
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
        cs("TestSrv"), cs("nasdara"), cs(folder), cs(game), id,
        Buffer.from([getPlayers(), 60, 0, 0x64, 0x77, 0, 0]), // players, max, bots, dedicated, windows, public, no VAC
        cs("1.30.164200"),
        Buffer.from([0xa0 | (steamId === null ? 0 : 0x10) | (gameId === null ? 0 : 1)]), port, // EDF: game port (+ Steam id) + keywords (+ game id)
        ...(steamId === null ? [] : [Buffer.from(new BigUint64Array([BigInt(steamId)]).buffer)]),
        cs(KEYWORDS),
        ...(gameId === null ? [] : [Buffer.from(new BigUint64Array([BigInt(gameId)]).buffer)]),
      ]);
      udp.send(body, r.port, r.address);
    });
    udp.bind(0, "127.0.0.1", () => resolve(udp));
  });
}
