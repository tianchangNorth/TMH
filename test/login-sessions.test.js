import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoginSessionStore } from "../src/login-sessions.mjs";

async function withStore(callback) {
  const dir = await mkdtemp(join(tmpdir(), "tml-sessions-"));
  const filePath = join(dir, "login-sessions.json");
  try {
    return await callback(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("start and get a session, then clear it", async () => {
  await withStore(async (filePath) => {
    const store = new LoginSessionStore({ filePath, ttlMs: 60_000 });
    await store.start("oc-1", { phone: "13800000000", smsId: "s1", globalAreaId: 1, areaId: 1, parkId: 1, senderId: "ou-a" });
    const s = store.get("oc-1");
    assert.equal(s.phone, "13800000000");
    assert.equal(s.smsId, "s1");
    await store.clear("oc-1");
    assert.equal(store.get("oc-1"), null);
  });
});

test("start rejects a second in-flight session on the same chat", async () => {
  await withStore(async (filePath) => {
    const store = new LoginSessionStore({ filePath, ttlMs: 60_000 });
    await store.start("oc-1", { phone: "13800000000", smsId: "s1", globalAreaId: 1, areaId: 1, parkId: 1 });
    await assert.rejects(
      store.start("oc-1", { phone: "13900000000", smsId: "s2", globalAreaId: 1, areaId: 1, parkId: 1 }),
      /已有进行中的登录会话/,
    );
  });
});

test("get returns null and cleans up after expiry so a new session can start", async () => {
  await withStore(async (filePath) => {
    const store = new LoginSessionStore({ filePath, ttlMs: 10 });
    await store.start("oc-1", { phone: "13800000000", smsId: "s1", globalAreaId: 1, areaId: 1, parkId: 1 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.get("oc-1"), null);
    // 过期后会话已清理，可重新发起（不抛「已有进行中」错误）
    await assert.doesNotReject(
      store.start("oc-1", { phone: "13800000000", smsId: "s2", globalAreaId: 1, areaId: 1, parkId: 1 }),
    );
  });
});

test("persist writes a 0600 file and load recovers non-expired sessions", async () => {
  await withStore(async (filePath) => {
    const store = new LoginSessionStore({ filePath, ttlMs: 60_000 });
    await store.start("oc-1", { phone: "13800000000", smsId: "s1", globalAreaId: 1, areaId: 1, parkId: 1 });
    const fileStat = await stat(filePath);
    assert.equal(fileStat.mode & 0o077, 0o000);

    const restored = new LoginSessionStore({ filePath, ttlMs: 60_000 });
    await restored.load();
    assert.equal(restored.get("oc-1")?.smsId, "s1");
  });
});

test("load discards expired sessions", async () => {
  await withStore(async (filePath) => {
    const store = new LoginSessionStore({ filePath, ttlMs: 10 });
    await store.start("oc-1", { phone: "13800000000", smsId: "s1", globalAreaId: 1, areaId: 1, parkId: 1 });
    await new Promise((r) => setTimeout(r, 20));
    const restored = new LoginSessionStore({ filePath, ttlMs: 60_000 });
    await restored.load();
    assert.equal(restored.get("oc-1"), null);
  });
});

test("clearExpired removes expired sessions", async () => {
  await withStore(async (filePath) => {
    const store = new LoginSessionStore({ filePath, ttlMs: 10 });
    await store.start("oc-1", { phone: "13800000000", smsId: "s1", globalAreaId: 1, areaId: 1, parkId: 1 });
    await store.start("oc-2", { phone: "13900000000", smsId: "s2", globalAreaId: 1, areaId: 1, parkId: 1 });
    await new Promise((r) => setTimeout(r, 20));
    await store.clearExpired();
    assert.equal(store.get("oc-1"), null);
    assert.equal(store.get("oc-2"), null);
  });
});
