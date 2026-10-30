// Monitoring settings an admin can change at runtime. The environment supplies the defaults; a value saved from
// the admin panel (data/settings.json) overrides it until it is reset. Only keys the admin actually changed are
// stored, so editing .env later still moves every setting that was never overridden.
import fs from "node:fs";
import path from "node:path";

export class SettingsError extends Error {
  status = 400;
}

// env: the variable that supplies the default. fallback: used when it is unset or not a number.
// min/max: the range accepted from the panel; an out-of-range env value is clamped into it instead.
export const FIELDS = {
  pollSeconds: { env: "POLL_SECONDS", fallback: 30, min: 5, max: 3600, label: "Poll interval (seconds)" },
  offlineAfter: { env: "OFFLINE_AFTER", fallback: 3, min: 1, max: 100, integer: true, label: "Failed polls before offline" },
  recheckSeconds: { env: "RECHECK_SECONDS", fallback: 5, min: 2, max: 3600, label: "Recheck interval while not answering (seconds)" },
  rebootWindowMinutes: { env: "REBOOT_WINDOW_MINUTES", fallback: 10, min: 0, max: 1440, label: "Restart window (minutes)" },
  parkAfterDays: { env: "PARK_AFTER_DAYS", fallback: 7, min: 0, max: 365, label: "Park a server after (days offline, 0 = never)" },
  parkedPollMinutes: { env: "PARKED_POLL_MINUTES", fallback: 10, min: 1, max: 1440, label: "Check a parked server every (minutes)" },
};

function fromEnv(f, raw) {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return f.fallback;
  const v = Math.min(f.max, Math.max(f.min, n));
  return f.integer ? Math.floor(v) : v;
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
    this.defaults = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, fromEnv(f, env[f.env])]));
    this.overrides = {};
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.file)) return;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      console.warn(`ignoring unreadable ${this.file}: ${e.message}`);
      return;
    }
    for (const [k, v] of Object.entries(saved ?? {})) {
      try {
        if (!FIELDS[k]) throw new SettingsError(`unknown setting ${k}`);
        this.overrides[k] = validate(k, v);
      } catch (e) {
        console.warn(`ignoring ${this.file}: ${e.message}`);
      }
    }
  }

  // The effective value of every setting.
  get values() {
    return { ...this.defaults, ...this.overrides };
  }

  // What the admin panel shows: per setting the effective value, the env/built-in default and whether it is overridden.
  describe() {
    const v = this.values;
    return Object.fromEntries(
      Object.entries(FIELDS).map(([k, f]) => [
        k,
        { value: v[k], default: this.defaults[k], overridden: k in this.overrides, min: f.min, max: f.max, integer: Boolean(f.integer), label: f.label },
      ]),
    );
  }

  // patch: { key: number } saves an override, { key: null } drops it so the default applies again. Nothing is
  // changed unless every entry is valid.
  update(patch) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new SettingsError("expected an object of settings");
    const entries = Object.entries(patch);
    if (!entries.length) throw new SettingsError("nothing to change");
    const next = { ...this.overrides };
    for (const [k, v] of entries) {
      if (!FIELDS[k]) throw new SettingsError(`unknown setting ${k}`);
      if (v === null) delete next[k];
      else next[k] = validate(k, v);
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    this.overrides = next;
    return this.describe();
  }
}
