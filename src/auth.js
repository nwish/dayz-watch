// Users, password hashing, sessions and login rate limiting. No dependencies: scrypt + in-memory state.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const scryptRaw = promisify(crypto.scrypt);
const KEYLEN = 64;

// scrypt runs on libuv's small thread pool (4 threads, shared with DNS lookups and file I/O). Unauthenticated
// logins reach it, so only a couple run at once and the queue is bounded: a flood gets a quick 503 instead of
// starving everything else, and costs nothing beyond the queue.
const MAX_HASHING = 2;
const MAX_WAITING = 16;
let hashing = 0;
const waiting = [];
async function scrypt(...args) {
  if (hashing >= MAX_HASHING) {
    if (waiting.length >= MAX_WAITING) throw new AuthError("server busy, try again in a moment", 503);
    await new Promise((resolve) => waiting.push(resolve));
  } else {
    hashing++;
  }
  try {
    return await scryptRaw(...args);
  } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot straight to the next waiter
    else hashing--;
  }
}

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function checkPassword(password, stored) {
  const [alg, saltHex, keyHex] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(keyHex, "hex");
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

// Verified against when the username doesn't exist, so "no such user" costs the same as "wrong password".
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString("hex"));

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
export const ROLES = ["admin", "user"];

export function normalizeUsername(username) {
  const name = typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!USERNAME_RE.test(name)) throw new AuthError("username must be 3-32 characters: letters, digits, . _ -");
  return name;
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 10 || password.length > 128) {
    throw new AuthError("password must be 10-128 characters");
  }
}

function validateRole(role) {
  if (!ROLES.includes(role)) throw new AuthError(`role must be one of: ${ROLES.join(", ")}`);
}

const view = (u) => ({ username: u.username, role: u.role, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, ...(u.mustChangePassword ? { mustChangePassword: true } : {}) });

