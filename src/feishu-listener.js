import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as Lark from "@larksuiteoapi/node-sdk";

import {
  cleanupQueueHistory,
  completeJob,
  enqueueJob,
  failJob,
  listPendingJobs,
  loadTriggerConfig,
  parseTriggerEvent,
  readJob,
  updateJob,
} from "./feishu-trigger.js";
import { loadConfig, loadDotEnv, notifyFailure, runQrPipeline } from "./send-qr.js";

let draining = false;
let retryTimer = null;
let requestedDelay = null;
const lastAcceptedAtByChat = new Map();

function scheduleDrain(config, triggerConfig, delayMs = 0) {
  if (draining) {
    requestedDelay = requestedDelay === null ? delayMs : Math.min(requestedDelay, delayMs);
    return;
  }
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drainQueue(config, triggerConfig).catch((error) => {
      console.error(`[队列异常] ${error.message}`);
      scheduleDrain(config, triggerConfig, triggerConfig.retryDelayMs);
    });
  }, delayMs);
}

async function drainQueue(config, triggerConfig) {
  if (draining) return;
  draining = true;

  try {
    while (true) {
      const paths = await listPendingJobs(triggerConfig.queueDirectory);
      if (paths.length === 0) return;

      let shouldWaitBeforeRetry = false;
      for (const path of paths) {
        let job;
        try {
          job = await readJob(path);
        } catch (error) {
          console.error(`[任务损坏] ${error.message}`);
          await failJob(path);
          continue;
        }

        job.attempts += 1;
        job.lastAttemptAt = new Date().toISOString();
        await updateJob(path, job);

        try {
          await runQrPipeline(config, {
            receiveId: job.chatId,
            receiveIdType: "chat_id",
            messageUuid: job.messageUuid,
          });
          await completeJob(path);
          console.log(`[触发完成] message_id=${job.id}`);
        } catch (error) {
          console.error(`[触发失败] 第 ${job.attempts} 次：${error.message}`);
          if (job.attempts >= triggerConfig.maxAttempts) {
            await failJob(path);
            await notifyFailure(config, error, {
              receiveId: job.chatId,
              receiveIdType: "chat_id",
            });
          } else {
            shouldWaitBeforeRetry = true;
            break;
          }
        }
      }

      if (shouldWaitBeforeRetry) {
        scheduleDrain(config, triggerConfig, triggerConfig.retryDelayMs);
        return;
      }
    }
  } finally {
    draining = false;
    if (requestedDelay !== null) {
      const delayMs = requestedDelay;
      requestedDelay = null;
      scheduleDrain(config, triggerConfig, delayMs);
    }
  }
}

export async function handleMessageEvent(data, config, triggerConfig) {
  const result = parseTriggerEvent(data, triggerConfig);
  if (!result.accepted) {
    if (result.reason === "unauthorized") {
      console.warn(`[拒绝] 未授权的二维码触发请求，chat_id=${data?.message?.chat_id || "unknown"}`);
    }
    return;
  }

  const lastAcceptedAt = lastAcceptedAtByChat.get(result.job.chatId) || 0;
  if (Date.now() - lastAcceptedAt < triggerConfig.cooldownMs) {
    console.log(`[限流] 忽略短时间内的重复触发，chat_id=${result.job.chatId}`);
    return;
  }

  const queued = await enqueueJob(triggerConfig.queueDirectory, result.job);
  if (!queued.enqueued) {
    console.log(`[去重] 已处理二维码触发消息，message_id=${result.job.id}`);
    return;
  }

  lastAcceptedAtByChat.set(result.job.chatId, Date.now());
  console.log(`[已入队] 二维码触发消息，message_id=${result.job.id}`);
  scheduleDrain(config, triggerConfig);
}

async function main() {
  await loadDotEnv();
  const config = loadConfig();
  const triggerConfig = loadTriggerConfig(config);
  if (!/^cli_[0-9a-fA-F]{16}$/.test(config.feishuAppId)) {
    throw new Error("FEISHU_APP_ID 格式不正确");
  }

  if (process.argv.includes("--check-config")) {
    console.log("[成功] 飞书长连接触发配置有效");
    return;
  }

  await cleanupQueueHistory(triggerConfig.queueDirectory, triggerConfig.historyRetentionMs);
  scheduleDrain(config, triggerConfig);

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      await handleMessageEvent(data, config, triggerConfig);
    },
  });
  const wsClient = new Lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: Lark.LoggerLevel.info,
    autoReconnect: true,
    handshakeTimeoutMs: 15000,
    wsConfig: { pingTimeout: 10 },
    onReady: () => console.log("[已连接] 飞书长连接已就绪"),
    onReconnecting: () => console.warn("[重连] 飞书长连接已断开，正在重连"),
    onReconnected: () => console.log("[已恢复] 飞书长连接已重新建立"),
    onError: (error) => {
      console.error(`[连接失败] ${error.message}`);
      setTimeout(() => process.exit(1), 0);
    },
  });

  console.log("[启动] 正在连接飞书长连接");
  await wsClient.start({ eventDispatcher });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[致命错误] ${error.message}`);
    process.exitCode = 1;
  });
}
