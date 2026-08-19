import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";
import { loadStore, parseArgv, resolveUser } from "./tml-store.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT = resolve(SKILL_DIR, "output", "consume-qr.png");

const API = {
  qr: "https://isp.tml-itcity.com/ipark-mobile/consume/getQRCodeEncrypt",
  balance: "https://isp.tml-itcity.com/portal/H5/pasc/member/queryBalance",
  bookkeepingBalance: "https://isp.tml-itcity.com/ipark-mobile/bookkeepingRechargebalanceBalance/paginQuery",
  origin: "https://isp.tml-itcity.com",
  referer: "https://isp.tml-itcity.com/front/miniWallet/",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 MiniProgramEnv/Mac",
};

async function post(url, user, body, label) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json;charset=UTF-8",
        cookie: `loginsession=${user.loginsession}`,
        loginsession: user.loginsession,
        origin: API.origin,
        referer: API.referer,
        "user-agent": API.userAgent,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(`${label}网络请求失败：${e.name === "TimeoutError" ? "超时" : e.message}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
    if (typeof payload === "string") payload = JSON.parse(payload);
  } catch {
    throw new Error(`${label}返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}：${payload?.msg || payload?.message || "未知错误"}`);
  }
  if (payload?.code !== undefined && ![0, 200, "0", "200"].includes(payload.code)) {
    throw new Error(`${label}业务失败：${payload.msg || payload.message || payload.code}`);
  }
  return payload;
}

// queryBalance 的金额字段单位是分，需除以 100 换算成元
function yuanFromCents(value) {
  const raw = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  return (Number(raw) / 100).toFixed(2);
}

// consumptionBalance 已经是元，仅统一成两位小数
function yuanFromYuan(value) {
  const raw = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  return Number(raw).toFixed(2);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const store = await loadStore();
  const user = resolveUser(store, args.user);
  const gid = Number(user.globalAreaId || 1);
  const aid = Number(user.areaId || 1);
  const pid = Number(user.parkId || 1);

  const qrPayload = await post(API.qr, user, {
    userId: user.userId,
    loginsession: user.loginsession,
    globalAreaId: gid,
    areaId: aid,
    parkId: pid,
  }, "二维码接口");

  const qrContent = qrPayload?.data;
  if (typeof qrContent !== "string" || !qrContent) {
    throw new Error("二维码接口未返回可生成二维码的 data 字段");
  }

  let personalBalance = null;
  try {
    const balPayload = await post(API.balance, user, {
      loginsession: user.loginsession,
      globalAreaId: gid,
      areaId: aid,
      parkId: pid,
    }, "个人余额接口");
    personalBalance = yuanFromCents(balPayload?.body?.totalBalance);
  } catch {
    personalBalance = null;
  }

  let bookkeepingBalance = null;
  try {
    const bkPayload = await post(API.bookkeepingBalance, user, {
      staffId: user.userId,
      globalAreaId: gid,
      areaId: aid,
      parkId: pid,
      loginsession: user.loginsession,
    }, "记账余额接口");
    bookkeepingBalance = yuanFromYuan(bkPayload?.consumptionBalance);
  } catch {
    bookkeepingBalance = null;
  }

  const outPath = args.out || process.env.TML_QR_OUTPUT || DEFAULT_OUTPUT;
  await mkdir(dirname(outPath), { recursive: true });
  await QRCode.toFile(outPath, qrContent, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 4,
    width: 600,
  });
  await chmod(outPath, 0o600).catch(() => {});

  console.log(JSON.stringify({
    qrPath: outPath,
    phone: user.phone,
    nickname: user.nickname,
    personalBalance,
    bookkeepingBalance,
  }));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});