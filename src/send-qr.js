import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import QRCode from "qrcode";
import { FormData, ProxyAgent, fetch } from "undici";

import {
  buildTmlBalanceRequestBody,
  buildTmlRequestBody,
  decodeTmlBalancePayload,
  decodeTmlPayload,
  formatHttpFailure,
  getQrTitle,
  parseBoolean,
  parsePositiveInteger,
  requireEnvironment,
  validateReceiveIdType,
} from "./lib.js";

const DEFAULT_TML_API_URL = "https://isp.tml-itcity.com/ipark-mobile/consume/getQRCodeEncrypt";
const DEFAULT_TML_BALANCE_API_URL = "https://isp.tml-itcity.com/portal/H5/pasc/member/queryBalance";
const DEFAULT_TML_ORIGIN = "https://isp.tml-itcity.com";
const DEFAULT_TML_REFERER = "https://isp.tml-itcity.com/front/miniWallet/";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 MiniProgramEnv/Mac";
const DEFAULT_FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

function parseDotEnvLine(line, lineNumber) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const separator = normalized.indexOf("=");
  if (separator < 1) {
    throw new Error(`.env 第 ${lineNumber} 行格式错误`);
  }

  const key = normalized.slice(0, separator).trim();
  let value = normalized.slice(separator + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`.env 第 ${lineNumber} 行变量名不合法`);
  }

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }

  return [key, value];
}

export async function loadDotEnv() {
  const envFile = resolve(process.env.ENV_FILE || join(process.cwd(), ".env"));
  let contents;

  try {
    contents = await readFile(envFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const fileStat = await stat(envFile);
  if ((fileStat.mode & 0o077) !== 0) {
    console.warn(`[警告] ${envFile} 权限过宽，建议执行 chmod 600`);
  }

  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const entry = parseDotEnvLine(line, index + 1);
    if (entry && process.env[entry[0]] === undefined) {
      process.env[entry[0]] = entry[1];
    }
  }
}

export function loadConfig() {
  requireEnvironment(process.env, [
    "TML_USER_ID",
    "TML_LOGIN_SESSION",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_RECEIVE_ID",
  ]);

  return {
    tmlApiUrl: process.env.TML_API_URL || DEFAULT_TML_API_URL,
    tmlBalanceApiUrl: process.env.TML_BALANCE_API_URL || DEFAULT_TML_BALANCE_API_URL,
    tmlOrigin: process.env.TML_ORIGIN || DEFAULT_TML_ORIGIN,
    tmlReferer: process.env.TML_REFERER || DEFAULT_TML_REFERER,
    tmlUserAgent: process.env.TML_USER_AGENT || DEFAULT_USER_AGENT,
    tmlUserId: process.env.TML_USER_ID,
    tmlLoginSession: process.env.TML_LOGIN_SESSION,
    globalAreaId: parsePositiveInteger(process.env.TML_GLOBAL_AREA_ID || "1", "TML_GLOBAL_AREA_ID"),
    areaId: parsePositiveInteger(process.env.TML_AREA_ID || "1", "TML_AREA_ID"),
    parkId: parsePositiveInteger(process.env.TML_PARK_ID || "1", "TML_PARK_ID"),
    proxyUrl: process.env.TML_HTTP_PROXY?.trim() || null,
    timeoutMs: parsePositiveInteger(process.env.REQUEST_TIMEOUT_MS || "20000", "REQUEST_TIMEOUT_MS"),
    feishuAppId: process.env.FEISHU_APP_ID,
    feishuAppSecret: process.env.FEISHU_APP_SECRET,
    feishuApiBase: process.env.FEISHU_API_BASE || DEFAULT_FEISHU_API_BASE,
    feishuReceiveId: process.env.FEISHU_RECEIVE_ID,
    feishuReceiveIdType: validateReceiveIdType(process.env.FEISHU_RECEIVE_ID_TYPE || "open_id"),
    failureNotification: parseBoolean(process.env.FEISHU_FAILURE_NOTIFICATION || "true", "FEISHU_FAILURE_NOTIFICATION"),
    keepQr: parseBoolean(process.env.KEEP_QR || "false", "KEEP_QR"),
    qrOutputPath: process.env.QR_OUTPUT_PATH || "consume-qr.png",
    sendLockPath: resolve(process.env.QR_SEND_LOCK_PATH || join(process.cwd(), ".runtime", "qr-send.lock")),
    sendLockTimeoutMs: parsePositiveInteger(process.env.QR_SEND_LOCK_TIMEOUT_MS || "75000", "QR_SEND_LOCK_TIMEOUT_MS"),
    sendLockStaleMs: parsePositiveInteger(process.env.QR_SEND_LOCK_STALE_MS || "180000", "QR_SEND_LOCK_STALE_MS"),
  };
}

async function fetchResponse(url, options, label, timeoutMs) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new Error(`${label}超时（${timeoutMs}ms）`);
    }
    throw new Error(`${label}网络请求失败`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(formatHttpFailure({
      label,
      status: response.status,
      responseText: text,
      logId: response.headers.get("x-tt-logid"),
    }));
  }
  return text;
}

