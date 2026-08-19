import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { parseBoolean, parsePositiveInteger } from "./lib.js";

const DEFAULT_COMMANDS = ["二维码", "重发二维码"];
const PENDING_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function senderIds(sender) {
  const id = sender?.sender_id || {};
  return [id.open_id, id.user_id, id.union_id].filter(Boolean);
}

function parseTextContent(content) {
  try {
    const payload = JSON.parse(content);
    return typeof payload?.text === "string" ? payload.text : null;
  } catch {
    return null;
  }
}

function commandWithoutMentions(message, text) {
  let command = text;
  for (const mention of message.mentions || []) {
    if (mention?.key) command = command.replaceAll(mention.key, " ");
  }
  return command.replace(/\s+/g, " ").trim();
}

export function loadTriggerConfig(baseConfig, environment = process.env) {
  const allowedChatIds = parseList(environment.FEISHU_TRIGGER_CHAT_IDS);
  const allowedSenderIds = parseList(environment.FEISHU_TRIGGER_SENDER_IDS);

  if (allowedChatIds.length === 0 && baseConfig.feishuReceiveIdType === "chat_id") {
    allowedChatIds.push(baseConfig.feishuReceiveId);
  }
  if (allowedSenderIds.length === 0 && ["open_id", "user_id", "union_id"].includes(baseConfig.feishuReceiveIdType)) {
    allowedSenderIds.push(baseConfig.feishuReceiveId);
  }
  if (allowedChatIds.length === 0 && allowedSenderIds.length === 0) {
    throw new Error("必须配置 FEISHU_TRIGGER_CHAT_IDS 或 FEISHU_TRIGGER_SENDER_IDS");
  }

  return {
    allowedChatIds: new Set(allowedChatIds),
    allowedSenderIds: new Set(allowedSenderIds),
    commands: new Set(parseList(environment.FEISHU_TRIGGER_COMMANDS).length > 0
      ? parseList(environment.FEISHU_TRIGGER_COMMANDS)
      : DEFAULT_COMMANDS),
    allowBareMention: parseBoolean(
      environment.FEISHU_TRIGGER_ALLOW_BARE_MENTION || "true",
      "FEISHU_TRIGGER_ALLOW_BARE_MENTION",
    ),
    queueDirectory: resolve(
      environment.FEISHU_TRIGGER_QUEUE_DIR || join(process.cwd(), ".runtime", "feishu-trigger-queue"),
    ),
    maxAttempts: parsePositiveInteger(
      environment.FEISHU_TRIGGER_MAX_ATTEMPTS || "3",
      "FEISHU_TRIGGER_MAX_ATTEMPTS",
    ),
    retryDelayMs: parsePositiveInteger(
      environment.FEISHU_TRIGGER_RETRY_DELAY_MS || "15000",
      "FEISHU_TRIGGER_RETRY_DELAY_MS",
    ),
    cooldownMs: parsePositiveInteger(
      environment.FEISHU_TRIGGER_COOLDOWN_MS || "10000",
      "FEISHU_TRIGGER_COOLDOWN_MS",
    ),
    historyRetentionMs: parsePositiveInteger(
      environment.FEISHU_TRIGGER_HISTORY_RETENTION_MS || "604800000",
      "FEISHU_TRIGGER_HISTORY_RETENTION_MS",
    ),
    loginInteractionEnabled: parseBoolean(
      environment.FEISHU_LOGIN_INTERACTION_ENABLED || "true",
      "FEISHU_LOGIN_INTERACTION_ENABLED",
    ),
    loginBareCodeEnabled: parseBoolean(
      environment.FEISHU_LOGIN_BARE_CODE_ENABLED || "true",
      "FEISHU_LOGIN_BARE_CODE_ENABLED",
    ),
    loginSessionTtlMs: parsePositiveInteger(
      environment.FEISHU_LOGIN_SESSION_TTL_MS || "60000",
      "FEISHU_LOGIN_SESSION_TTL_MS",
    ),
  };
}

// 匹配二维码触发命令。支持「二维码」「重发二维码」等已配置命令，以及
// 「二维码 <手机号>」取指定账号的码（不改默认）。返回 {matched, phone}。
function matchQrCommand(command, triggerConfig) {
  for (const cmd of triggerConfig.commands) {
    if (command === cmd) return { matched: true, phone: null };
    if (command.startsWith(cmd)) {
      const m = command.slice(cmd.length).match(/^\s+(1\d{10})$/);
      if (m) return { matched: true, phone: m[1] };
    }
  }
  return { matched: false, phone: null };
}

export function parseTriggerEvent(data, triggerConfig) {
  const message = data?.message;
  const sender = data?.sender;

  if (!message?.message_id || !message.chat_id) return { accepted: false, reason: "missing_fields" };
  if (sender?.sender_type === "bot") return { accepted: false, reason: "bot_sender" };
  if (message.message_type !== "text") return { accepted: false, reason: "not_text" };

  const text = parseTextContent(message.content);
  if (text === null) return { accepted: false, reason: "invalid_content" };

  if (message.chat_type === "group" && (!Array.isArray(message.mentions) || message.mentions.length === 0)) {
    return { accepted: false, reason: "not_mentioned" };
  }

  const command = commandWithoutMentions(message, text);
  let accountPhone = null;
  let commandAccepted = false;
  if (command === "" && triggerConfig.allowBareMention) {
    commandAccepted = true;
  } else {
    const m = matchQrCommand(command, triggerConfig);
    if (m.matched) {
      commandAccepted = true;
      accountPhone = m.phone;
    }
  }
  if (!commandAccepted) return { accepted: false, reason: "unsupported_command" };

  const ids = senderIds(sender);
  const authorized = triggerConfig.allowedChatIds.has(message.chat_id)
    || ids.some((id) => triggerConfig.allowedSenderIds.has(id));
  if (!authorized) return { accepted: false, reason: "unauthorized" };

  return {
    accepted: true,
    job: {
      id: message.message_id,
      messageUuid: randomUUID(),
      chatId: message.chat_id,
      accountPhone: accountPhone ?? null,
      createdAt: new Date().toISOString(),
      attempts: 0,
    },
  };
}

