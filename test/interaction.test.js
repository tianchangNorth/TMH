import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isLoginAuthorized, loadTriggerConfig, parseInteractionCommand } from "../src/feishu-trigger.js";
import { handleMessageEvent } from "../src/feishu-listener.js";
import { API } from "../src/tml-auth.mjs";
import { LoginSessionStore } from "../src/login-sessions.mjs";

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function groupMessage(text, overrides = {}) {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou-authorized" } },
    message: {
      message_id: "om-msg-1",
      chat_id: "oc-chat-1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions: [{ key: "@_user_1", name: "QR Bot" }],
    },
    ...overrides,
  };
}

function p2pMessage(text, overrides = {}) {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou-authorized" } },
    message: {
      message_id: "om-msg-p2p",
      chat_id: "oc-p2p-1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
    ...overrides,
  };
}

function baseTriggerConfig(overrides = {}) {
  const cfg = loadTriggerConfig({
    feishuReceiveId: "ou-authorized",
    feishuReceiveIdType: "open_id",
  }, {});
  return { ...cfg, ...overrides };
}

test("parseInteractionCommand matches login/cancel/verify/list/switch", () => {
  const cfg = baseTriggerConfig();
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 登录 13800000000"), cfg).kind, "login");
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 取消登录"), cfg).kind, "cancel");
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 验证码 123456"), cfg).kind, "verify");
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 账号"), cfg).kind, "list");
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 切换 小王"), cfg).kind, "switch");
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 帮助"), cfg).kind, "help");
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 功能"), cfg).kind, "help");
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 功能介绍"), cfg).kind, "help");
});

test("parseInteractionCommand matches bare 6-digit as verify-bare", () => {
  const cfg = baseTriggerConfig();
  const r = parseInteractionCommand(groupMessage("@_user_1 123456"), cfg);
  assert.equal(r.matched, true);
  assert.equal(r.kind, "verify-bare");
});

test("parseInteractionCommand passes QR commands and unrelated text through to QR path", () => {
  const cfg = baseTriggerConfig();
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 二维码"), cfg).matched, false);
  assert.equal(parseInteractionCommand(groupMessage("@_user_1"), cfg).matched, false);
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 今天天气如何"), cfg).matched, false);
});

test("parseInteractionCommand ignores group messages without a mention and bot senders", () => {
  const cfg = baseTriggerConfig();
  const noMention = groupMessage("@_user_1 登录 13800000000");
  noMention.message.mentions = [];
  assert.equal(parseInteractionCommand(noMention, cfg).matched, false);
  const botSender = groupMessage("@_user_1 登录 13800000000");
  botSender.sender.sender_type = "bot";
  assert.equal(parseInteractionCommand(botSender, cfg).matched, false);
});

test("parseInteractionCommand respects loginInteractionEnabled=false", () => {
  const cfg = baseTriggerConfig({ loginInteractionEnabled: false });
  assert.equal(parseInteractionCommand(groupMessage("@_user_1 登录 13800000000"), cfg).matched, false);
});

test("isLoginAuthorized allows whitelisted sender and chat, rejects others", () => {
  const cfg = baseTriggerConfig();
  const good = parseInteractionCommand(groupMessage("@_user_1 账号"), cfg);
  assert.equal(isLoginAuthorized(good, cfg), true);
  const bad = parseInteractionCommand(groupMessage("@_user_1 账号", {
    sender: { sender_type: "user", sender_id: { open_id: "ou-other" } },
  }), cfg);
  assert.equal(isLoginAuthorized(bad, cfg), false);
});

