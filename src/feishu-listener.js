import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as Lark from "@larksuiteoapi/node-sdk";

import {
  cleanupQueueHistory,
  completeJob,
  enqueueJob,
  failJob,
  isLoginAuthorized,
  listPendingJobs,
  loadTriggerConfig,
  parseInteractionCommand,
  parseTriggerEvent,
  readJob,
  updateJob,
} from "./feishu-trigger.js";
import {
  getFeishuToken,
  loadAccountConfig,
  loadDotEnv,
  loadFeishuConfig,
  notifyFailure,
  runQrPipeline,
  sendFeishuMessage,
} from "./send-qr.js";
import { sendCode, smsLogin, extractCredentials, extractSmsId } from "./tml-auth.mjs";
import { loadStore, maskPhone, resolveUser, saveStore } from "./store.mjs";
import { LoginSessionStore } from "./login-sessions.mjs";

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
            accountPhone: job.accountPhone ?? null,
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

async function replyText(config, chatId, text) {
  const token = await getFeishuToken(config);
  await sendFeishuMessage(
    config,
    token,
    "text",
    { text },
    undefined,
    { receiveId: chatId, receiveIdType: "chat_id" },
  );
}

function buildHelpText(triggerConfig) {
  const qrCommands = triggerConfig.commands.size ? [...triggerConfig.commands].join(" / ") : "二维码";
  const lines = [
    "我是通明湖付款码机器人，支持以下命令：",
    "",
    "【付款码】",
    `  ${qrCommands} —— 获取付款码`,
    `  ${qrCommands} <手机号> —— 用指定账号取码（不改默认）`,
  ];
  if (triggerConfig.allowBareMention) lines.push("  @我（不带任何文字）—— 同上");
  lines.push(
    "",
    "【账号管理】",
    "  登录 <手机号> —— 发送验证码开始登录",
  );
  if (triggerConfig.loginBareCodeEnabled) {
    lines.push("  验证码 <6位> 或直接发 6 位数字 —— 提交验证码");
  } else {
    lines.push("  验证码 <6位> —— 提交验证码");
  }
  lines.push(
    "  取消登录 —— 取消进行中的登录",
    "  账号 —— 查看已登录账号",
    "  切换 <手机号|昵称> —— 切换默认账号",
    "  帮助 / 功能 —— 显示本说明",
    "",
    "群聊中请先 @ 我，再发命令。",
  );
  return lines.join("\n");
}