function jobFileName(jobId) {
  return `${createHash("sha256").update(jobId).digest("hex")}.json`;
}

export async function prepareQueue(queueDirectory) {
  await mkdir(queueDirectory, { recursive: true, mode: 0o700 });
}

export async function cleanupQueueHistory(queueDirectory, retentionMs) {
  await prepareQueue(queueDirectory);
  const entries = await readdir(queueDirectory, { withFileTypes: true });
  const cutoff = Date.now() - retentionMs;

  await Promise.all(entries
    .filter((entry) => entry.isFile() && /\.(done|failed)\.json$/.test(entry.name))
    .map(async (entry) => {
      const path = join(queueDirectory, entry.name);
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
    }));
}

export async function enqueueJob(queueDirectory, job) {
  await prepareQueue(queueDirectory);
  const path = join(queueDirectory, jobFileName(job.id));
  const completedPath = path.replace(/\.json$/, ".done.json");
  const failedPath = path.replace(/\.json$/, ".failed.json");

  for (const existingPath of [completedPath, failedPath]) {
    try {
      await access(existingPath);
      return { enqueued: false, path: existingPath };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  try {
    await writeFile(path, `${JSON.stringify(job)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { enqueued: true, path };
  } catch (error) {
    if (error.code === "EEXIST") return { enqueued: false, path };
    throw error;
  }
}

export async function listPendingJobs(queueDirectory) {
  await prepareQueue(queueDirectory);
  const entries = await readdir(queueDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && PENDING_FILE_PATTERN.test(entry.name))
    .map((entry) => join(queueDirectory, entry.name))
    .sort();
}

export async function readJob(path) {
  const job = JSON.parse(await readFile(path, "utf8"));
  if (!job?.id || !job.chatId || !job.messageUuid || !Number.isInteger(job.attempts)) {
    throw new Error(`任务文件格式异常：${basename(path)}`);
  }
  return job;
}

export async function updateJob(path, job) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(job)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, path);
}

export async function completeJob(path) {
  await rename(path, path.replace(/\.json$/, ".done.json"));
}

export async function failJob(path) {
  await rename(path, path.replace(/\.json$/, ".failed.json"));
}

// 解析飞书内交互命令（登录/验证码/账号管理）。命中则返回 {matched:true, kind, ...}；
// 不命中返回 {matched:false} 放行给原 QR 触发路径 parseTriggerEvent。不读写队列、不走去重。
export function parseInteractionCommand(data, triggerConfig) {
  if (!triggerConfig?.loginInteractionEnabled) return { matched: false };

  const message = data?.message;
  const sender = data?.sender;

  if (!message?.message_id || !message.chat_id) return { matched: false };
  if (sender?.sender_type === "bot") return { matched: false };
  if (message.message_type !== "text") return { matched: false };

  // 群聊必须 @ 机器人（与 QR 触发一致，避免误触发与信息泄露）
  if (message.chat_type === "group" && (!Array.isArray(message.mentions) || message.mentions.length === 0)) {
    return { matched: false };
  }

  const text = parseTextContent(message.content);
  if (text === null) return { matched: false };

  const command = commandWithoutMentions(message, text);
  const chatId = message.chat_id;
  const ids = senderIds(sender);
  const base = { chatId, sender, message, senderIds: ids };

  let m;
  if ((m = command.match(/^登录\s*(1\d{10})$/))) {
    return { matched: true, kind: "login", phone: m[1], ...base };
  }
  if (command === "取消登录") {
    return { matched: true, kind: "cancel", ...base };
  }
  if ((m = command.match(/^验证码\s*(\d{6})$/))) {
    return { matched: true, kind: "verify", code: m[1], ...base };
  }
  if (command === "账号") {
    return { matched: true, kind: "list", ...base };
  }
  if (command === "帮助" || command === "功能" || command === "功能介绍") {
    return { matched: true, kind: "help", ...base };
  }
  if ((m = command.match(/^切换\s+(.+)$/))) {
    return { matched: true, kind: "switch", query: m[1].trim(), ...base };
  }
  if (triggerConfig.loginBareCodeEnabled && (m = command.match(/^(\d{6})$/))) {
    // 纯数字仅在「该 chat 有进行中会话」时才视为验证码，由 handler 判断；否则放行 QR 路径。
    return { matched: true, kind: "verify-bare", code: m[1], ...base };
  }

  return { matched: false };
}

export function isLoginAuthorized(interaction, triggerConfig) {
  const ids = interaction.senderIds || [];
  return triggerConfig.allowedChatIds.has(interaction.chatId)
    || ids.some((id) => triggerConfig.allowedSenderIds.has(id));
}
