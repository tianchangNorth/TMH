import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStore, maskPhone, resolveUser, saveStore } from "../src/store.mjs";

async function withTempStore(callback) {
  const dir = await mkdtemp(join(tmpdir(), "tml-store-"));
  const usersFile = join(dir, "users.json");
  const envFile = join(dir, ".env");
  const prevUsers = process.env.TML_USERS_FILE;
  const prevEnv = process.env.TML_ENV_FILE;
  process.env.TML_USERS_FILE = usersFile;
  process.env.TML_ENV_FILE = envFile;
  try {
    return await callback({ usersFile, envFile, dir });
  } finally {
    if (prevUsers === undefined) delete process.env.TML_USERS_FILE;
    else process.env.TML_USERS_FILE = prevUsers;
    if (prevEnv === undefined) delete process.env.TML_ENV_FILE;
    else process.env.TML_ENV_FILE = prevEnv;
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadStore reads users.json and resolves the default account", async () => {
  await withTempStore(async ({ usersFile }) => {
    await mkdir(join(usersFile, ".."), { recursive: true });
    await writeFile(usersFile, JSON.stringify({
      default: "13800000000",
      users: {
        "13800000000": {
          nickname: "小王",
          userId: "uid-1",
          loginsession: "sess-1",
          globalAreaId: 1,
          areaId: 1,
          parkId: 1,
        },
      },
    }, null, 2));
    const store = await loadStore();
    assert.equal(store.default, "13800000000");
    const user = resolveUser(store);
    assert.equal(user.userId, "uid-1");
    assert.equal(user.loginsession, "sess-1");
    assert.equal(user.phone, "13800000000");
  });
});

test("loadStore falls back to legacy .env single account when users.json is absent", async () => {
  await withTempStore(async ({ envFile }) => {
    await mkdir(join(envFile, ".."), { recursive: true });
    await writeFile(envFile, "TML_USER_ID=env-uid\nTML_LOGIN_SESSION=env-sess\nTML_PARK_ID=2\n");
    const store = await loadStore();
    assert.equal(Object.keys(store.users).length, 1);
    const user = resolveUser(store);
    assert.equal(user.userId, "env-uid");
    assert.equal(user.parkId, 2);
  });
});

test("loadStore throws a clear error when no credentials exist anywhere", async () => {
  await withTempStore(async () => {
    const store = await loadStore();
    assert.equal(Object.keys(store.users).length, 0);
    assert.throws(() => resolveUser(store), /还没有登录的账号/);
  });
});

test("resolveUser matches by phone, nickname, and errors on ambiguous nickname", async () => {
  await withTempStore(async ({ usersFile }) => {
    const store = {
      default: "13800000000",
      users: {
        "13800000000": { nickname: "小王", userId: "1", loginsession: "s1" },
        "13900000000": { nickname: "小王", userId: "2", loginsession: "s2" },
      },
      usersFile,
    };
    assert.equal(resolveUser(store, "13900000000").userId, "2");
    assert.throws(() => resolveUser(store, "小王"), /对应多个账号/);
  });
});

test("saveStore atomically writes users.json with 0600 permissions", async () => {
  await withTempStore(async ({ usersFile }) => {
    const store = {
      default: "13800000000",
      users: { "13800000000": { nickname: "x", userId: "1", loginsession: "s" } },
      usersFile,
    };
    await saveStore(store);
    const { readFile, stat } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(usersFile, "utf8"));
    assert.equal(raw.default, "13800000000");
    const fileStat = await stat(usersFile);
    assert.equal(fileStat.mode & 0o077, 0o000);
  });
});

test("maskPhone masks the middle of an 11-digit phone and the legacy key", () => {
  assert.equal(maskPhone("13812345678"), "138****5678");
  assert.equal(maskPhone("__legacy__"), "*");
  assert.equal(maskPhone("123"), "123");
});
