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
  };
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
  const commandAccepted = (command === "" && triggerConfig.allowBareMention)
    || triggerConfig.commands.has(command);
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
