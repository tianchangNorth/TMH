import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getQrTitle } from "../src/lib.js";
import { runQrPipeline } from "../src/send-qr.js";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("runs the complete TML to Feishu image pipeline against local APIs", async (context) => {
  const calls = [];
  const expectedTitle = getQrTitle(new Date(), "123.45");
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    calls.push({ url: request.url, headers: request.headers, body });
    response.setHeader("content-type", "application/json");

    if (request.url === "/tml") {
      const payload = JSON.parse(body.toString("utf8"));
      assert.deepEqual(payload, {
        userId: "test-user",
        loginsession: "test-session",
        globalAreaId: 1,
        areaId: 1,
        parkId: 1,
      });
      assert.equal(request.headers.loginsession, "test-session");
      assert.equal(request.headers.cookie, "loginsession=test-session");
      response.end(JSON.stringify(JSON.stringify({ code: 200, data: "test-qr-payload" })));
      return;
    }

    if (request.url === "/balance") {
      const payload = JSON.parse(body.toString("utf8"));
      assert.deepEqual(payload, {
        staffId: "test-user",
        loginsession: "test-session",
        globalAreaId: 1,
        areaId: 1,
        parkId: 1,
      });
      assert.equal(request.headers.loginsession, "test-session");
      assert.equal(request.headers.cookie, "loginsession=test-session");
      response.end(JSON.stringify(JSON.stringify({ consumptionBalance: "123.45" })));
      return;
    }

    if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
      assert.deepEqual(JSON.parse(body.toString("utf8")), {
        app_id: "test-app-id",
        app_secret: "test-app-secret",
      });
      response.end(JSON.stringify({ code: 0, tenant_access_token: "test-token" }));
      return;
    }

    if (request.url === "/open-apis/im/v1/images") {
      assert.equal(request.headers.authorization, "Bearer test-token");
      assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
      assert.ok(body.includes(Buffer.from("image_type")));
      assert.ok(body.includes(Buffer.from("consume-qr.png")));
      assert.ok(body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
      response.end(JSON.stringify({ code: 0, data: { image_key: "test-image-key" } }));
      return;
    }

    if (request.url?.startsWith("/open-apis/im/v1/messages?")) {
      assert.equal(request.headers.authorization, "Bearer test-token");
      const payload = JSON.parse(body.toString("utf8"));
      assert.equal(payload.receive_id, "test-open-id");
      assert.equal(payload.msg_type, "post");
      assert.deepEqual(JSON.parse(payload.content), {
        zh_cn: {
          title: expectedTitle,
          content: [[{ tag: "img", image_key: "test-image-key" }]],
        },
      });
      assert.match(payload.uuid, /^[0-9a-f-]{36}$/);
      response.end(JSON.stringify({ code: 0, data: { message_id: "test-message" } }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ code: 404, msg: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/send-qr.js"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      TML_API_URL: `${baseUrl}/tml`,
      TML_BALANCE_API_URL: `${baseUrl}/balance`,
      TML_USER_ID: "test-user",
      TML_LOGIN_SESSION: "test-session",
      FEISHU_API_BASE: `${baseUrl}/open-apis`,
      FEISHU_APP_ID: "test-app-id",
      FEISHU_APP_SECRET: "test-app-secret",
      FEISHU_RECEIVE_ID: "test-open-id",
      FEISHU_RECEIVE_ID_TYPE: "open_id",
      FEISHU_FAILURE_NOTIFICATION: "false",
      KEEP_QR: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /通明湖付款码已发送到飞书/);
  assert.doesNotMatch(stdout, /123\.45/);
  assert.equal(calls.length, 5);
});

test("runQrPipeline with accountPhone uses that account and does not change default", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "tml-acct-"));
  context.after(() => rm(dir, { recursive: true, force: true }));

  const usersFile = join(dir, "users.json");
  await writeFile(usersFile, JSON.stringify({
    default: "13800000000",
    users: {
      "13800000000": {
        nickname: "13800000000",
        userId: "default-user",
        loginsession: "default-session",
        globalAreaId: 1, areaId: 1, parkId: 1,
      },
      "13900000000": {
        nickname: "13900000000",
        userId: "other-user",
        loginsession: "other-session",
        globalAreaId: 1, areaId: 1, parkId: 1,
      },
    },
  }));

  const seen = {};
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    response.setHeader("content-type", "application/json");
    if (request.url === "/tml") {
      seen.qr = JSON.parse(body.toString("utf8"));
      response.end(JSON.stringify(JSON.stringify({ code: 200, data: "qr-payload" })));
      return;
    }
    if (request.url === "/balance") {
      seen.balance = JSON.parse(body.toString("utf8"));
      response.end(JSON.stringify(JSON.stringify({ consumptionBalance: "50.0" })));
      return;
    }
    if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
      response.end(JSON.stringify({ code: 0, tenant_access_token: "tkn" }));
      return;
    }
    if (request.url === "/open-apis/im/v1/images") {
      response.end(JSON.stringify({ code: 0, data: { image_key: "img-key" } }));
      return;
    }
    if (request.url?.startsWith("/open-apis/im/v1/messages?")) {
      response.end(JSON.stringify({ code: 0, data: { message_id: "om-out" } }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const prevUsersFile = process.env.TML_USERS_FILE;
  process.env.TML_USERS_FILE = usersFile;
  try {
    const config = {
      tmlApiUrl: `${baseUrl}/tml`,
      tmlBalanceApiUrl: `${baseUrl}/balance`,
      tmlOrigin: baseUrl,
      tmlReferer: `${baseUrl}/front/miniWallet/`,
      tmlUserAgent: "ua",
      proxyUrl: null,
      timeoutMs: 20000,
      feishuAppId: "cli_0123456789abcdef",
      feishuAppSecret: "secret",
      feishuApiBase: `${baseUrl}/open-apis`,
      feishuReceiveId: "oc-chat-1",
      feishuReceiveIdType: "chat_id",
      failureNotification: false,
      keepQr: false,
      qrOutputPath: join(dir, "out.png"),
      sendLockPath: join(dir, "send.lock"),
      sendLockTimeoutMs: 75000,
      sendLockStaleMs: 180000,
      // 默认账号凭证（应被 accountPhone 覆盖）
      tmlUserId: "default-user",
      tmlLoginSession: "default-session",
      globalAreaId: 1, areaId: 1, parkId: 1,
    };

    await runQrPipeline(config, {
      receiveId: "oc-chat-1",
      receiveIdType: "chat_id",
      messageUuid: "11111111-2222-3333-4444-555555555555",
      accountPhone: "13900000000",
    });

    // TML 取码与余额接口都用的是指定账号的凭证，而非默认账号
    assert.equal(seen.qr.userId, "other-user");
    assert.equal(seen.qr.loginsession, "other-session");
    assert.equal(seen.balance.staffId, "other-user");
    assert.equal(seen.balance.loginsession, "other-session");

    // 默认账号未被改动
    const after = JSON.parse(await (await import("node:fs/promises")).readFile(usersFile, "utf8"));
    assert.equal(after.default, "13800000000");
  } finally {
    if (prevUsersFile === undefined) delete process.env.TML_USERS_FILE;
    else process.env.TML_USERS_FILE = prevUsersFile;
  }
});