function parseApiJson(rawText, label) {
  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(`${label}返回的不是有效 JSON`);
  }
}

function assertFeishuSuccess(payload, label) {
  if (!payload || payload.code !== 0) {
    const message = typeof payload?.msg === "string" ? payload.msg : "未知错误";
    throw new Error(`${label}失败：${message}`);
  }
  return payload;
}

async function fetchQrContent(config) {
  const dispatcher = config.proxyUrl ? new ProxyAgent(config.proxyUrl) : undefined;
  try {
    const rawText = await fetchResponse(config.tmlApiUrl, {
      method: "POST",
      dispatcher,
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json;charset=UTF-8",
        cookie: `loginsession=${config.tmlLoginSession}`,
        loginsession: config.tmlLoginSession,
        origin: config.tmlOrigin,
        referer: config.tmlReferer,
        "user-agent": config.tmlUserAgent,
      },
      body: JSON.stringify(buildTmlRequestBody(config)),
    }, "TML 二维码接口", config.timeoutMs);

    return decodeTmlPayload(rawText);
  } finally {
    await dispatcher?.close();
  }
}

async function fetchTotalBalance(config) {
  const dispatcher = config.proxyUrl ? new ProxyAgent(config.proxyUrl) : undefined;
  try {
    const rawText = await fetchResponse(config.tmlBalanceApiUrl, {
      method: "POST",
      dispatcher,
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json;charset=UTF-8",
        cookie: `loginsession=${config.tmlLoginSession}`,
        loginsession: config.tmlLoginSession,
        origin: config.tmlOrigin,
        referer: config.tmlReferer,
        "user-agent": config.tmlUserAgent,
      },
      body: JSON.stringify(buildTmlBalanceRequestBody(config)),
    }, "TML 余额接口", config.timeoutMs);

    return decodeTmlBalancePayload(rawText);
  } finally {
    await dispatcher?.close();
  }
}

