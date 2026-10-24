import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FailureLimiter, SessionStore, UserStore, bootstrapAdmin } from "../src/auth.js";

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms) => (c.t += ms) };
  return c;
}

test("limiter: locks after max failures, unlocks after lockMs, reset clears", () => {
  const c = clock();
  const l = new FailureLimiter({ max: 3, windowMs: 60_000, lockMs: 120_000, now: c.now });
  l.fail("k");
  l.fail("k");
  assert.equal(l.retryAfter("k"), 0);
  l.fail("k");
  assert.equal(l.retryAfter("k"), 120);
  c.advance(100_000);
  assert.equal(l.retryAfter("k"), 20);
  c.advance(21_000);
  assert.equal(l.retryAfter("k"), 0);
  // a fresh window starts after the lock: two more failures don't relock
  l.fail("k");
  l.fail("k");
  assert.equal(l.retryAfter("k"), 0);
  l.reset("k");
  l.fail("k");
  l.fail("k");
  assert.equal(l.retryAfter("k"), 0);
});

test("limiter: failures outside the window don't count; keys are independent", () => {
  const c = clock();
  const l = new FailureLimiter({ max: 3, windowMs: 60_000, lockMs: 60_000, now: c.now });
  l.fail("a");
  l.fail("a");
  c.advance(61_000);
  l.fail("a"); // the earlier two expired
  assert.equal(l.retryAfter("a"), 0);
  l.fail("b");
  l.fail("b");
  l.fail("b");
  assert.ok(l.retryAfter("b") > 0);
  assert.equal(l.retryAfter("a"), 0);
});

test("limiter: bounded memory evicts the oldest key", () => {
  const l = new FailureLimiter({ max: 1, windowMs: 60_000, lockMs: 60_000, maxKeys: 2 });
  l.fail("a");
  l.fail("b");
  l.fail("c"); // evicts "a"
  assert.equal(l.retryAfter("a"), 0);
  assert.ok(l.retryAfter("b") > 0);
  assert.ok(l.retryAfter("c") > 0);
});

test("sessions: idle timeout, absolute lifetime, sliding refresh, per-user revoke", () => {
  const c = clock();
  const s = new SessionStore({ idleMs: 1000, maxMs: 5000, now: c.now });
  const t1 = s.create("alice");
  c.advance(900);
  assert.equal(s.get(t1).username, "alice"); // refreshes idle timer
  c.advance(900);
  assert.ok(s.get(t1));
  c.advance(1100);
  assert.equal(s.get(t1), null); // idle

  const t2 = s.create("alice");
  for (let i = 0; i < 4; i++) {
    c.advance(900);
    assert.ok(s.get(t2));
  }
  c.advance(1500); // total > maxMs even though never idle
  assert.equal(s.get(t2), null);

  const a = s.create("bob");
  const b = s.create("bob");
  const other = s.create("carol");
  s.destroyUser("bob", a);
  assert.ok(s.get(a));
  assert.equal(s.get(b), null);
  assert.ok(s.get(other));
  assert.equal(s.get("garbage"), null);
  assert.equal(s.get(undefined), null);
});

test("users: create/verify, wrong or unknown credentials, normalisation, persistence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-auth-"));
  try {
    const u = new UserStore(dir);
    await u.create({ username: " Alice ", password: "correct horse battery", role: "admin" });
    assert.equal((await u.verify("ALICE", "correct horse battery")).username, "alice");
    assert.equal(await u.verify("alice", "wrong password!!"), null);
    assert.equal(await u.verify("nobody", "correct horse battery"), null);
    assert.equal(await u.verify("alice", undefined), null);
    assert.equal(await u.verify({ $ne: "" }, "correct horse battery"), null);
    await assert.rejects(u.create({ username: "alice", password: "another long password" }), /already exists/);
    await assert.rejects(u.create({ username: "bob", password: "short" }), /10-128/);
    await assert.rejects(u.create({ username: "b o b", password: "another long password" }), /username/);
    await assert.rejects(u.create({ username: "bob", password: "another long password", role: "root" }), /role/);

    assert.ok(!fs.readFileSync(path.join(dir, "users.json"), "utf8").includes("correct horse"), "plaintext never stored");
    const reloaded = new UserStore(dir);
    assert.equal((await reloaded.verify("alice", "correct horse battery")).role, "admin");

    await u.setPassword("alice", "a brand new password");
    assert.equal(await u.verify("alice", "correct horse battery"), null);
    assert.ok(await u.verify("alice", "a brand new password"));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("users: the last admin cannot be demoted or deleted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-auth-"));
  try {
    const u = new UserStore(dir);
    await u.create({ username: "root", password: "a very long password", role: "admin" });
    await u.create({ username: "bob", password: "another long password" });
    assert.throws(() => u.setRole("root", "user"), /last admin/);
    assert.throws(() => u.remove("root"), /last admin/);
    u.setRole("bob", "admin");
    u.setRole("root", "user"); // fine now: bob is also an admin
    assert.throws(() => u.remove("bob"), /last admin/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("bootstrap: creates the admin once; generates a password only when none given", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-auth-"));
  try {
    const u = new UserStore(dir);
    const generated = await bootstrapAdmin(u, { username: "boss" });
    assert.ok(generated && generated.length >= 15);
    assert.equal((await u.verify("boss", generated)).role, "admin");
    assert.equal(await bootstrapAdmin(u, { username: "other", password: "irrelevant password" }), null);
    assert.equal(u.count(), 1);

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "dw-auth-"));
    try {
      const u2 = new UserStore(dir2);
      assert.equal(await bootstrapAdmin(u2, { password: "supplied password!" }), null);
      assert.ok(await u2.verify("admin", "supplied password!"));
    } finally {
      fs.rmSync(dir2, { recursive: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