export class UserStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "users.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this.users = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")).users : [];
  }

  #find(username) {
    return this.users.find((u) => u.username === username);
  }

  #save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  #adminCount() {
    return this.users.filter((u) => u.role === "admin").length;
  }

  count() {
    return this.users.length;
  }

  list() {
    return this.users.map(view);
  }

  get(username) {
    const u = this.#find(username);
    return u && view(u);
  }

  async create({ username, password, role = "user" }) {
    const name = normalizeUsername(username);
    validatePassword(password);
    validateRole(role);
    if (this.#find(name)) throw new AuthError("username already exists", 409);
    const passwordHash = await hashPassword(password);
    if (this.#find(name)) throw new AuthError("username already exists", 409); // created while hashing
    const user = { username: name, role, passwordHash, createdAt: new Date().toISOString(), lastLoginAt: null };
    this.users.push(user);
    this.#save();
    return view(user);
  }

  // Returns the user view on success, null otherwise. Same work either way (see DUMMY_HASH).
  async verify(username, password) {
    const user = typeof username === "string" ? this.#find(username.trim().toLowerCase()) : undefined;
    const okInput = typeof password === "string" && password.length <= 1024;
    const match = okInput && (await checkPassword(password, user?.passwordHash ?? DUMMY_HASH));
    return match && user ? view(user) : null;
  }

  async setPassword(username, password) {
    validatePassword(password);
    if (!this.#find(username)) throw new AuthError("user not found", 404);
    const passwordHash = await hashPassword(password);
    const user = this.#find(username);
    if (!user) throw new AuthError("user not found", 404);
    user.passwordHash = passwordHash;
    delete user.mustChangePassword; // a chosen password is no longer a temporary one
    this.#save();
  }

  // Rename an account. The username is the key sessions and admin routes carry, so the caller must
  // rename the sessions too. Returns the updated view.
  setUsername(username, newUsername) {
    const name = normalizeUsername(newUsername);
    const user = this.#find(username);
    if (!user) throw new AuthError("user not found", 404);
    if (name !== username) {
      if (this.#find(name)) throw new AuthError("username already exists", 409);
      user.username = name;
      this.#save();
    }
    return view(user);
  }

  setRole(username, role) {
    validateRole(role);
    const user = this.#find(username);
    if (!user) throw new AuthError("user not found", 404);
    if (user.role === "admin" && role !== "admin" && this.#adminCount() === 1) {
      throw new AuthError("cannot demote the last admin");
    }
    user.role = role;
    this.#save();
    return view(user);
  }

  remove(username) {
    const i = this.users.findIndex((u) => u.username === username);
    if (i < 0) throw new AuthError("user not found", 404);
    if (this.users[i].role === "admin" && this.#adminCount() === 1) throw new AuthError("cannot delete the last admin");
    this.users.splice(i, 1);
    this.#save();
  }

  touchLogin(username) {
    const user = this.#find(username);
    if (!user) return;
    user.lastLoginAt = new Date().toISOString();
    this.#save();
  }

  // Flag an account as still using a temporary password (bootstrap only; setPassword clears it). The server
  // then lets it reach only the Account page until the password is replaced.
  markTempPassword(username) {
    const user = this.#find(username);
    if (!user) return;
    user.mustChangePassword = true;
    this.#save();
  }
}

// On first start with no users, create the initial admin with a random password, printed once in the log.
// The account is flagged mustChangePassword: the temporary password only unlocks the Account page until it
// is replaced. Returns the generated password, or null when users already existed.
export async function bootstrapAdmin(users) {
  if (users.count() > 0) return null;
  const generated = crypto.randomBytes(15).toString("base64url");
  await users.create({ username: "admin", password: generated, role: "admin" });
  users.markTempPassword("admin");
  return generated;
}

// Server-side sessions: random token in an HttpOnly cookie; only its hash is kept in memory.
export class SessionStore {
  constructor({ idleMs = 12 * 3600e3, maxMs = 7 * 24 * 3600e3, now = Date.now } = {}) {
    this.idleMs = idleMs;
    this.maxMs = maxMs;
    this.now = now;
    this.sessions = new Map(); // sha256(token) -> {username, created, seen}
  }

  static #key(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  // Live sessions only: expired ones linger in the map until the next sweep.
  count() {
    const t = this.now();
    let n = 0;
    for (const s of this.sessions.values()) if (t - s.seen <= this.idleMs && t - s.created <= this.maxMs) n++;
    return n;
  }

  create(username) {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = this.now();
    this.sessions.set(SessionStore.#key(token), { username, created: t, seen: t });
    return token;
  }

  get(token) {
    if (!token) return null;
    const key = SessionStore.#key(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    const t = this.now();
    if (t - s.seen > this.idleMs || t - s.created > this.maxMs) {
      this.sessions.delete(key);
      return null;
    }
    s.seen = t;
    return s;
  }

  destroy(token) {
    if (token) this.sessions.delete(SessionStore.#key(token));
  }

  // Keep live sessions working across a username change.
  rename(username, newUsername) {
    for (const s of this.sessions.values()) if (s.username === username) s.username = newUsername;
  }

  // Drop every session for a user, optionally keeping one (the caller's own).
  destroyUser(username, exceptToken) {
    const keep = exceptToken ? SessionStore.#key(exceptToken) : null;
    for (const [key, s] of this.sessions) if (s.username === username && key !== keep) this.sessions.delete(key);
  }

  sweep() {
    const t = this.now();
    for (const [key, s] of this.sessions) {
      if (t - s.seen > this.idleMs || t - s.created > this.maxMs) this.sessions.delete(key);
    }
  }
}

// Counts failures per key in a sliding window; after `max` failures the key is locked for `lockMs`.
export class FailureLimiter {
  constructor({ max, windowMs, lockMs, now = Date.now, maxKeys = 10_000 }) {
    Object.assign(this, { max, windowMs, lockMs, now, maxKeys });
    this.entries = new Map(); // key -> {fails: number[], lockedUntil: number}
  }

  // Seconds until the key may try again, 0 if it is not locked.
  retryAfter(key) {
    const e = this.entries.get(key);
    const left = e ? e.lockedUntil - this.now() : 0;
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  fail(key) {
    const t = this.now();
    let e = this.entries.get(key);
    if (!e) {
      if (this.entries.size >= this.maxKeys) this.entries.delete(this.entries.keys().next().value); // oldest
      e = { fails: [], lockedUntil: 0 };
      this.entries.set(key, e);
    }
    e.fails = e.fails.filter((ts) => t - ts < this.windowMs);
    e.fails.push(t);
    if (e.fails.length >= this.max) {
      e.lockedUntil = t + this.lockMs;
      e.fails = [];
    }
  }

  reset(key) {
    this.entries.delete(key);
  }

  sweep() {
    const t = this.now();
    for (const [key, e] of this.entries) {
      if (e.lockedUntil <= t && e.fails.every((ts) => t - ts >= this.windowMs)) this.entries.delete(key);
    }
  }
}