async function getFeishuToken(config) {
  const rawText = await fetchResponse(`${config.feishuApiBase}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: config.feishuAppId,
      app_secret: config.feishuAppSecret,
    }),
  }, "获取飞书访问令牌", config.timeoutMs);

  const payload = assertFeishuSuccess(parseApiJson(rawText, "飞书令牌接口"), "获取飞书访问令牌");
  if (!payload.tenant_access_token) {
    throw new Error("飞书令牌接口未返回 tenant_access_token");
  }
  return payload.tenant_access_token;
}

async function uploadFeishuImage(config, token, imagePath) {
  const imageBytes = await readFile(imagePath);
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", new Blob([imageBytes], { type: "image/png" }), "consume-qr.png");

  const rawText = await fetchResponse(`${config.feishuApiBase}/im/v1/images`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  }, "上传飞书二维码", config.timeoutMs);

  const payload = assertFeishuSuccess(parseApiJson(rawText, "飞书图片接口"), "上传飞书二维码");
  if (!payload.data?.image_key) {
    throw new Error("飞书图片接口未返回 image_key");
  }
  return payload.data.image_key;
}

async function sendFeishuMessage(
  config,
  token,
  msgType,
  content,
  uuid = randomUUID(),
  destination = {},
) {
  const receiveId = destination.receiveId || config.feishuReceiveId;
  const receiveIdType = validateReceiveIdType(destination.receiveIdType || config.feishuReceiveIdType);
  const url = new URL(`${config.feishuApiBase}/im/v1/messages`);
  url.searchParams.set("receive_id_type", receiveIdType);

  const rawText = await fetchResponse(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: msgType,
      content: JSON.stringify(content),
      uuid,
    }),
  }, "发送飞书消息", config.timeoutMs);

  assertFeishuSuccess(parseApiJson(rawText, "飞书消息接口"), "发送飞书消息");
}

async function saveQrCopy(config, temporaryPath) {
  if (!config.keepQr) return;
  const destination = isAbsolute(config.qrOutputPath)
    ? config.qrOutputPath
    : resolve(process.cwd(), config.qrOutputPath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(temporaryPath, destination);
  const { chmod } = await import("node:fs/promises");
  await chmod(destination, 0o600);
  console.log(`[信息] 已保留二维码副本：${destination}`);
}

export async function notifyFailure(config, error, destination = {}) {
  if (!config?.failureNotification) return;
  try {
    const token = await getFeishuToken(config);
    const time = new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "Asia/Shanghai",
    }).format(new Date());
    await sendFeishuMessage(
      config,
      token,
      "text",
      { text: `消费二维码生成失败\n时间：${time}\n原因：${error.message}` },
      randomUUID(),
      destination,
    );
  } catch (notifyError) {
    console.error(`[失败通知未送达] ${notifyError.message}`);
  }
}

async function acquireSendLock(config) {
  await mkdir(dirname(config.sendLockPath), { recursive: true, mode: 0o700 });
  const ownerId = randomUUID();
  const ownerPath = join(config.sendLockPath, "owner");
  const deadline = Date.now() + config.sendLockTimeoutMs;
  let loggedWait = false;

  while (true) {
    try {
      await mkdir(config.sendLockPath, { mode: 0o700 });
      await writeFile(ownerPath, ownerId, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return async () => {
        try {
          if ((await readFile(ownerPath, "utf8")) === ownerId) {
            await rm(config.sendLockPath, { recursive: true, force: true });
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    try {
      const lockStat = await stat(config.sendLockPath);
      if (Date.now() - lockStat.mtimeMs > config.sendLockStaleMs) {
        console.warn("[警告] 清理超时的二维码发送锁");
        await rm(config.sendLockPath, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error(`等待其他二维码发送任务超时（${config.sendLockTimeoutMs}ms）`);
    }
    if (!loggedWait) {
      console.log("[等待] 另一项二维码发送任务正在运行");
      loggedWait = true;
    }
    await delay(250);
  }
}

export async function runQrPipeline(config, options = {}) {
  const destination = {
    receiveId: options.receiveId || config.feishuReceiveId,
    receiveIdType: options.receiveIdType || config.feishuReceiveIdType,
  };
  const releaseLock = await acquireSendLock(config);

  let temporaryDirectory;

  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "tml-qr-"));
    const temporaryQrPath = join(temporaryDirectory, "consume-qr.png");
    console.log("[开始] 获取通明湖付款码和当前余额");
    const [qrContent, totalBalance] = await Promise.all([
      fetchQrContent(config),
      fetchTotalBalance(config),
    ]);
    await QRCode.toFile(temporaryQrPath, qrContent, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 4,
      width: 600,
    });
    await saveQrCopy(config, temporaryQrPath);

    const token = await getFeishuToken(config);
    const imageKey = await uploadFeishuImage(config, token, temporaryQrPath);
    const title = getQrTitle(new Date(), totalBalance);
    await sendFeishuMessage(
      config,
      token,
      "post",
      {
        zh_cn: {
          title,
          content: [[{ tag: "img", image_key: imageKey }]],
        },
      },
      options.messageUuid || randomUUID(),
      destination,
    );
    console.log(`[成功] 通明湖付款码已发送到飞书（${destination.receiveIdType}）`);
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    await releaseLock();
  }
}

async function main() {
  await loadDotEnv();
  const config = loadConfig();

  if (process.argv.includes("--check-config")) {
    console.log(`[成功] 环境变量配置有效（接收人类型：${config.feishuReceiveIdType}）`);
    return;
  }

  try {
    await runQrPipeline(config);
  } catch (error) {
    console.error(`[失败] ${error.message}`);
    await notifyFailure(config, error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[致命错误] ${error.message}`);
    process.exitCode = 1;
  });
}
