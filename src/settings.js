// Monitoring settings an admin can change at runtime. They live in data/settings.json, which is created with
// every setting at its built-in default on first start, so it can also be edited by hand (a restart picks the
// edit up). The admin panel's Reset puts a setting back to its built-in default. The pre-settings.json
// environment variables (POLL_SECONDS and friends) are read exactly once, when seeding a missing file.
import fs from "node:fs";
import path from "node:path";

export class SettingsError extends Error {
  status = 400;
}

// fallback: the built-in default. min/max: the range accepted from the panel and from the file.
// env: the legacy .env variable, read only once when seeding a missing settings.json (see seedFromEnv).
export const FIELDS = {
  pollSeconds: { env: "POLL_SECONDS", fallback: 30, min: 5, max: 3600, label: "Poll interval (seconds)" },
  offlineAfter: { env: "OFFLINE_AFTER", fallback: 3, min: 1, max: 100, integer: true, label: "Failed polls before offline" },
  recheckSeconds: { env: "RECHECK_SECONDS", fallback: 5, min: 2, max: 3600, label: "Recheck interval while not answering (seconds)" },
  rebootWindowMinutes: { env: "REBOOT_WINDOW_MINUTES", fallback: 10, min: 0, max: 1440, label: "Restart window (minutes)" },
  parkAfterDays: { env: "PARK_AFTER_DAYS", fallback: 7, min: 0, max: 365, label: "Park a server after (days offline, 0 = never)" },
  parkedPollMinutes: { env: "PARKED_POLL_MINUTES", fallback: 10, min: 1, max: 1440, label: "Check a parked server every (minutes)" },
};

const DEFAULTS = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.fallback]));

// One-time upgrade path: an install that still carries the old .env defaults gets them migrated into the
// seeded file instead of silently dropping back to the built-in values. Junk falls back to the default;
// out-of-range is clamped, as the old env handling did.
function seedFromEnv(env) {
  const seeded = { ...DEFAULTS };
  const migrated = [];
  for (const [k, f] of Object.entries(FIELDS)) {
    const raw = env[f.env];
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const v = Math.min(f.max, Math.max(f.min, n));
    seeded[k] = f.integer ? Math.floor(v) : v;
    migrated.push(`${f.env}=${seeded[k]}`);
  }
  if (migrated.length) console.log(`settings.json not found: seeded from the environment (${migrated.join(", ")}) - those variables are now ignored; change settings on the Admin page or in settings.json`);
  return seeded;
}

function validate(key, value) {
  const f = FIELDS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SettingsError(`${key} must be a number`);
  if (f.integer && !Number.isInteger(value)) throw new SettingsError(`${key} must be a whole number`);
  if (value < f.min || value > f.max) throw new SettingsError(`${key} must be between ${f.min} and ${f.max}`);
  return value;
}

export class Settings {
  constructor(dataDir, env = process.env) {
    this.file = path.join(dataDir, "settings.json");
    this.saved = { ...DEFAULTS }; // the file wins for anything it carries
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.saved = seedFromEnv(env); // first start: the file shows every setting, migrated from .env if it set them
      this.write(this.saved);
      return;
    }
    let loaded;
    try {
      loaded = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      console.warn(`ignoring unreadable ${this.file}: ${e.message}`);
      return;
    }
    for (const [k, v] of Object.entries(loaded ?? {})) {
      try {
        if (!FIELDS[k]) throw new SettingsError(`unknown setting ${k}`);
        this.saved[k] = validate(k, v);
      } catch (e) {
        console.warn(`ignoring ${this.file}: ${e.message}`);
      }
    }
  }

  // The effective value of every setting: the file, with built-in defaults for anything it doesn't carry.
  get values() {
    return { ...DEFAULTS, ...this.saved };
  }

  // What the admin panel shows: per setting the effective value, the built-in default and whether it differs.
  describe() {
    const v = this.values;
    return Object.fromEntries(
      Object.entries(FIELDS).map(([k, f]) => [
        k,
        { value: v[k], default: DEFAULTS[k], overridden: v[k] !== DEFAULTS[k], min: f.min, max: f.max, integer: Boolean(f.integer), label: f.label },
      ]),
    );
  }

  // patch: { key: number } saves a value, { key: null } resets it to the built-in default. Nothing is
  // changed unless every entry is valid.
  update(patch) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new SettingsError("expected an object of settings");
    const entries = Object.entries(patch);
    if (!entries.length) throw new SettingsError("nothing to change");
    const next = { ...this.saved };
    for (const [k, v] of entries) {
      if (!FIELDS[k]) throw new SettingsError(`unknown setting ${k}`);
      next[k] = v === null ? DEFAULTS[k] : validate(k, v);
    }
    this.write(next);
    this.saved = next;
    return this.describe();
  }

  write(values) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(values, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
