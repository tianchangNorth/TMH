import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_SESSIONS_FILE = resolve(process.cwd(), ".runtime", "login-sessions.json");
const DEFAULT_TTL_MS = 60_000;

// 登录会话状态：内存 Map 为运行时权威源，.runtime/login-sessions.json 落盘用于重启恢复（best-effort）。
// 仅 listener 单进程使用；TTL 内有效，过期惰性清理 + 定时清理。
export class LoginSessionStore {
  constructor({ filePath = DEFAULT_SESSIONS_FILE, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.filePath = filePath;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  async load() {
    let text;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const now = Date.now();
    for (const [chatId, session] of Object.entries(parsed)) {
      if (!session || typeof session !== "object") continue;
      if (typeof session.expiresAt !== "number" || session.expiresAt <= now) continue;
      this.sessions.set(chatId, session);
    }
    await this.#persist();
  }

  async #persist() {
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const data = Object.fromEntries(this.sessions.entries());
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600).catch(() => {});
      await rename(tmp, this.filePath);
    } catch (e) {
      console.warn(`[警告] 登录会话落盘失败，降级为纯内存：${e.message}`);
    }
  }

  get(chatId) {
    const session = this.sessions.get(chatId);
    if (!session) return null;
    if (typeof session.expiresAt === "number" && session.expiresAt <= Date.now()) {
      this.sessions.delete(chatId);
      void this.#persist();
      return null;
    }
    return session;
  }

  async start(chatId, { phone, smsId, globalAreaId, areaId, parkId, senderId }) {
    const existing = this.get(chatId);
    if (existing) {
      throw new Error("已有进行中的登录会话，请先发送「取消登录」再重试");
    }
    const now = Date.now();
    const session = {
      phone,
      smsId,
      globalAreaId,
      areaId,
      parkId,
      senderId: senderId ?? null,
      startedAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(chatId, session);
    await this.#persist();
    return session;
  }

  async clear(chatId) {
    if (this.sessions.delete(chatId)) {
      await this.#persist();
    }
  }

  async clearExpired() {
    const now = Date.now();
    let changed = false;
    for (const [chatId, session] of this.sessions.entries()) {
      if (typeof session.expiresAt === "number" && session.expiresAt <= now) {
        this.sessions.delete(chatId);
        changed = true;
      }
    }
    if (changed) await this.#persist();
  }
}
