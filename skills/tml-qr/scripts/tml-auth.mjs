import { loadStore, parseArgv, saveStore } from "./tml-store.mjs";

const API = {
  sendSms: "https://isp.tml-itcity.com/portal/open/send/sms",
  smsLogin: "https://isp.tml-itcity.com/portal/open/smsLogin",
};

const SMS_HEADERS = {
  "content-type": "application/json;charset=utf-8",
  "deviceType": "iphone",
  "version": "1.0.70",
  "accept": "*/*",
  "accept-language": "zh-CN,zh-Hans;q=0.9",
  "user-agent": "%E9%80%9A%E6%98%8E%E6%B9%96%E4%BF%A1%E6%81%AF%E5%9F%8E/1 CFNetwork/3860.700.1 Darwin/25.6.0",
};

async function postJson(url, body, label) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: SMS_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(`${label}网络请求失败：${e.name === "TimeoutError" ? "超时" : e.message}`);
  }
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
    if (typeof payload === "string") payload = JSON.parse(payload);
  } catch {
    payload = null;
  }
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}：${payload?.message || payload?.msg || text}`);
  }
  return payload;
}

async function sendCode(phone, gid, aid, pid) {
  return postJson(API.sendSms, {
    phone,
    globalAreaId: String(gid),
    areaId: String(aid),
    parkId: String(pid),
    smsType: 8,
  }, "发送验证码");
}

async function smsLogin(phone, code, smsId, gid, aid, pid) {
  return postJson(API.smsLogin, {
    parkId: String(pid),
    areaId: String(aid),
    smsCode: code,
    globalAreaId: String(gid),
    customId: phone,
    smsType: 8,
    smsId,
  }, "登录");
}

function extractCredentials(payload) {
  const data = payload?.data ?? payload?.body ?? payload?.result ?? payload;
  if (!data || typeof data !== "object") return {};
  const userId = data.userInfo?.id ?? data.userId ?? data.userid ?? data.staffId ?? data.memberId;
  const loginsession = data.loginsession ?? data.loginSession ?? data.session ?? data.loginsessionId;
  return { userId, loginsession };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgv(rest);
  const gid = args.globalAreaId || "1";
  const aid = args.areaId || "1";
  const pid = args.parkId || "1";

  if (cmd === "send-code") {
    if (!args.phone) throw new Error("send-code 需要 --phone");
    const payload = await sendCode(args.phone, gid, aid, pid);
    console.log(JSON.stringify({ sent: true, response: payload }));
    return;
  }

  if (cmd === "login") {
    if (!args.phone || !args.code || !args.smsId) throw new Error("login 需要 --phone --code --smsId");
    const payload = await smsLogin(args.phone, args.code, args.smsId, gid, aid, pid);
    const cred = extractCredentials(payload);
    if (!cred.userId || !cred.loginsession) {
      console.log(JSON.stringify({ rawResponse: payload }));
      throw new Error("登录响应未识别出 userId/loginsession，见上方原始响应");
    }
    const store = await loadStore();
    const nickname = args.nickname || args.phone;
    store.users[args.phone] = {
      nickname,
      userId: cred.userId,
      loginsession: cred.loginsession,
      globalAreaId: Number(gid),
      areaId: Number(aid),
      parkId: Number(pid),
    };
    if (!store.default || !store.users[store.default]) store.default = args.phone;
    await saveStore(store);
    console.log(JSON.stringify({ loggedIn: true, phone: args.phone, nickname }));
    return;
  }

  throw new Error(
    `未知命令「${cmd}」。用法：\n  node tml-auth.mjs send-code --phone <手机号>\n  node tml-auth.mjs login --phone <手机号> --code <验证码> --smsId <id>`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});