test("end-to-end: login then verify writes users.json and replies, without touching the QR queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tml-interaction-"));
  const usersFile = join(dir, "users.json");
  const sessionsFile = join(dir, "login-sessions.json");
  const queueDir = join(dir, "queue");
  let feishuReplies = [];
  let smsLoginRequests = 0;

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    response.setHeader("content-type", "application/json");
    if (request.url === "/portal/open/send/sms") {
      response.end(JSON.stringify({ code: 0, data: { smsId: "sms-xyz" } }));
      return;
    }
    if (request.url === "/portal/open/smsLogin") {
      smsLoginRequests += 1;
      const payload = JSON.parse(body.toString("utf8"));
      assert.equal(payload.smsCode, "123456");
      assert.equal(payload.smsId, "sms-xyz");
      response.end(JSON.stringify(JSON.stringify({
        code: 0,
        data: { userInfo: { id: "u-100" }, loginsession: "sess-100" },
      })));
      return;
    }
    if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
      response.end(JSON.stringify({ code: 0, tenant_access_token: "tkn" }));
      return;
    }
    if (request.url?.startsWith("/open-apis/im/v1/messages")) {
      const payload = JSON.parse(body.toString("utf8"));
      feishuReplies.push(JSON.parse(payload.content).text);
      response.end(JSON.stringify({ code: 0, data: { message_id: "om-out" } }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const origSms = API.sendSms;
  const origLogin = API.smsLogin;
  API.sendSms = `${baseUrl}/portal/open/send/sms`;
  API.smsLogin = `${baseUrl}/portal/open/smsLogin`;

  process.env.TML_USERS_FILE = usersFile;
  process.env.TML_ENV_FILE = join(dir, ".env");

  try {
    const triggerConfig = baseTriggerConfig({ queueDirectory: queueDir });
    const config = {
      feishuAppId: "cli_0123456789abcdef",
      feishuAppSecret: "secret",
      feishuApiBase: `${baseUrl}/open-apis`,
      feishuReceiveId: "ou-authorized",
      feishuReceiveIdType: "open_id",
      globalAreaId: 1,
      areaId: 1,
      parkId: 1,
      timeoutMs: 20000,
    };
    const sessions = new LoginSessionStore({ filePath: sessionsFile, ttlMs: 60_000 });

    // 登录
    await handleMessageEvent(groupMessage("@_user_1 登录 13800000000"), config, triggerConfig, { sessions });
    assert.ok(sessions.get("oc-chat-1"), "登录后应建立会话");
    assert.ok(feishuReplies.some((t) => t.includes("138****0000")), "回复应含脱敏手机号");

    // 验证码
    await handleMessageEvent(groupMessage("@_user_1 验证码 123456"), config, triggerConfig, { sessions });
    assert.equal(sessions.get("oc-chat-1"), null, "登录成功后应清理会话");
    assert.ok(feishuReplies.some((t) => t.includes("登录成功")), "应回复登录成功");
    assert.equal(smsLoginRequests, 1);

    // users.json 已写入
    const raw = JSON.parse(await readFile(usersFile));
    assert.equal(raw.default, "13800000000");
    assert.equal(raw.users["13800000000"].userId, "u-100");
    assert.equal(raw.users["13800000000"].loginsession, "sess-100");

    // 登录消息不应产生任何队列文件
    const files = await readdir(queueDir).catch(() => []);
    assert.equal(files.length, 0, "登录交互不应触碰 QR 队列");
  } finally {
    API.sendSms = origSms;
    API.smsLogin = origLogin;
    delete process.env.TML_USERS_FILE;
    delete process.env.TML_ENV_FILE;
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("help command replies with the command list and does not touch the QR queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tml-help-"));
  const queueDir = join(dir, "queue");
  let feishuReplies = [];

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    response.setHeader("content-type", "application/json");
    if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
      response.end(JSON.stringify({ code: 0, tenant_access_token: "tkn" }));
      return;
    }
    if (request.url?.startsWith("/open-apis/im/v1/messages")) {
      const payload = JSON.parse(body.toString("utf8"));
      feishuReplies.push(JSON.parse(payload.content).text);
      response.end(JSON.stringify({ code: 0, data: { message_id: "om-out" } }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const triggerConfig = baseTriggerConfig({ queueDirectory: queueDir });
    const config = {
      feishuAppId: "cli_0123456789abcdef",
      feishuAppSecret: "secret",
      feishuApiBase: `${baseUrl}/open-apis`,
      feishuReceiveId: "ou-authorized",
      feishuReceiveIdType: "open_id",
      timeoutMs: 20000,
    };
    const sessions = new LoginSessionStore({ ttlMs: 60_000 });

    await handleMessageEvent(groupMessage("@_user_1 帮助"), config, triggerConfig, { sessions });
    assert.equal(feishuReplies.length, 1, "应回复一条帮助文本");
    const text = feishuReplies[0];
    assert.ok(text.includes("登录"), "帮助应包含「登录」");
    assert.ok(text.includes("账号"), "帮助应包含「账号」");
    assert.ok(text.includes("二维码"), "帮助应包含「二维码」");
    assert.ok(text.includes("帮助"), "帮助应包含「帮助」自身");
    const files = await readdir(queueDir).catch(() => []);
    assert.equal(files.length, 0, "帮助命令不应入 QR 队列");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify-bare without an in-flight session falls through (no reply, no queue)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tml-bare-"));
  const sessionsFile = join(dir, "login-sessions.json");
  const queueDir = join(dir, "queue");
  let feishuReplies = [];

  const server = createServer(async (request, response) => {
    await readBody(request);
    response.setHeader("content-type", "application/json");
    if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
      response.end(JSON.stringify({ code: 0, tenant_access_token: "tkn" }));
      return;
    }
    if (request.url?.startsWith("/open-apis/im/v1/messages")) {
      const body = await readBody(request);
      const payload = JSON.parse(body.toString("utf8"));
      feishuReplies.push(JSON.parse(payload.content).text);
      response.end(JSON.stringify({ code: 0 }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const triggerConfig = baseTriggerConfig({ queueDirectory: queueDir });
    const config = {
      feishuAppId: "cli_0123456789abcdef",
      feishuAppSecret: "secret",
      feishuApiBase: `${baseUrl}/open-apis`,
      feishuReceiveId: "ou-authorized",
      feishuReceiveIdType: "open_id",
      timeoutMs: 20000,
    };
    const sessions = new LoginSessionStore({ filePath: sessionsFile, ttlMs: 60_000 });

    await handleMessageEvent(groupMessage("@_user_1 123456"), config, triggerConfig, { sessions });
    assert.equal(feishuReplies.length, 0, "无会话时纯数字应放行，不回复");
    const files = await readdir(queueDir).catch(() => []);
    assert.equal(files.length, 0, "纯数字不应入 QR 队列");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function readFile(path) {
  const { readFile: r } = await import("node:fs/promises");
  return r(path, "utf8");
}