async function handleInteractionCommand(interaction, { config, triggerConfig, sessions }) {
  // 登录类命令仅允许授权发送者/群聊发起；未授权静默拒绝，不回复以防探测
  if (!isLoginAuthorized(interaction, triggerConfig)) {
    console.warn(`[拒绝] 未授权的登录操作，chat_id=${interaction.chatId}`);
    return;
  }

  const reply = (text) => replyText(config, interaction.chatId, text).catch((e) => {
    console.error(`[回复失败] ${e.message}`);
  });

  const gid = Number(config.globalAreaId || 1);
  const aid = Number(config.areaId || 1);
  const pid = Number(config.parkId || 1);

  switch (interaction.kind) {
    case "login": {
      try {
        const payload = await sendCode(interaction.phone, gid, aid, pid);
        const smsId = extractSmsId(payload);
        if (!smsId) {
          await reply("发送验证码失败：未收到 smsId，登录中止");
          return;
        }
        await sessions.start(interaction.chatId, {
          phone: interaction.phone,
          smsId,
          globalAreaId: gid,
          areaId: aid,
          parkId: pid,
          senderId: interaction.senderIds[0] ?? null,
        });
      } catch (e) {
        await reply(`发送验证码失败：${e.message}`);
        return;
      }
      const groupHint = interaction.message.chat_type === "group"
        ? "\n（提示：群内消息会被成员看到，如需保密请私聊机器人）"
        : "";
      await reply(
        `验证码已发送到 ${maskPhone(interaction.phone)}，请在 60 秒内回复：验证码 xxx\n（也可直接回复 6 位数字）${groupHint}`,
      );
      return;
    }

    case "verify":
    case "verify-bare": {
      const s = sessions.get(interaction.chatId);
      if (!s) {
        await reply("没有进行中的登录会话，请先发送：登录 <手机号>");
        return;
      }
      let payload;
      try {
        payload = await smsLogin(s.phone, interaction.code, s.smsId, s.globalAreaId, s.areaId, s.parkId);
      } catch (e) {
        await reply(`登录失败：${e.message}`);
        return;
      }
      const cred = extractCredentials(payload);
      if (!cred.userId || !cred.loginsession) {
        await reply("登录失败：响应未识别出凭证，请重新发起登录");
        await sessions.clear(interaction.chatId);
        return;
      }
      const store = await loadStore();
      store.users[s.phone] = {
        nickname: s.phone,
        userId: cred.userId,
        loginsession: cred.loginsession,
        globalAreaId: s.globalAreaId,
        areaId: s.areaId,
        parkId: s.parkId,
      };
      if (!store.default || !store.users[store.default]) store.default = s.phone;
      await saveStore(store);
      await sessions.clear(interaction.chatId);
      await reply(`登录成功，已设为默认账号：${maskPhone(s.phone)}`);
      return;
    }

    case "cancel": {
      await sessions.clear(interaction.chatId);
      await reply("已取消登录");
      return;
    }

    case "list": {
      const store = await loadStore();
      const lines = Object.entries(store.users).map(([phone, u]) => {
        const mark = store.default === phone ? "★" : " ";
        return `${mark} ${maskPhone(phone)}（${u.nickname}）`;
      });
      await reply(lines.length ? `已登录账号：\n${lines.join("\n")}` : "还没有登录的账号，请发送：登录 <手机号>");
      return;
    }

    case "help": {
      await reply(buildHelpText(triggerConfig));
      return;
    }

    case "switch": {
      const store = await loadStore();
      let user;
      try {
        user = resolveUser(store, interaction.query);
      } catch (e) {
        await reply(e.message);
        return;
      }
      store.default = user.phone;
      await saveStore(store);
      await reply(`默认账号已切换为：${maskPhone(user.phone)}（${user.nickname}）`);
      return;
    }

    default:
      return;
  }
}

export async function handleMessageEvent(data, config, triggerConfig, ctx = {}) {
  const sessions = ctx.sessions;

  if (triggerConfig.loginInteractionEnabled && sessions) {
    const interaction = parseInteractionCommand(data, triggerConfig);
    if (interaction.matched) {
      // 纯数字验证码：仅当该 chat 有进行中会话时才拦截；否则放行给 QR 路径，避免误判
      if (interaction.kind === "verify-bare" && !sessions.get(interaction.chatId)) {
        // fall through 到 QR 路径
      } else {
        await handleInteractionCommand(interaction, { config, triggerConfig, sessions })
          .catch((error) => console.error(`[交互异常] ${error.message}`));
        return;
      }
    }
  }

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
  const base = loadFeishuConfig();

  if (!/^cli_[0-9a-fA-F]{16}$/.test(base.feishuAppId)) {
    throw new Error("FEISHU_APP_ID 格式不正确");
  }

  if (process.argv.includes("--check-config")) {
    console.log("[成功] 飞书长连接触发配置有效");
    return;
  }

  const triggerConfig = loadTriggerConfig(base, process.env);

  // 账号凭证按 best-effort 加载：未登录时 listener 仍可启动，供用户经飞书「登录」补齐
  let acct = null;
  try {
    acct = await loadAccountConfig();
  } catch (error) {
    console.warn(`[警告] ${error.message}（可经飞书发送「登录 <手机号>」补齐凭证）`);
  }
  const config = { ...base, ...(acct ?? {}) };

  const sessions = new LoginSessionStore({ ttlMs: triggerConfig.loginSessionTtlMs });
  await sessions.load();
  await sessions.clearExpired();
  const sessionCleanup = setInterval(() => {
    void sessions.clearExpired().catch((error) => console.error(`[会话清理异常] ${error.message}`));
  }, 60_000);
  sessionCleanup.unref?.();

  await cleanupQueueHistory(triggerConfig.queueDirectory, triggerConfig.historyRetentionMs);
  scheduleDrain(config, triggerConfig);

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      await handleMessageEvent(data, config, triggerConfig, { sessions });
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
