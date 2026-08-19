import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const DEFAULT_USERS_FILE = resolve(process.cwd(), "users.json");
export const DEFAULT_ENV_FILE = resolve(process.cwd(), ".env");

const LEGACY_KEY = "__legacy__";

export function parseDotEnv(text) {
  const env = {};
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) throw new Error(`.env 第 ${i + 1} 行格式错误`);
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        out[a.slice(2)] = argv[++i];
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

async function readLegacyEnv() {
  const envFile = process.env.TML_ENV_FILE || DEFAULT_ENV_FILE;
  let text;
  try {
    text = await readFile(envFile, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const env = parseDotEnv(text);
  if (!env.TML_USER_ID || !env.TML_LOGIN_SESSION) return null;
  return {
    phone: LEGACY_KEY,
    nickname: "默认用户",
    userId: env.TML_USER_ID,
    loginsession: env.TML_LOGIN_SESSION,
    globalAreaId: Number(env.TML_GLOBAL_AREA_ID || 1),
    areaId: Number(env.TML_AREA_ID || 1),
    parkId: Number(env.TML_PARK_ID || 1),
  };
}

export async function loadStore() {
  const usersFile = process.env.TML_USERS_FILE || DEFAULT_USERS_FILE;
  const store = { default: null, users: {}, usersFile };
  try {
    const raw = await readFile(usersFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.users && typeof parsed.users === "object") {
      store.default = parsed.default ?? null;
      store.users = parsed.users;
      return store;
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`users.json 解析失败：${e.message}`);
  }
  // users.json 不存在或为空，回退旧版单用户 .env
  const legacy = await readLegacyEnv();
  if (legacy) {
    store.default = legacy.phone;
    store.users = {
      [legacy.phone]: {
        nickname: legacy.nickname,
        userId: legacy.userId,
        loginsession: legacy.loginsession,
        globalAreaId: legacy.globalAreaId,
        areaId: legacy.areaId,
        parkId: legacy.parkId,
      },
    };
  }
  return store;
}

export async function saveStore(store) {
  const usersFile = store.usersFile || process.env.TML_USERS_FILE || DEFAULT_USERS_FILE;
  await mkdir(dirname(usersFile), { recursive: true });
  const data = { default: store.default, users: store.users };
  const tmp = `${usersFile}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, usersFile);
}

export function resolveUser(store, query) {
  const q = query?.trim() ?? "";
  if (!q) {
    if (store.default && store.users[store.default]) return withPhone(store, store.default);
    const phones = Object.keys(store.users);
    if (phones.length === 1) return withPhone(store, phones[0]);
    if (phones.length === 0) throw new Error("还没有登录的账号，请先执行登录流程");
    throw new Error("存在多个账号但未设置默认，请指定手机号或昵称");
  }
  if (store.users[q]) return withPhone(store, q);
  const matches = Object.entries(store.users).filter(([, u]) => u.nickname === q);
  if (matches.length === 1) return withPhone(store, matches[0][0]);
  if (matches.length > 1) throw new Error(`昵称「${q}」对应多个账号，请用手机号指定`);
  throw new Error(`未找到昵称「${q}」对应的账号，请用手机号或已登录的昵称`);
}

function withPhone(store, phone) {
  return { phone, ...store.users[phone] };
}

export function maskPhone(phone) {
  if (phone === LEGACY_KEY) return "*";
  if (typeof phone === "string" && phone.length >= 7) {
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  }
  return phone;
}
