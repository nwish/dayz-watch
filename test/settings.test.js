import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Settings, SettingsError } from "../src/settings.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dw-settings-"));
const values = (s) => Object.fromEntries(Object.entries(s.describe()).map(([k, v]) => [k, v.value]));

test("defaults come from the environment, clamped into range; junk falls back to the built-in value", () => {
  const dir = tmp();
  try {
    assert.deepEqual(values(new Settings(dir, {})), { pollSeconds: 30, offlineAfter: 3, recheckSeconds: 5, rebootWindowMinutes: 10, parkAfterDays: 7, parkedPollMinutes: 10 });
    const env = { POLL_SECONDS: "1", OFFLINE_AFTER: "2.9", RECHECK_SECONDS: "abc", REBOOT_WINDOW_MINUTES: "0", PARK_AFTER_DAYS: "-5", PARKED_POLL_MINUTES: "9999" };
    assert.deepEqual(values(new Settings(dir, env)), { pollSeconds: 5, offlineAfter: 2, recheckSeconds: 5, rebootWindowMinutes: 0, parkAfterDays: 0, parkedPollMinutes: 1440 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved override beats the environment and survives a restart; null goes back to the environment", () => {
  const dir = tmp();
  try {
    const env = { POLL_SECONDS: "60" };
    const s = new Settings(dir, env);
    const after = s.update({ pollSeconds: 15, offlineAfter: 4 });
    assert.deepEqual([after.pollSeconds.value, after.pollSeconds.default, after.pollSeconds.overridden], [15, 60, true]);

    const reloaded = new Settings(dir, env);
    assert.deepEqual(values(reloaded), { pollSeconds: 15, offlineAfter: 4, recheckSeconds: 5, rebootWindowMinutes: 10, parkAfterDays: 7, parkedPollMinutes: 10 });

    reloaded.update({ pollSeconds: null });
    assert.equal(new Settings(dir, env).values.pollSeconds, 60); // the environment applies again
    assert.equal(new Settings(dir, { POLL_SECONDS: "90" }).values.pollSeconds, 90); // and a later .env change is followed
    assert.equal(new Settings(dir, { PARK_AFTER_DAYS: "3" }).values.parkAfterDays, 3);
    assert.equal(reloaded.update({ parkAfterDays: 0 }).parkAfterDays.value, 0); // 0 is a real value (never park), not "unset"
    assert.throws(() => reloaded.update({ parkedPollMinutes: 0 }), SettingsError);
    assert.equal(new Settings(dir, env).values.offlineAfter, 4); // the other override is untouched
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update rejects bad input and changes nothing, in memory or on disk", () => {
  const dir = tmp();
  try {
    const s = new Settings(dir, {});
    s.update({ offlineAfter: 5 });
    const file = fs.readFileSync(s.file, "utf8");
    for (const bad of [{ pollSeconds: 20, offlineAfter: 0 }, { pollSeconds: 4 }, { pollSeconds: 3601 }, { offlineAfter: 2.5 }, { pollSeconds: "20" }, { pollSeconds: NaN }, { rebootWindowMinutes: -1 }, { nope: 1 }, {}, [], null]) {
      assert.throws(() => s.update(bad), SettingsError, JSON.stringify(bad));
    }
    assert.deepEqual(s.overrides, { offlineAfter: 5 });
    assert.equal(fs.readFileSync(s.file, "utf8"), file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged settings file never stops startup: bad entries are ignored, good ones kept", () => {
  const dir = tmp();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{not json");
    assert.equal(new Settings(dir, {}).values.pollSeconds, 30);
    fs.writeFileSync(file, JSON.stringify({ pollSeconds: 12, offlineAfter: -3, bogus: 1 }));
    assert.deepEqual(new Settings(dir, {}).overrides, { pollSeconds: 12 });
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
