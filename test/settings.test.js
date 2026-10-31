import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Settings, SettingsError } from "../src/settings.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dw-settings-"));
const values = (s) => Object.fromEntries(Object.entries(s.describe()).map(([k, v]) => [k, v.value]));
const DEFAULTS = { pollSeconds: 30, offlineAfter: 3, recheckSeconds: 5, rebootWindowMinutes: 10, parkAfterDays: 7, parkedPollMinutes: 10 };

test("first start seeds settings.json with every setting at its built-in default", () => {
  const dir = tmp();
  try {
    const s = new Settings(dir);
    assert.deepEqual(values(s), DEFAULTS);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.file, "utf8")), DEFAULTS);
    assert.deepEqual(Object.values(s.describe()).map((d) => d.overridden), [false, false, false, false, false, false]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saved values win and survive a restart; null goes back to the built-in default", () => {
  const dir = tmp();
  try {
    const s = new Settings(dir);
    const after = s.update({ pollSeconds: 15, offlineAfter: 4 });
    assert.deepEqual([after.pollSeconds.value, after.pollSeconds.default, after.pollSeconds.overridden], [15, 30, true]);

    const reloaded = new Settings(dir);
    assert.deepEqual(values(reloaded), { ...DEFAULTS, pollSeconds: 15, offlineAfter: 4 });

    reloaded.update({ pollSeconds: null });
    assert.equal(new Settings(dir).values.pollSeconds, 30); // back to the built-in default
    assert.equal(new Settings(dir).describe().pollSeconds.overridden, false);
    assert.equal(reloaded.update({ parkAfterDays: 0 }).parkAfterDays.value, 0); // 0 is a real value (never park), not "unset"
    assert.throws(() => new Settings(dir).update({ parkedPollMinutes: 0 }), SettingsError);
    assert.equal(new Settings(dir).values.offlineAfter, 4); // the other change is untouched
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a hand edit to settings.json is picked up on restart; a missing key falls back to the default", () => {
  const dir = tmp();
  try {
    new Settings(dir);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ pollSeconds: 90 }));
    const s = new Settings(dir);
    assert.equal(s.values.pollSeconds, 90);
    assert.equal(s.values.parkAfterDays, DEFAULTS.parkAfterDays);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update rejects bad input and changes nothing, in memory or on disk", () => {
  const dir = tmp();
  try {
    const s = new Settings(dir);
    s.update({ offlineAfter: 5 });
    const file = fs.readFileSync(s.file, "utf8");
    for (const bad of [{ pollSeconds: 20, offlineAfter: 0 }, { pollSeconds: 4 }, { pollSeconds: 3601 }, { offlineAfter: 2.5 }, { pollSeconds: "20" }, { pollSeconds: NaN }, { rebootWindowMinutes: -1 }, { nope: 1 }, {}, [], null]) {
      assert.throws(() => s.update(bad), SettingsError, JSON.stringify(bad));
    }
    assert.deepEqual(s.saved, { ...DEFAULTS, offlineAfter: 5 });
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
    assert.deepEqual(new Settings(dir).values, DEFAULTS); // defaults apply; the broken file is left for the operator
    fs.writeFileSync(file, JSON.stringify({ pollSeconds: 12, offlineAfter: -3, bogus: 1 }));
    assert.deepEqual(new Settings(dir).saved, { ...DEFAULTS, pollSeconds: 12 }); // bad entries fall back to defaults
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
